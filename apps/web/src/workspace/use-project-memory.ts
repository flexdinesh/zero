import type { PageData } from "@zero/contracts"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  missingTabs,
  projectMemory,
  readMemory,
  rememberProject,
  restoreTabs,
  startupTab,
  updateMemory,
} from "./workspace-memory.ts"
import { includesTab, type TabFeatures, type WorkspaceTab } from "./workspace-tabs.ts"

interface ProjectMemoryOptions {
  project: string
  // page is the loaded page for project, or null while loading or failed.
  page: PageData | null
  // files is the project's tree, or null until it loads (decision 0192).
  files: readonly string[] | null
  // active is the routed tab, or null on the project's home.
  active: WorkspaceTab | null
  tabs: readonly WorkspaceTab[]
  // welcome opens the Welcome tab when nothing is routed or restored.
  welcome: boolean
  // features is which experimental tabs the window offers; the rest are
  // not restored.
  features: TabFeatures
  restore(tabs: readonly WorkspaceTab[]): void
  // drop removes restored tabs whose files the tree no longer holds.
  drop(tabs: readonly WorkspaceTab[]): void
  openRemembered(tab: WorkspaceTab): void
}

// useProjectMemory restores a project's remembered tabs once its first page
// loads, then remembers tabs as they change. Restoring waits for no tree: it
// navigates, which would close a dialog opened meanwhile. Documents restored
// before the tree are checked once it loads (decision 0192).
export function useProjectMemory({ project, page, files: list, active, tabs, welcome, features, restore, drop, openRemembered }: ProjectMemoryOptions) {
  const [restored, setRestored] = useState<{ opening: boolean } | null>(null)
  const ready = page !== null && !page.error && page.project === project
  const sessionKey = page?.sessionKey ?? ""
  const files = useMemo(() => list === null ? null : new Set(list), [list])
  // unchecked holds tabs restored before the tree loaded.
  const unchecked = useRef<readonly WorkspaceTab[]>([])

  useEffect(() => {
    if (restored || !ready) return
    const remembered = restoreTabs(projectMemory(readMemory(), project), files, features)
    if (files === null) unchecked.current = remembered.tabs
    restore(remembered.tabs)
    const opening = startupTab(active, remembered, welcome)
    setRestored({ opening: opening !== null })
    if (opening) openRemembered(opening)
  }, [active, features, files, openRemembered, project, ready, restore, restored, welcome])

  useEffect(() => {
    if (files === null || unchecked.current.length === 0) return
    const missing = missingTabs(unchecked.current, files, active)
    unchecked.current = []
    if (missing.length > 0) drop(missing)
  }, [active, drop, files])

  useEffect(() => {
    // Restoration schedules tab state and possibly navigation. Wait for those
    // updates before saving, so mounting never erases the remembered workspace.
    if (!restored || !ready || (restored.opening && !active)) return
    if (active && !includesTab(tabs, active)) return
    if (restored.opening) setRestored({ opening: false })
    updateMemory((memory) => rememberProject(memory, sessionKey, project, tabs, active))
  }, [active, project, ready, restored, sessionKey, tabs])
}
