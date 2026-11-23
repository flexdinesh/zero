import { useCallback, useEffect, useState } from "react"

import type { DocumentMode } from "../features/documents/DocumentModeToggle.tsx"
import { documentKey, includesTab, placeTab, sameTab, type WorkspaceTab } from "./workspace-tabs.ts"

interface DocumentWorkspace {
  tabs: WorkspaceTab[]
  // preview is the walkthrough step's or visual thread's tab the next one
  // replaces (decisions 0113, 0182), or null.
  preview: WorkspaceTab | null
  // modes are keyed by documentKey.
  modes: ReadonlyMap<string, DocumentMode>
  wordWrap: ReadonlyMap<string, boolean>
}

// useDocumentWorkspace owns open tabs; the routed active tab joins them, as
// the preview tab when asPreview (a walkthrough step's or screen tab's route).
export function useDocumentWorkspace(active: WorkspaceTab | null, asPreview: boolean) {
  const [workspace, setWorkspace] = useState<DocumentWorkspace>(() => ({
    ...(active ? placeTab({ tabs: [], preview: null }, active, asPreview) : { tabs: [], preview: null }),
    modes: new Map(),
    wordWrap: new Map(),
  }))
  useEffect(() => {
    if (!active) return
    setWorkspace((current) => {
      const placed = placeTab(current, active, asPreview)
      if (placed === current) return current
      if (placed.preview !== current.preview && current.preview?.kind === "document") {
        const wordWrap = new Map(current.wordWrap)
        wordWrap.delete(documentKey(current.preview.path, current.preview.at))
        return { ...current, ...placed, wordWrap }
      }
      return { ...current, ...placed }
    })
  }, [active, asPreview])

  // pin keeps the preview tab open as an ordinary tab.
  const pin = useCallback((tab?: WorkspaceTab) => {
    setWorkspace((current) => current.preview && (!tab || sameTab(tab, current.preview)) ? { ...current, preview: null } : current)
  }, [])

  const setDocumentMode = useCallback((key: string, mode: DocumentMode) => {
    setWorkspace((current) => {
      if (current.modes.get(key) === mode) return current
      const modes = new Map(current.modes)
      modes.set(key, mode)
      return { ...current, modes }
    })
  }, [])

  const toggleWordWrap = useCallback((key: string, defaultWrap: boolean) => {
    setWorkspace((current) => {
      const wrap = !(current.wordWrap.get(key) ?? defaultWrap)
      const wordWrap = new Map(current.wordWrap)
      if (wrap === defaultWrap) wordWrap.delete(key)
      else wordWrap.set(key, wrap)
      return { ...current, wordWrap }
    })
  }, [])

  // restore opens remembered tabs ahead of the ones opened this session.
  const restore = useCallback((tabs: readonly WorkspaceTab[]) => {
    setWorkspace((current) => {
      const merged = [...tabs, ...current.tabs.filter((tab) => !includesTab(tabs, tab))]
      return merged.length === current.tabs.length && merged.every((tab, index) => sameTab(tab, current.tabs[index] ?? null))
        ? current
        : { ...current, tabs: merged }
    })
  }, [])

  // drop removes tabs that were never shown, as restored tabs whose files are
  // gone (decision 0192).
  const drop = useCallback((dropping: readonly WorkspaceTab[]) => {
    setWorkspace((current) => {
      const tabs = current.tabs.filter((tab) => !includesTab(dropping, tab))
      if (tabs.length === current.tabs.length) return current
      const preview = current.preview && includesTab(dropping, current.preview) ? null : current.preview
      return { ...current, tabs, preview }
    })
  }, [])

  // replaceTab puts next where tab stands, as when a review changes scope
  // (decision 0051); next already open elsewhere just drops tab.
  const replaceTab = useCallback((tab: WorkspaceTab, next: WorkspaceTab) => {
    setWorkspace((current) => {
      if (!includesTab(current.tabs, tab) || sameTab(tab, next)) return current
      const tabs = includesTab(current.tabs, next)
        ? current.tabs.filter((other) => !sameTab(other, tab))
        : current.tabs.map((other) => sameTab(other, tab) ? next : other)
      return { ...current, tabs, preview: sameTab(current.preview, tab) ? next : current.preview }
    })
  }, [])

  function closeTabs(closing: readonly WorkspaceTab[], activeTab: WorkspaceTab | null) {
    const closed = workspace.tabs.filter((tab) => includesTab(closing, tab))
    if (closed.length === 0) return null
    const index = workspace.tabs.findIndex((tab) => sameTab(tab, activeTab))
    const replacement = workspace.tabs.slice(index + 1).find((tab) => !includesTab(closed, tab))
      ?? workspace.tabs.slice(0, Math.max(index, 0)).reverse().find((tab) => !includesTab(closed, tab))
    setWorkspace((current) => {
      const modes = new Map(current.modes)
      const wordWrap = new Map(current.wordWrap)
      // Modes and wrap overrides belong to documents, independent of reviews.
      for (const tab of closed) {
        if (tab.kind !== "document") continue
        const key = documentKey(tab.path, tab.at)
        modes.delete(key)
        wordWrap.delete(key)
      }
      const preview = current.preview && includesTab(closed, current.preview) ? null : current.preview
      return { tabs: current.tabs.filter((tab) => !includesTab(closed, tab)), preview, modes, wordWrap }
    })
    return { tabs: closed, replacement: replacement ?? null }
  }

  return { tabs: workspace.tabs, preview: workspace.preview, modes: workspace.modes, wordWrap: workspace.wordWrap, setDocumentMode, toggleWordWrap, closeTabs, replaceTab, restore, drop, pin }
}
