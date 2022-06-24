import * as actionTypes from "./actionTypes"
import {
    LoadingAction,
    LoadedSummaryAction,
    LoadedTestAction,
    UpdateAccessAction,
    DeleteAction,
    UpdateTestWatchAction,
    UpdateViewAction,
    DeleteViewAction,
    UpdateHookAction,
    UpdateTokensAction,
    RevokeTokenAction,
    UpdateFingerprintAction,
    UpdateFoldersAction,
    UpdateFolderAction,
    UpdateTransformersAction,
    UpdateRunsAndDatasetsAction,
} from "./reducers"
import Api, { Access, Hook, Test, Transformer, View, Watch } from "../../api"
import { Dispatch } from "redux"
import { Map } from "immutable"
import { alertAction, AddAlertAction, constraintValidationFormatter, dispatchError } from "../../alerts"

function loading(isLoading: boolean): LoadingAction {
    return { type: actionTypes.LOADING, isLoading }
}

export function fetchSummary(roles?: string, folder?: string) {
    return (dispatch: Dispatch<LoadingAction | LoadedSummaryAction | AddAlertAction>) => {
        dispatch(loading(true))
        return Api.testServiceSummary(folder, roles).then(
            listing => dispatch({ type: actionTypes.LOADED_SUMMARY, tests: listing.tests?.map(t => t as Test) || [] }),
            error => {
                dispatch(loading(false))
                return dispatchError(dispatch, error, "FETCH_TEST_SUMMARY", "Failed to fetch test summary.")
            }
        )
    }
}

export function fetchTest(id: number) {
    return (dispatch: Dispatch<LoadingAction | LoadedTestAction | AddAlertAction>) => {
        dispatch(loading(true))
        return Api.testServiceGet(id).then(
            test => dispatch({ type: actionTypes.LOADED_TEST, test }),
            error => {
                dispatch(loading(false))
                return dispatchError(
                    dispatch,
                    error,
                    "FETCH_TEST",
                    "Failed to fetch test; the test may not exist or you don't have sufficient permissions to access it."
                )
            }
        )
    }
}

export function sendTest(test: Test) {
    return (dispatch: Dispatch<LoadedTestAction | AddAlertAction>) => {
        return Api.testServiceAdd(test).then(
            response => {
                dispatch({ type: actionTypes.LOADED_TEST, test: response })
                return response
            },
            error =>
                dispatchError(
                    dispatch,
                    error,
                    "UPDATE_TEST",
                    "Failed to create/update test " + test.name,
                    constraintValidationFormatter("the saved test")
                )
        )
    }
}

export function updateView(testId: number, view: View) {
    return (dispatch: Dispatch<UpdateViewAction | AddAlertAction>) => {
        for (const c of view.components) {
            if (c.labels.length === 0) {
                dispatch(
                    alertAction(
                        "VIEW_UPDATE",
                        "Column " + c.headerName + " is invalid; must set at least one label.",
                        undefined
                    )
                )
                return Promise.reject()
            }
        }
        return Api.testServiceUpdateView(testId, view).then(
            viewId => {
                dispatch({
                    type: actionTypes.UPDATE_VIEW,
                    testId,
                    view: {
                        ...view,
                        id: viewId,
                    },
                })
                return viewId
            },
            error => dispatchError(dispatch, error, "VIEW_UPDATE", "View update failed.")
        )
    }
}

export function deleteView(testId: number, viewId: number) {
    return (dispatch: Dispatch<DeleteViewAction | AddAlertAction>) => {
        return Api.testServiceDeleteView(testId, viewId).then(
            _ => {
                dispatch({
                    type: actionTypes.DELETE_VIEW,
                    testId,
                    viewId,
                })
                return viewId
            },
            error => dispatchError(dispatch, error, "VIEW_DELETE", "View update failed.")
        )
    }
}

export function updateFolder(testId: number, prevFolder: string, newFolder: string) {
    return (dispatch: Dispatch<UpdateFolderAction | AddAlertAction>) =>
        Api.testServiceUpdateFolder(testId, newFolder).then(
            _ =>
                dispatch({
                    type: actionTypes.UPDATE_FOLDER,
                    testId,
                    prevFolder,
                    newFolder,
                }),
            error => dispatchError(dispatch, error, "TEST_FOLDER_UPDATE", "Cannot update test folder")
        )
}

export function updateHooks(testId: number, testWebHooks: Hook[]) {
    return (dispatch: Dispatch<UpdateHookAction | AddAlertAction>) => {
        const promises: any[] = []
        testWebHooks.forEach(hook => {
            promises.push(
                Api.testServiceUpdateHook(testId, hook).then(
                    response => {
                        dispatch({
                            type: actionTypes.UPDATE_HOOK,
                            testId,
                            hook,
                        })
                        return response
                    },
                    error =>
                        dispatchError(dispatch, error, "UPDATE_HOOK", `Failed to update hook ${hook.id} (${hook.url}`)
                )
            )
        })
        return Promise.all(promises)
    }
}

export function addToken(testId: number, value: string, description: string, permissions: number) {
    return (dispatch: Dispatch<UpdateTokensAction | AddAlertAction>) =>
        Api.testServiceAddToken(testId, { id: -1, value, description, permissions }).then(
            () =>
                Api.testServiceTokens(testId).then(
                    tokens =>
                        dispatch({
                            type: actionTypes.UPDATE_TOKENS,
                            testId,
                            tokens,
                        }),
                    error =>
                        dispatchError(dispatch, error, "FETCH_TOKENS", "Failed to fetch token list for test " + testId)
                ),
            error => dispatchError(dispatch, error, "ADD_TOKEN", "Failed to add token for test " + testId)
        )
}

export function revokeToken(testId: number, tokenId: number) {
    return (dispatch: Dispatch<RevokeTokenAction | AddAlertAction>) =>
        Api.testServiceDropToken(testId, tokenId).then(
            () =>
                dispatch({
                    type: actionTypes.REVOKE_TOKEN,
                    testId,
                    tokenId,
                }),
            error => dispatchError(dispatch, error, "REVOKE_TOKEN", "Failed to revoke token")
        )
}

export function updateAccess(id: number, owner: string, access: Access) {
    return (dispatch: Dispatch<UpdateAccessAction | AddAlertAction>) =>
        Api.testServiceUpdateAccess(id, access, owner).then(
            () => dispatch({ type: actionTypes.UPDATE_ACCESS, id, owner, access }),
            error =>
                dispatchError(
                    dispatch,
                    error,
                    "UPDATE_ACCESS",
                    "Test access update failed",
                    constraintValidationFormatter("the saved test")
                )
        )
}

export function deleteTest(id: number) {
    return (dispatch: Dispatch<DeleteAction | AddAlertAction>) =>
        Api.testServiceDelete(id).then(
            () => dispatch({ type: actionTypes.DELETE, id }),
            error => dispatchError(dispatch, error, "DELETE_TEST", "Failed to delete test " + id)
        )
}

export function allSubscriptions(folder?: string) {
    return (dispatch: Dispatch<UpdateTestWatchAction | AddAlertAction>) =>
        Api.subscriptionServiceAll(folder).then(
            response =>
                dispatch({
                    type: actionTypes.UPDATE_TEST_WATCH,
                    byId: Map(Object.entries(response).map(([key, value]) => [parseInt(key), [...value]])),
                }),
            error => dispatchError(dispatch, error, "GET_ALL_SUBSCRIPTIONS", "Failed to fetch test subscriptions")
        )
}

function watchToList(watch: Watch) {
    return [...watch.users, ...watch.teams, ...watch.optout.map((u: string) => `!${u}`)]
}

export function getSubscription(testId: number) {
    return (dispatch: Dispatch<UpdateTestWatchAction | AddAlertAction>) =>
        Api.subscriptionServiceGet(testId).then(
            watch => {
                dispatch({
                    type: actionTypes.UPDATE_TEST_WATCH,
                    byId: Map([[testId, watchToList(watch)]]),
                })
                return watch
            },
            error => dispatchError(dispatch, error, "SUBSCRIPTION_LOOKUP", "Subscription lookup failed")
        ) as Promise<Watch>
}

export function updateSubscription(watch: Watch) {
    return (dispatch: Dispatch<UpdateTestWatchAction | AddAlertAction>) =>
        Api.subscriptionServiceUpdate(watch.testId, watch).then(
            () =>
                dispatch({
                    type: actionTypes.UPDATE_TEST_WATCH,
                    byId: Map([[watch.testId, watchToList(watch)]]),
                }),
            error => dispatchError(dispatch, error, "SUBSCRIPTION_UPDATE", "Failed to update subscription")
        )
}

export function addUserOrTeam(id: number, userOrTeam: string) {
    return (dispatch: Dispatch<UpdateTestWatchAction | AddAlertAction>) => {
        dispatch({
            type: actionTypes.UPDATE_TEST_WATCH,
            byId: Map([[id, undefined]]),
        })
        return Api.subscriptionServiceAddUserOrTeam(id, userOrTeam).then(
            response =>
                dispatch({
                    type: actionTypes.UPDATE_TEST_WATCH,
                    byId: Map([[id, response as string[]]]),
                }),
            error => dispatchError(dispatch, error, "ADD_SUBSCRIPTION", "Failed to add test subscriptions")
        )
    }
}

export function removeUserOrTeam(id: number, userOrTeam: string) {
    return (dispatch: Dispatch<UpdateTestWatchAction | AddAlertAction>) => {
        dispatch({
            type: actionTypes.UPDATE_TEST_WATCH,
            byId: Map([[id, undefined]]),
        })
        return Api.subscriptionServiceRemoveUserOrTeam(id, userOrTeam).then(
            response =>
                dispatch({
                    type: actionTypes.UPDATE_TEST_WATCH,
                    byId: Map([[id, response as string[]]]),
                }),
            error => dispatchError(dispatch, error, "REMOVE_SUBSCRIPTION", "Failed to remove test subscriptions")
        )
    }
}

export function fetchFolders() {
    return (dispatch: Dispatch<UpdateFoldersAction | AddAlertAction>) => {
        return Api.testServiceFolders().then(
            response =>
                dispatch({
                    type: actionTypes.UPDATE_FOLDERS,
                    folders: response,
                }),
            error => dispatchError(dispatch, error, "UPDATE_FOLDERS", "Failed to retrieve a list of existing folders")
        )
    }
}

export function updateTransformers(testId: number, transformers: Transformer[]) {
    return (dispatch: Dispatch<UpdateTransformersAction | AddAlertAction>) => {
        return Api.testServiceUpdateTransformers(
            testId,
            transformers.map(t => t.id)
        ).then(
            () => dispatch({ type: actionTypes.UPDATE_TRANSFORMERS, testId, transformers }),
            error =>
                dispatchError(
                    dispatch,
                    error,
                    "UPDATE_TRANSFORMERS",
                    "Failed to update transformers for test " + testId
                )
        )
    }
}

export function updateFingerprint(testId: number, labels: string[], filter?: string) {
    return (dispatch: Dispatch<UpdateFingerprintAction | AddAlertAction>) => {
        return Api.testServiceUpdateFingerprint(testId, { labels, filter }).then(
            () => dispatch({ type: actionTypes.UPDATE_FINGERPRINT, testId, labels, filter }),
            error =>
                dispatchError(dispatch, error, "UPDATE_FINGERPRINT", "Failed to update fingerprint for test " + testId)
        )
    }
}

export function updateRunsAndDatasetsAction(
    testId: number,
    runs: number,
    datasets: number
): UpdateRunsAndDatasetsAction {
    return { type: actionTypes.UPDATE_RUNS_AND_DATASETS, testId, runs, datasets }
}
