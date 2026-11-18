import { useCallback, useLayoutEffect, useRef, useState } from "react"

import type { CommitRange } from "@zero/contracts"
import {
  clampRailWidth, defaultLayout, paneIds, readLayout, resizePair, withBase, writeLayout,
  type ChangesView, type PaneId, type SourceControlLayout,
} from "./source-control-layout.ts"

function withWeights(current: SourceControlLayout, weights: SourceControlLayout["weights"]): SourceControlLayout {
  return paneIds.every((id) => current.weights[id] === weights[id]) ? current : { ...current, weights }
}

// Committed preferences only. Layout owners preview pointer geometry locally;
// their completion actions merge it into the latest preference snapshot.
export function useSourceControlLayout(project: string) {
  const [layout, setLayout] = useState<SourceControlLayout>(readLayout)
  const committed = useRef(layout)
  const commit = useCallback((update: (current: SourceControlLayout) => SourceControlLayout) => {
    const next = update(committed.current)
    if (next === committed.current) return
    committed.current = next
    setLayout(next)
    // Event-owned persistence also survives an owner's unmount. It does not
    // run in render, an effect, or a React updater replayed by Strict Mode.
    writeLayout(next)
  }, [])

  useLayoutEffect(() => {
    // A new project renders before the previous project's layout cleanup can
    // finish its drag. Reconcile that final persisted value before paint.
    const latest = readLayout()
    if (JSON.stringify(latest) === JSON.stringify(committed.current)) return
    committed.current = latest
    setLayout(latest)
  }, [])

  const setRange = useCallback((range: CommitRange) => commit((current) => current.range === range ? current : { ...current, range }), [commit])
  const setPaneCollapsed = useCallback((pane: PaneId, collapsed: boolean) => commit((current) => (
    current.collapsed[pane] === collapsed ? current : { ...current, collapsed: { ...current.collapsed, [pane]: collapsed } }
  )), [commit])
  const setPaneWeights = useCallback((weights: SourceControlLayout["weights"]) => commit((current) => withWeights(current, weights)), [commit])
  const resizePanes = useCallback((open: readonly PaneId[], above: PaneId, below: PaneId, delta: number) => commit((current) => (
    withWeights(current, resizePair(current.weights, open, above, below, delta))
  )), [commit])
  const resetPanes = useCallback(() => commit((current) => withWeights(current, defaultLayout.weights)), [commit])
  const setChangesView = useCallback((changesView: ChangesView) => commit((current) => (
    current.changesView === changesView ? current : { ...current, changesView }
  )), [commit])
  const setRailWidth = useCallback((width: number) => commit((current) => {
    const railWidth = clampRailWidth(width)
    return current.railWidth === railWidth ? current : { ...current, railWidth }
  }), [commit])
  const setRailHidden = useCallback((railHidden: boolean) => commit((current) => (
    current.railHidden === railHidden ? current : { ...current, railHidden }
  )), [commit])
  const setRailHideViewed = useCallback((railHideViewed: boolean) => commit((current) => (
    current.railHideViewed === railHideViewed ? current : { ...current, railHideViewed }
  )), [commit])
  const base = Object.hasOwn(layout.bases, project) ? layout.bases[project] ?? "" : ""
  const setBase = useCallback((next: string) => commit((current) => withBase(current, project, next)), [commit, project])

  return {
    range: layout.range, weights: layout.weights, collapsed: layout.collapsed, changesView: layout.changesView,
    railWidth: layout.railWidth, railHidden: layout.railHidden, railHideViewed: layout.railHideViewed, base,
    setRange, setPaneCollapsed, setPaneWeights, resizePanes, resetPanes, setChangesView, setRailWidth, setRailHidden, setRailHideViewed, setBase,
  }
}

export type SourceControlLayoutState = ReturnType<typeof useSourceControlLayout>
