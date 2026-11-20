import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import { browserAvailable } from "../lib/desktop-bridge.ts"

export type SidebarView = "explorer" | "search" | "source-control" | "walkthroughs" | "feedback" | "browser"

const storageKey = "zero-sidebar"
const mobileQuery = "(max-width: 48rem)"

export interface StoredSidebar {
  hidden: boolean
  view: SidebarView
}

const defaultSidebar: StoredSidebar = { view: "explorer", hidden: false }

function isSidebarView(value: unknown): value is SidebarView {
  return value === "explorer" || value === "search" || value === "source-control" || value === "walkthroughs" || value === "feedback"
    || value === "browser"
}

// parseSidebar reads stored sidebar state; unknown views open the Explorer,
// as does Browser in a window that does not host it (decision 0184).
export function parseSidebar(value: unknown, browser: boolean): StoredSidebar {
  if (typeof value !== "object" || value === null || !("view" in value) || !("hidden" in value)) return defaultSidebar
  return {
    view: isSidebarView(value.view) && (value.view !== "browser" || browser) ? value.view : "explorer",
    hidden: value.hidden === true,
  }
}

function readSidebar(): StoredSidebar {
  try {
    return parseSidebar(JSON.parse(window.localStorage.getItem(storageKey) ?? "null"), browserAvailable())
  } catch {
    // Fall back to the defaults when storage is unavailable or malformed.
    return defaultSidebar
  }
}

function isModifiedShortcut(event: KeyboardEvent, key: string, shift: boolean): boolean {
  return !event.defaultPrevented && !event.altKey && event.shiftKey === shift
    && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === key
}

// useSidebar owns the activity bar's view, desktop visibility, and the mobile
// drawer. Clicking the active view hides the sidebar on desktop, as in VS Code.
export function useSidebar() {
  const drawer = useRef<HTMLDialogElement>(null)
  const [stored] = useState(readSidebar)
  const [view, setView] = useState(stored.view)
  const [hidden, setHidden] = useState(stored.hidden)
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const mobileRef = useRef(mobile)
  useLayoutEffect(() => { mobileRef.current = mobile }, [mobile])

  const syncDrawer = useCallback(() => setDrawerOpen(drawer.current?.open === true), [])
  const dismiss = useCallback(() => {
    if (drawer.current?.open) drawer.current.close()
    syncDrawer()
  }, [syncDrawer])

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ view, hidden }))
    } catch {
      // The sidebar still works when storage is unavailable.
    }
  }, [hidden, view])

  useEffect(() => {
    const query = window.matchMedia(mobileQuery)
    const update = () => {
      if (!query.matches) dismiss()
      setMobile(query.matches)
    }
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [dismiss])

  const reveal = useCallback((next: SidebarView) => {
    setView(next)
    setHidden(false)
    const element = drawer.current
    if (mobileRef.current && element && !element.open) {
      element.showModal()
      syncDrawer()
      // showModal focuses the first activity item; move that focus to the
      // revealed view's item unless the view already took it, as Search does.
      requestAnimationFrame(() => {
        if (!element.open || !document.activeElement?.closest(".activity-bar")) return
        element.querySelector<HTMLElement>(`.activity-item[data-view="${next}"]`)?.focus()
      })
    }
  }, [syncDrawer])

  const select = useCallback((next: SidebarView) => {
    if (!mobileRef.current && next === view && !hidden) setHidden(true)
    else reveal(next)
  }, [hidden, reveal, view])

  const toggle = useCallback(() => {
    if (!mobileRef.current) setHidden((current) => !current)
    else if (drawer.current?.open) dismiss()
    else reveal(view)
  }, [dismiss, reveal, view])

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (isModifiedShortcut(event, "b", false)) toggle()
      else if (isModifiedShortcut(event, "e", true)) reveal("explorer")
      else if (isModifiedShortcut(event, "g", true)) reveal("source-control")
      else return
      event.preventDefault()
    }
    document.addEventListener("keydown", shortcut)
    return () => document.removeEventListener("keydown", shortcut)
  }, [reveal, toggle])

  const visibleView = (mobile ? drawerOpen : !hidden) ? view : null
  return { drawer, mobile, view, hidden: hidden && !mobile, visibleView, reveal, select, dismiss, syncDrawer }
}

export type SidebarState = ReturnType<typeof useSidebar>
