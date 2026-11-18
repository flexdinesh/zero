import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

import type { HistoryFilter } from "./commit-filter.ts"
import { useCommitFilter, type CommitFilterState } from "./use-commit-filter.ts"
import { useSourceControlLayout, type SourceControlLayoutState } from "./use-source-control-layout.ts"

type Query = Pick<SourceControlLayoutState, "base" | "range" | "setBase" | "setRange"> & { filter: HistoryFilter }
type Panes = Pick<SourceControlLayoutState, "weights" | "collapsed" | "changesView" | "setPaneCollapsed" | "setPaneWeights" | "resizePanes" | "resetPanes" | "setChangesView">
type Rail = Pick<SourceControlLayoutState, "railWidth" | "railHidden" | "railHideViewed" | "setRailWidth" | "setRailHidden" | "setRailHideViewed"> & {
  sheetOpen: boolean
  setSheetOpen(open: boolean): void
}
interface Commands {
  showFileHistory(path: string, focus: boolean): void
  focusHistory(focus: boolean): void
}

const QueryContext = createContext<Query | undefined>(undefined)
const PanesContext = createContext<Panes | undefined>(undefined)
const RailContext = createContext<Rail | undefined>(undefined)
const FilterContext = createContext<CommitFilterState | undefined>(undefined)
const CommandsContext = createContext<Commands | undefined>(undefined)

// Mounted once inside the router's project key. View layout and drafts never
// invalidate the workspace's query subscription or its composed children.
export function SourceControlProvider({ children, project }: { children: ReactNode; project: string }) {
  const layout = useSourceControlLayout(project)
  const filter = useCommitFilter()
  const [sheetOpen, setSheetOpen] = useState(false)
  const { base, range, setBase, setRange, weights, collapsed, changesView, setPaneCollapsed, setPaneWeights, resizePanes, resetPanes, setChangesView,
    railWidth, railHidden, railHideViewed, setRailWidth, setRailHidden, setRailHideViewed } = layout
  const query = useMemo(() => ({ base, range, setBase, setRange, filter: filter.applied }), [base, range, setBase, setRange, filter.applied])
  const panes = useMemo(() => ({ weights, collapsed, changesView, setPaneCollapsed, setPaneWeights, resizePanes, resetPanes, setChangesView }),
    [weights, collapsed, changesView, setPaneCollapsed, setPaneWeights, resizePanes, resetPanes, setChangesView])
  const rail = useMemo(() => ({ railWidth, railHidden, railHideViewed, setRailWidth, setRailHidden, setRailHideViewed, sheetOpen, setSheetOpen }),
    [railWidth, railHidden, railHideViewed, setRailWidth, setRailHidden, setRailHideViewed, sheetOpen])
  const { showFileHistory: filterToFile, requestFocus } = filter
  const showFileHistory = useCallback((path: string, focus: boolean) => {
    filterToFile(path, focus)
    setPaneCollapsed("commits", false)
  }, [filterToFile, setPaneCollapsed])
  const focusHistory = useCallback((focus: boolean) => {
    if (focus) requestFocus()
    setPaneCollapsed("commits", false)
  }, [requestFocus, setPaneCollapsed])
  const commands = useMemo(() => ({ showFileHistory, focusHistory }), [showFileHistory, focusHistory])
  return (
    <QueryContext value={query}>
      <CommandsContext value={commands}>
        <PanesContext value={panes}>
          <RailContext value={rail}>
            <FilterContext value={filter}>{children}</FilterContext>
          </RailContext>
        </PanesContext>
      </CommandsContext>
    </QueryContext>
  )
}

export function useSourceControlQuery() {
  const value = useContext(QueryContext)
  if (value === undefined) throw new Error("useSourceControlQuery requires SourceControlProvider")
  return value
}

export function useSourceControlPanes() {
  const value = useContext(PanesContext)
  if (value === undefined) throw new Error("useSourceControlPanes requires SourceControlProvider")
  return value
}

export function useReviewRailLayout() {
  const value = useContext(RailContext)
  if (value === undefined) throw new Error("useReviewRailLayout requires SourceControlProvider")
  return value
}

export function useSourceControlFilter() {
  const value = useContext(FilterContext)
  if (value === undefined) throw new Error("useSourceControlFilter requires SourceControlProvider")
  return value
}

export function useSourceControlCommands() {
  const value = useContext(CommandsContext)
  if (value === undefined) throw new Error("useSourceControlCommands requires SourceControlProvider")
  return value
}
