import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { desktopBridge, hostsBrowser, type BrowserAction, type BrowserState } from "../../lib/desktop-bridge.ts"
import { useRecentPages } from "./use-recent-pages.ts"

// A request to focus another project's address field waits here while the
// window switches to that project; its workspace takes it once mounted.
let pendingFocus: string | null = null

// ProjectBrowser is a project's link to its guest, the page its Browser tab
// shows (decision 0184).
export interface ProjectBrowser {
  // available says this window hosts the Browser: the desktop app with
  // experimental features on.
  available: boolean
  // state is the guest's, or null without one.
  state: BrowserState | null
  // recent is the project's pages, most recent first.
  recent: readonly string[]
  // forget removes a page from recent (decision 0195).
  forget(url: string): void
  // open shows a page in the guest, making it first if the project has
  // none, and remembers the page.
  open(url: string): void
  act(action: BrowserAction): void
  // requestFocus gives the address field the keyboard and selects its
  // text, once the tab has registered it with registerField.
  requestFocus(): void
  registerField(focus: (() => void) | null): void
}

// useProjectBrowser follows a project's guest: it reads the guest's state
// on mount, when the app announces a change (zero:browser, whose detail is
// the project), after each thing it asks of the guest, and when this window
// regains focus, which catches a page's own history moves. The newest read
// wins.
export function useProjectBrowser(project: string): ProjectBrowser {
  const bridge = useMemo(() => desktopBridge(), [])
  const available = hostsBrowser(bridge)
  const browserOpen = available ? bridge?.browserOpen ?? null : null
  const browserState = available ? bridge?.browserState ?? null : null
  const browserAction = available ? bridge?.browserAction ?? null : null
  const [state, setState] = useState<BrowserState | null>(null)
  const { recent, remember, forget } = useRecentPages(project)
  const reads = useRef(0)
  const field = useRef<(() => void) | null>(null)
  const wantsFocus = useRef(false)

  const refresh = useCallback(() => {
    if (!browserState) return
    const read = ++reads.current
    void browserState(project).then((next) => {
      // Only the newest read lands.
      if (read === reads.current) setState(next)
    })
  }, [browserState, project])

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

  const open = useCallback((url: string) => {
    if (!browserOpen) return
    remember(url)
    void browserOpen(project, url).then(refresh)
  }, [browserOpen, project, refresh, remember])

  const act = useCallback((action: BrowserAction) => {
    void browserAction?.(project, action).then(refresh)
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

  return { available, state, recent, forget, open, act, requestFocus, registerField }
}

// focusBrowserLater asks the workspace of project, once it mounts, to focus
// its Browser tab's address field.
export function focusBrowserLater(project: string) {
  pendingFocus = project
}

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

// useBrowserLocation answers Open Location (Ctrl/Cmd+L), which takes the
// address field of a project's Browser tab. The desktop app's Browser menu
// sends it as zero:browser-command with command "location", since its
// accelerator works while the guest has the keyboard; its project is the
// one whose guest shows in this window, or null for the window's own. The
// same keys pressed in Zero's page do the same for its project.
export function useBrowserLocation(enabled: boolean, locate: (project: string | null) => void) {
  const latest = useRef(locate)
  useEffect(() => {
    latest.current = locate
  }, [locate])
  useEffect(() => {
    if (!enabled) return
    function onCommand(event: Event) {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (typeof detail !== "object" || detail === null || !("command" in detail) || detail.command !== "location") return
      const target = "project" in detail && typeof detail.project === "string" && detail.project ? detail.project : null
      event.preventDefault()
      latest.current(target)
    }
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.code !== "KeyL" || event.altKey || event.shiftKey) return
      if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return
      event.preventDefault()
      latest.current(null)
    }
    window.addEventListener("zero:browser-command", onCommand)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("zero:browser-command", onCommand)
      window.removeEventListener("keydown", onKey)
    }
  }, [enabled])
}
