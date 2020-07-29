package io.hyperfoil.tools.horreum.api;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

import javax.annotation.PostConstruct;
import javax.enterprise.context.ApplicationScoped;
import javax.inject.Inject;
import javax.persistence.EntityManager;
import javax.persistence.Query;
import javax.sql.DataSource;
import javax.transaction.Transactional;

import org.apache.commons.math3.stat.descriptive.SummaryStatistics;
import org.apache.commons.math3.stat.inference.TTest;
import org.graalvm.polyglot.Context;
import org.graalvm.polyglot.Value;
import org.jboss.logging.Logger;

import io.hyperfoil.tools.horreum.entity.alerting.Change;
import io.hyperfoil.tools.horreum.entity.alerting.Criterion;
import io.hyperfoil.tools.horreum.entity.alerting.DataPoint;
import io.hyperfoil.tools.horreum.entity.alerting.Variable;
import io.hyperfoil.tools.horreum.entity.json.Run;
import io.hyperfoil.tools.horreum.entity.json.SchemaExtractor;
import io.hyperfoil.tools.yaup.json.Json;
import io.quarkus.panache.common.Sort;
import io.quarkus.vertx.ConsumeEvent;
import io.vertx.core.eventbus.EventBus;

@ApplicationScoped
public class AlertingService {
   private static final Logger log = Logger.getLogger(AlertingService.class);

   //@formatter:off
   private static final String LOOKUP_VARS =
         "WITH vars AS (" +
         "   SELECT id, calculation, unnest(regexp_split_to_array(accessors, ';')) as accessor FROM variable" +
         ") SELECT vars.id as vid, vars.calculation, vars.accessor, se.jsonpath, schema.uri  FROM vars " +
         "JOIN schemaextractor se ON se.accessor = replace(vars.accessor, '[]', '') " +
         "JOIN schema ON schema.id = se.schema_id WHERE schema.uri = ANY(?);";
   //@formatter:on
   private static final String UPLOAD_RUN = "CREATE TEMPORARY TABLE current_run AS SELECT * FROM (VALUES (?::jsonb)) as t(data);";
   static final String HORREUM_ALERTING = "horreum.alerting";
   private static final Sort SORT_BY_ID_DESCENDING = Sort.by("id", Sort.Direction.Descending);

   @Inject
   SqlService sqlService;

   @Inject
   EntityManager em;

   @Inject
   DataSource dataSource;

   @Inject
   EventBus eventBus;

   @PostConstruct
   public void init() {
      log.info("Initialized AlertingService");
   }

   @Transactional
   @ConsumeEvent(value = Run.EVENT_NEW, blocking = true)
   public void onNewRun(Run run) {
      log.infof("Received new run ID %d", run.id);
      String firstLevelSchema = run.data.getString("$schema");
      List<String> secondLevelSchemas = run.data.values().stream()
            .filter(Json.class::isInstance).map(Json.class::cast)
            .map(json -> json.getString("$schema")).filter(Objects::nonNull)
            .collect(Collectors.toList());
      List<String> schemas = new ArrayList<>(secondLevelSchemas);
      if (firstLevelSchema != null) {
         schemas.add(firstLevelSchema);
      }

      // TODO: we don't know the test owner, so we cannot impersonate it
      // In order to create datapoints we'll use the horreum.alerting ownership
      List<String> roles = Arrays.asList(run.owner, HORREUM_ALERTING);

      // TODO: We will have the JSONPaths in PostgreSQL format while the Run
      // itself is available here in the application.
      // We'll use the database as a library function
      StringBuilder extractionQuery = new StringBuilder("SELECT 1");
      Map<Integer, VarInfo> vars = new HashMap<>();
      try (Connection connection = dataSource.getConnection();
           CloseMeJdbc closeMe = sqlService.withRoles(connection, roles)) {

         try (PreparedStatement setRun = connection.prepareStatement(UPLOAD_RUN)) {
            setRun.setString(1, run.data.toString());
            setRun.execute();
         } finally {

            try (PreparedStatement lookup = connection.prepareStatement(LOOKUP_VARS)) {
               lookup.setArray(1, connection.createArrayOf("text", schemas.toArray()));
               ResultSet resultSet = lookup.executeQuery();
               Set<String> usedAccessors = new HashSet<>();

               while (resultSet.next()) {
                  int id = resultSet.getInt(1);
                  String calc = resultSet.getString(2);
                  String accessor = resultSet.getString(3);
                  String jsonpath = resultSet.getString(4);
                  String schema = resultSet.getString(5);
                  if (SchemaExtractor.isArray(accessor)) {
                     extractionQuery.append(", jsonb_path_query_array(data, '");
                     accessor = SchemaExtractor.arrayName(accessor);
                  } else {
                     extractionQuery.append(", jsonb_path_query_first(data, '");
                  }
                  while (!usedAccessors.add(accessor)) {
                     log.warnf("Accessor %s used for multiple schemas", accessor);
                     accessor = accessor + "_";
                  }
                  if (schema.equals(firstLevelSchema)) {
                     extractionQuery.append("$");
                  } else {
                     extractionQuery.append("$.*");
                  }
                  extractionQuery.append(jsonpath).append("'::jsonpath)#>>'{}' as ").append(accessor);
                  VarInfo var = vars.computeIfAbsent(id, i -> new VarInfo(i, calc));
                  var.accessors.add(accessor);
               }
               resultSet.close();
            }
            extractionQuery.append(" FROM current_run");

            List<DataPoint> newDataPoints = new ArrayList<>();
            try (PreparedStatement extraction = connection.prepareStatement(extractionQuery.toString())) {
               ResultSet resultSet = extraction.executeQuery();
               if (!resultSet.next()) {
                  log.errorf("Run %d does not exist in the database!", run.id);
                  return;
               }
               for (VarInfo var : vars.values()) {
                  DataPoint dataPoint = new DataPoint();
                  // TODO: faking the variable
                  Variable variable = new Variable();
                  variable.id = var.id;
                  dataPoint.variable = variable;
                  dataPoint.runId = run.id;
                  if (var.calculation == null || var.calculation.isEmpty()) {
                     if (var.accessors.size() > 1) {
                        log.errorf("Variable %d has more than one accessor (%s) but no calculation function.", var.id, var.accessors);
                     }
                     String value = resultSet.getString(var.accessors.get(0));
                     try {
                        dataPoint.value = Double.parseDouble(value);
                     } catch (NumberFormatException e) {
                        log.errorf(e, "Cannot turn %s into a floating-point value", value);
                        continue;
                     }
                  } else {
                     StringBuilder code = new StringBuilder();
                     code.append("const __obj = {\n");
                     for (String accessor : var.accessors) {
                        code.append(accessor).append(": ").append(resultSet.getString(accessor)).append(",\n");
                     }
                     code.append("};\n");
                     code.append("const __func = ").append(var.calculation).append(";\n");
                     code.append("return __func(__obj);");
                     Double value = execute(code.toString());
                     if (value == null) {
                        continue;
                     }
                     dataPoint.value = value;
                  }
                  newDataPoints.add(dataPoint);
               }
            } finally {
               try (PreparedStatement dropRun = connection.prepareStatement("DROP TABLE current_run")) {
                  dropRun.execute();
               }
            }

            // TODO: maybe do this through entity manager?
            for (DataPoint dataPoint : newDataPoints) {
               try (PreparedStatement insert = connection.prepareStatement("INSERT INTO datapoint (variable_id, runid, value) VALUES (?, ?, ?);")) {
                  insert.setInt(1, dataPoint.variable.id);
                  insert.setInt(2, dataPoint.runId);
                  insert.setDouble(3, dataPoint.value);
                  insert.execute();
               }
               eventBus.publish(DataPoint.EVENT_NEW, dataPoint);
            }
         }
      } catch (SQLException e) {
         log.error("SQL commands failed", e);
      }
   }

   private Double execute(String jsCode) {
      try (Context context = Context.newBuilder(new String[]{ "js"}).build()) {
         context.enter();
         try {
            Value value = context.eval("js", jsCode);
            if (value.isNumber()) {
               return value.asDouble();
            } else {
               log.errorf("Return value %s is not a floating-point number.", value);
               return null;
            }
         } finally {
            context.leave();
         }
      }
   }

   @Transactional
   @ConsumeEvent(value = Run.EVENT_TRASHED, blocking = true)
   public void onRunTrashed(Integer runId) {
      log.infof("Trashing datapoints for run %d", runId);
      try (CloseMe closeMe = sqlService.withRoles(em, Collections.singletonList(HORREUM_ALERTING))) {
         Query deleteChanges = em.createNativeQuery("DELETE FROM change WHERE datapoint_id IN (SELECT id FROM datapoint WHERE runid = ?)");
         deleteChanges.setParameter(1, runId).executeUpdate();
         DataPoint.delete("runid", runId);
      }
   }

   @Transactional
   @ConsumeEvent(value = DataPoint.EVENT_NEW, blocking = true)
   public void onNewDataPoint(DataPoint dataPoint) {
      log.infof("Processing new datapoint for run %d, variable %d", dataPoint.runId, dataPoint.variable.id);
      try (CloseMe closeMe = sqlService.withRoles(em, Collections.singletonList(HORREUM_ALERTING))) {
         List<Criterion> criteria = Criterion.list("variable_id", dataPoint.variable.id);
         for (Criterion criterion : criteria) {
            Change lastChange = Change.find("criterion = ?1", SORT_BY_ID_DESCENDING, criterion).range(0, 0).firstResult();
            List<DataPoint> dataPoints;
            if (lastChange == null) {
               dataPoints = DataPoint.find("variable", SORT_BY_ID_DESCENDING, criterion.variable).range(0, criterion.maxWindow).list();
            } else {
               dataPoints = DataPoint.find("variable = ?1 AND id >= ?2", SORT_BY_ID_DESCENDING, criterion.variable, lastChange.dataPoint.id)
                     .range(0, criterion.maxWindow).list();
            }
            // Last datapoint is already in the list
            assert !dataPoints.isEmpty();
            assert Math.abs(dataPoints.get(0).value - dataPoint.value) < 0.000001;
            // From 1 result we cannot estimate stddev either, so it's not useful
            if (dataPoints.size() <= 2) {
               log.infof("Criterion %d has too few data (%d datapoints), skipping analysis", criterion.id, dataPoints.size());
               continue;
            }
            SummaryStatistics statistics = new SummaryStatistics();
            dataPoints.stream().skip(1).mapToDouble(dp -> dp.value).forEach(statistics::addValue);
            double diff = Math.abs(statistics.getMean() - dataPoint.value);
            if (diff > statistics.getStandardDeviation() * criterion.deviationFactor) {
               log.infof("Value %f exceeds %f +- %f x %f", dataPoint.value, statistics.getMean(), statistics.getStandardDeviation(), criterion.deviationFactor);
               Change change = new Change();
               change.dataPoint = dataPoints.get(0);
               change.criterion = criterion;
               change.description = "Last datapoint is out of deviation range";
               em.persist(change);
               eventBus.publish(Change.EVENT_NEW, change);
            } else {
               double lowestPValue = 1.0;
               int changeIndex = -1;
               // we want at least 2 values in each population
               for (int i = 2; i <= dataPoints.size() - 2; ++i) {
                  double[] populationA = dataPoints.stream().limit(i).mapToDouble(dp -> dp.value).toArray();
                  double[] populationB = dataPoints.stream().skip(i).mapToDouble(dp -> dp.value).toArray();
                  final double pValue = new TTest().tTest(populationA, populationB);
                  if (pValue < lowestPValue && pValue < 1 - criterion.confidence) {
                     changeIndex = i;
                     lowestPValue = pValue;
                  }
               }
               if (changeIndex >= 0) {
                  Change change = new Change();
                  change.dataPoint = dataPoints.get(changeIndex - 1);
                  change.criterion = criterion;
                  change.description = String.format("Change detected with confidence %.3f%%", (1 - lowestPValue) * 100);
                  log.infof("T-test found likelihood of %f%% that there's a change at datapoint %d", lowestPValue * 100, change.dataPoint.id);
                  em.persist(change);
                  eventBus.publish(Change.EVENT_NEW, change);
               }
            }
         }
      }
   }

   private static class VarInfo {
      final int id;
      final String calculation;
      final List<String> accessors = new ArrayList<>();

      private VarInfo(int id, String calculation) {
         this.id = id;
         this.calculation = calculation;
      }
   }
}