import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { desktopBridge, hostsBrowser, type BrowserAction, type BrowserState } from "../../lib/desktop-bridge.ts"
import type { BrowserTabPage } from "./browser-model.ts"
import { parseTabPages, tabPage, tabPagesStorageKey, withTabPage, type TabPages } from "./review-model.ts"
import { useRecentPages } from "./use-recent-pages.ts"

function readTabPages(): TabPages {
  try {
    return parseTabPages(JSON.parse(window.localStorage.getItem(tabPagesStorageKey) ?? "null"))
  } catch {
    // Unavailable or malformed storage remembers nothing.
    return {}
  }
}

function writeTabPages(pages: TabPages) {
  try {
    window.localStorage.setItem(tabPagesStorageKey, JSON.stringify(pages))
  } catch {
    // A closed page is then only not offered again.
  }
}

// A request to focus another project's address field waits here while the
// window switches to that project; its workspace takes it once mounted.
let pendingFocus: string | null = null

// ProjectBrowser is a project's link to the guests of its Browser tabs, the
// pages they show (decisions 0184, 0195). It follows one tab, the one that
// shows or showed last, and reads the others' pages for their names.
export interface ProjectBrowser {
  // available says this window hosts the Browser: the desktop app with
  // experimental features on.
  available: boolean
  // multiple says the app keeps a page per Browser tab; without it the
  // project has tab 1 only.
  multiple: boolean
  // tab is the Browser tab followed.
  tab: number
  // state is tab's guest's, or null without one.
  state: BrowserState | null
  // remembered is the address tab last showed, "" for none: what a tab
  // whose page closed offers to load again.
  remembered: string
  // pages are the project's open Browser tabs and what they show, or
  // showed last, in tab order.
  pages: readonly BrowserTabPage[]
  // recent is the project's pages, most recent first.
  recent: readonly string[]
  // forget removes a page from recent (decision 0195).
  forget(url: string): void
  // open shows a page in tab's guest, making it first if the tab has none,
  // and remembers the page; openIn does so in another tab.
  open(url: string): void
  openIn(tab: number, url: string): void
  act(action: BrowserAction): void
  // close closes tab's page and forgets what it showed.
  close(tab: number): void
  // requestFocus gives the address field the keyboard and selects its
  // text, once the tab has registered it with registerField.
  requestFocus(): void
  registerField(focus: (() => void) | null): void
}

// useProjectBrowser follows the guests of a project's Browser tabs (tabs,
// with tab the one followed): it reads their states on mount, when the app
// announces a change (zero:browser, whose detail is the project), after
// each thing it asks of a guest, and when this window regains focus, which
// catches a page's own history moves. The newest read wins. What each tab
// shows is remembered in zero-browser-tabs.
export function useProjectBrowser(project: string, tab: number, tabs: readonly number[]): ProjectBrowser {
  const bridge = useMemo(() => desktopBridge(), [])
  const available = hostsBrowser(bridge)
  const multiple = available && bridge?.browserTabs === true
  const browserOpen = available ? bridge?.browserOpen ?? null : null
  const browserState = available ? bridge?.browserState ?? null : null
  const browserAction = available ? bridge?.browserAction ?? null : null
  const ids = useMemo(() => [...new Set([tab, ...tabs])].sort((left, right) => left - right), [tab, tabs])
  const idsKey = ids.join(",")
  const [states, setStates] = useState<{ project: string; states: ReadonlyMap<number, BrowserState | null> }>({ project, states: new Map() })
  const [tabPages, setTabPages] = useState(readTabPages)
  const { recent, remember, forget } = useRecentPages(project)
  const reads = useRef(0)
  const field = useRef<(() => void) | null>(null)
  const wantsFocus = useRef(false)

  const refresh = useCallback(() => {
    if (!browserState) return
    const read = ++reads.current
    const asked = idsKey.split(",").map(Number)
    void Promise.all(asked.map((id) => browserState(project, id))).then((answers) => {
      // Only the newest read lands.
      if (read === reads.current) setStates({ project, states: new Map(asked.map((id, index) => [id, answers[index] ?? null])) })
    })
  }, [browserState, idsKey, project])

  useEffect(() => {
    if (!browserState) return
    refresh()
    function onChange(event: Event) {
      if (event instanceof CustomEvent && event.detail === project) refresh()
    }
    window.addEventListener("zero:browser", onChange)
    window.addEventListener("focus", refresh)
    return () => {
      window.removeEventListener("zero:browser", onChange)
      window.removeEventListener("focus", refresh)
    }
  }, [browserState, project, refresh])

  const current = states.project === project ? states.states : null
  // Each tab remembers the address its guest shows.
  useEffect(() => {
    if (!current) return
    let pages = readTabPages()
    let changed = false
    for (const [id, state] of current) {
      if (!state?.url || tabPage(pages, project, id) === state.url) continue
      pages = withTabPage(pages, project, id, state.url)
      changed = true
    }
    if (!changed) return
    writeTabPages(pages)
    setTabPages(pages)
  }, [current, project])

  const state = current?.get(tab) ?? null
  const remembered = tabPage(tabPages, project, tab)
  const pages = useMemo(() => tabs.map((id): BrowserTabPage => {
    const shown = current?.get(id) ?? null
    return { id, url: shown?.url || tabPage(tabPages, project, id), title: shown?.title ?? "" }
  }), [current, project, tabPages, tabs])

  const openIn = useCallback((id: number, url: string) => {
    if (!browserOpen) return
    remember(url)
    void browserOpen(project, url, id).then(refresh)
  }, [browserOpen, project, refresh, remember])
  const open = useCallback((url: string) => openIn(tab, url), [openIn, tab])

  const act = useCallback((action: BrowserAction) => {
    void browserAction?.(project, action, tab).then(refresh)
  }, [browserAction, project, refresh, tab])

  const close = useCallback((id: number) => {
    void browserAction?.(project, "close", id).then(refresh)
    const next = withTabPage(readTabPages(), project, id, "")
    writeTabPages(next)
    setTabPages(next)
  }, [browserAction, project, refresh])

  // Focus moves a frame later: a palette or menu that asked for it closes
  // first and puts focus back where it was.
  const requestFocus = useCallback(() => {
    const focus = field.current
    if (focus) requestAnimationFrame(() => focus())
    else wantsFocus.current = true
  }, [])

  const registerField = useCallback((focus: (() => void) | null) => {
    field.current = focus
    if (focus && wantsFocus.current) {
      wantsFocus.current = false
      requestAnimationFrame(() => focus())
    }
  }, [])

  useEffect(() => {
    if (pendingFocus !== project) return
    pendingFocus = null
    requestFocus()
  }, [project, requestFocus])

  return { available, multiple, tab, state, remembered, pages, recent, forget, open, openIn, act, close, requestFocus, registerField }
}

// focusBrowserLater asks the workspace of project, once it mounts, to focus
// its Browser tab's address field.
export function focusBrowserLater(project: string) {
  pendingFocus = project
}

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

// BrowserCommands are the Browser's commands from the app's menu and the
// keyboard: Open Location and New Tab.
export interface BrowserCommands {
  // locate answers Open Location for project and tab, or null for the
  // window's own project and its Browser tab that shows or showed last.
  locate(project: string | null, tab: number | null): void
  // newTab answers New Tab for project, or null for the window's own.
  newTab(project: string | null): void
}

// useBrowserCommands answers Open Location (Ctrl/Cmd+L), which takes the
// address field of a project's Browser tab, and New Tab (Ctrl/Cmd+T,
// decision 0195), which opens another. The desktop app's Browser menu sends
// them as zero:browser-command with command "location" or "newTab", since
// its accelerators work while the guest has the keyboard; its project and
// tab are those whose guest shows in this window, or null for the window's
// own. The same keys pressed in Zero's page do the same for its project.
export function useBrowserCommands(enabled: boolean, commands: BrowserCommands) {
  const latest = useRef(commands)
  useEffect(() => {
    latest.current = commands
  }, [commands])
  useEffect(() => {
    if (!enabled) return
    function onCommand(event: Event) {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (typeof detail !== "object" || detail === null || !("command" in detail)) return
      const target = "project" in detail && typeof detail.project === "string" && detail.project ? detail.project : null
      if (detail.command === "location") {
        const tab = "tab" in detail && typeof detail.tab === "number" && Number.isInteger(detail.tab) && detail.tab > 0 ? detail.tab : null
        event.preventDefault()
        latest.current.locate(target, tab)
      } else if (detail.command === "newTab") {
        event.preventDefault()
        latest.current.newTab(target)
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || (event.code !== "KeyL" && event.code !== "KeyT") || event.altKey || event.shiftKey) return
      if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return
      event.preventDefault()
      if (event.code === "KeyL") latest.current.locate(null, null)
      else latest.current.newTab(null)
    }
    window.addEventListener("zero:browser-command", onCommand)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("zero:browser-command", onCommand)
      window.removeEventListener("keydown", onKey)
    }
  }, [enabled])
}
