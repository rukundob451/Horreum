import { useState, useMemo, useEffect } from "react"

import { useDispatch, useSelector } from "react-redux"
import { useHistory } from "react-router"

import {
    Button,
    Card,
    CardHeader,
    CardBody,
    Dropdown,
    DropdownToggle,
    DropdownItem,
    List,
    ListItem,
    Modal,
    PageSection,
    Spinner,
} from "@patternfly/react-core"
import { NavLink } from "react-router-dom"
import { EyeIcon, EyeSlashIcon, FolderIcon, FolderOpenIcon } from "@patternfly/react-icons"

import {
    fetchSummary,
    updateAccess,
    deleteTest,
    allSubscriptions,
    addUserOrTeam,
    removeUserOrTeam,
    updateFolder,
} from "./actions"
import * as selectors from "./selectors"

import Table from "../../components/Table"
import AccessIcon from "../../components/AccessIcon"
import ActionMenu, { MenuItem, ActionMenuProps, useChangeAccess } from "../../components/ActionMenu"
import TeamSelect, { Team, ONLY_MY_OWN } from "../../components/TeamSelect"
import FolderSelect from "../../components/FolderSelect"
import ConfirmTestDeleteModal from "./ConfirmTestDeleteModal"

import { Access, isAuthenticatedSelector, useTester, teamToName, teamsSelector, userProfileSelector } from "../../auth"
import { CellProps, Column, UseSortByColumnOptions } from "react-table"
import { Test, TestDispatch } from "./reducers"
import { noop } from "../../utils"

type WatchDropdownProps = {
    id: number
    watching?: string[]
}

const WatchDropdown = ({ id, watching }: WatchDropdownProps) => {
    const [open, setOpen] = useState(false)
    const teams = useSelector(teamsSelector)
    const profile = useSelector(userProfileSelector)
    const dispatch = useDispatch<TestDispatch>()
    if (watching === undefined) {
        return <Spinner size="sm" />
    }
    const personalItems = []
    const self = profile?.username || "__self"
    const isOptOut = watching.some(u => u.startsWith("!"))
    if (watching.some(u => u === profile?.username)) {
        personalItems.push(
            <DropdownItem key="__self" onClick={() => dispatch(removeUserOrTeam(id, self)).catch(noop)}>
                Stop watching personally
            </DropdownItem>
        )
    } else {
        personalItems.push(
            <DropdownItem key="__self" onClick={() => dispatch(addUserOrTeam(id, self)).catch(noop)}>
                Watch personally
            </DropdownItem>
        )
    }
    if (isOptOut) {
        personalItems.push(
            <DropdownItem key="__optout" onClick={() => dispatch(removeUserOrTeam(id, "!" + self)).catch(noop)}>
                Resume watching per team settings
            </DropdownItem>
        )
    } else if (watching.some(u => u.endsWith("-team"))) {
        personalItems.push(
            <DropdownItem key="__optout" onClick={() => dispatch(addUserOrTeam(id, "!" + self)).catch(noop)}>
                Opt-out of all notifications
            </DropdownItem>
        )
    }
    return (
        <Dropdown
            isOpen={open}
            isPlain
            onSelect={_ => setOpen(false)}
            menuAppendTo={() => document.body}
            toggle={
                <DropdownToggle toggleIndicator={null} onToggle={setOpen}>
                    {!isOptOut && (
                        <EyeIcon
                            className="watchIcon"
                            style={{ cursor: "pointer", color: watching.length > 0 ? "#151515" : "#d2d2d2" }}
                        />
                    )}
                    {isOptOut && <EyeSlashIcon className="watchIcon" style={{ cursor: "pointer", color: "#151515" }} />}
                </DropdownToggle>
            }
        >
            {personalItems}
            {teams.map(team =>
                watching.some(u => u === team) ? (
                    <DropdownItem key={team} onClick={() => dispatch(removeUserOrTeam(id, team)).catch(noop)}>
                        Stop watching as team {teamToName(team)}
                    </DropdownItem>
                ) : (
                    <DropdownItem key={team} onClick={() => dispatch(addUserOrTeam(id, team)).catch(noop)}>
                        Watch as team {teamToName(team)}
                    </DropdownItem>
                )
            )}
        </Dropdown>
    )
}

type C = CellProps<Test>
type Col = Column<Test> & UseSortByColumnOptions<Test>

type DeleteConfig = {
    name: string
}

function useDelete(config: DeleteConfig): MenuItem<DeleteConfig> {
    const [confirmDeleteModalOpen, setConfirmDeleteModalOpen] = useState(false)
    const dispatch = useDispatch<TestDispatch>()
    return [
        (props: ActionMenuProps, isOwner: boolean, close: () => void, config: DeleteConfig) => {
            return {
                item: (
                    <DropdownItem
                        key="delete"
                        onClick={() => {
                            close()
                            setConfirmDeleteModalOpen(true)
                        }}
                        isDisabled={!isOwner}
                    >
                        Delete
                    </DropdownItem>
                ),
                modal: (
                    <ConfirmTestDeleteModal
                        key="delete"
                        isOpen={confirmDeleteModalOpen}
                        onClose={() => setConfirmDeleteModalOpen(false)}
                        onDelete={() => {
                            dispatch(deleteTest(props.id)).catch(noop)
                        }}
                        testId={props.id}
                        testName={config.name}
                    />
                ),
            }
        },
        config,
    ]
}

type MoveToFolderConfig = {
    name: string
    folder: string
    onMove(id: number, folder: string): Promise<any>
}

function MoveToFolderProvider(props: ActionMenuProps, isOwner: boolean, close: () => void, config: MoveToFolderConfig) {
    const [isOpen, setOpen] = useState(false)
    const [newFolder, setNewFolder] = useState<string>(config.folder)
    const [moving, setMoving] = useState(false)

    useEffect(() => {
        setNewFolder(config.folder)
    }, [config.folder])

    return {
        item: (
            <DropdownItem
                key="moveToFolder"
                isDisabled={!isOwner}
                onClick={() => {
                    close()
                    setOpen(true)
                }}
            >
                Move to another folder
            </DropdownItem>
        ),
        modal: (
            <Modal
                key="moveToFolder"
                title={`Move test ${config.name} from ${config.folder || "root folder"} to another folder`}
                isOpen={isOpen}
                onClose={() => setOpen(false)}
                actions={[
                    <Button
                        key="move"
                        isDisabled={moving || config.folder === newFolder}
                        onClick={() => {
                            setMoving(true)
                            config.onMove(props.id, newFolder).finally(() => {
                                setMoving(false)
                                setOpen(false)
                            })
                        }}
                    >
                        Move
                        {moving && (
                            <>
                                {"\u00A0"}
                                <Spinner size="md" />
                            </>
                        )}
                    </Button>,
                    <Button key="cancel" isDisabled={moving} variant="secondary" onClick={() => setOpen(false)}>
                        Cancel
                    </Button>,
                ]}
            >
                Please select folder:
                <br />
                <FolderSelect canCreate={true} folder={newFolder} onChange={setNewFolder} readOnly={moving} />
            </Modal>
        ),
    }
}

export function useMoveToFolder(config: MoveToFolderConfig): MenuItem<MoveToFolderConfig> {
    return [MoveToFolderProvider, config]
}

function parent(folder: string) {
    const index = folder.lastIndexOf("/")
    if (index < 0) return ""
    return folder.substr(0, index)
}

export default function AllTests() {
    const history = useHistory()
    const params = new URLSearchParams(history.location.search)
    const folder = params.get("folder")

    document.title = "Tests | Horreum"
    const dispatch = useDispatch<TestDispatch>()
    const watchingColumn: Col = {
        Header: "Watching",
        accessor: "watching",
        disableSortBy: true,
        Cell: (arg: C) => {
            return <WatchDropdown watching={arg.cell.value} id={arg.row.original.id} />
        },
    }
    let columns: Col[] = useMemo(
        () => [
            {
                Header: "Id",
                accessor: "id",
                Cell: (arg: C) => {
                    const {
                        cell: { value },
                    } = arg
                    return <NavLink to={`/test/${value}`}>{value}</NavLink>
                },
            },
            {
                Header: "Access",
                accessor: "access",
                Cell: (arg: C) => <AccessIcon access={arg.cell.value} />,
            },
            { Header: "Owner", accessor: "owner", Cell: (arg: C) => teamToName(arg.cell.value) },
            {
                Header: "Name",
                accessor: "name",
                Cell: (arg: C) => <NavLink to={`/test/${arg.row.original.id}`}>{arg.cell.value}</NavLink>,
            },
            { Header: "Description", accessor: "description" },
            {
                Header: "Run Count",
                accessor: "count",
                Cell: (arg: C) => {
                    const {
                        cell: {
                            value,
                            row: { index },
                        },
                        data,
                    } = arg
                    return (
                        <NavLink to={`/run/list/${data[index].id}`}>
                            {value}&nbsp;
                            <FolderOpenIcon />
                        </NavLink>
                    )
                },
            },
            {
                Header: "Actions",
                id: "actions",
                accessor: "id",
                Cell: (arg: C) => {
                    const changeAccess = useChangeAccess({
                        onAccessUpdate: (id: number, owner: string, access: Access) => {
                            dispatch(updateAccess(id, owner, access)).catch(noop)
                        },
                    })
                    const move = useMoveToFolder({
                        name: arg.row.original.name,
                        folder: folder || "",
                        onMove: (id, newFolder) => dispatch(updateFolder(id, folder || "", newFolder)),
                    })
                    const del = useDelete({
                        name: arg.row.original.name,
                    })
                    return (
                        <ActionMenu
                            id={arg.cell.value}
                            access={arg.row.original.access}
                            owner={arg.row.original.owner}
                            description={"test " + arg.row.original.name}
                            items={[changeAccess, move, del]}
                        />
                    )
                },
            },
        ],
        [dispatch, folder]
    )
    const folders = useSelector(selectors.currentFolders())
    // This selector causes re-render on any state update as the returned list is always new.
    // We would need deepEquals for a proper comparison - the selector combines tests and watches
    // and modifies the Test objects - that wouldn't trigger shallowEqual, though
    const allTests = useSelector(selectors.all)
    const teams = useSelector(teamsSelector)
    const isAuthenticated = useSelector(isAuthenticatedSelector)
    const [rolesFilter, setRolesFilter] = useState<Team>(ONLY_MY_OWN)
    useEffect(() => {
        dispatch(fetchSummary(rolesFilter.key, folder || undefined)).catch(noop)
    }, [dispatch, teams, rolesFilter, folder])
    useEffect(() => {
        if (isAuthenticated) {
            dispatch(allSubscriptions(folder || undefined)).catch(noop)
        }
    }, [dispatch, isAuthenticated, rolesFilter, folder])
    if (isAuthenticated) {
        columns = [watchingColumn, ...columns]
    }

    const isTester = useTester()
    const isLoading = useSelector(selectors.isLoading)
    return (
        <PageSection>
            <Card>
                <CardHeader>
                    {isTester && (
                        <NavLink className="pf-c-button pf-m-primary" to="/test/_new">
                            New Test
                        </NavLink>
                    )}
                    {isAuthenticated && (
                        <div style={{ width: "200px", marginLeft: "16px" }}>
                            <TeamSelect
                                includeGeneral={true}
                                selection={rolesFilter}
                                onSelect={selection => {
                                    setRolesFilter(selection)
                                }}
                            />
                        </div>
                    )}
                </CardHeader>
                <CardBody style={{ overflowX: "auto" }}>
                    <List isPlain iconSize="large" style={{ paddingLeft: "16px" }}>
                        {folder && (
                            <NavLink key=".." to={`/test?folder=${parent(folder)}`}>
                                <ListItem icon={<FolderIcon />}>.. (parent folder)</ListItem>
                            </NavLink>
                        )}
                        {folders.map(f => (
                            <NavLink key={f} to={folder ? `/test?folder=${folder}/${f}` : `/test?folder=${f}`}>
                                <ListItem icon={<FolderIcon />}>{f}</ListItem>
                            </NavLink>
                        ))}
                    </List>
                    <Table columns={columns} data={allTests || []} isLoading={isLoading} />
                </CardBody>
            </Card>
        </PageSection>
    )
}
