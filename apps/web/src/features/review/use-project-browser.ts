import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { desktopBridge, type BrowserAction, type BrowserState } from "../../lib/desktop-bridge.ts"
import { parseRecent, recentStorageKey, rememberURL, type RecentURLs } from "./review-model.ts"

function readRecent(): RecentURLs {
  try {
    return parseRecent(JSON.parse(window.localStorage.getItem(recentStorageKey) ?? "null"))
  } catch {
    // Unavailable or malformed storage remembers nothing.
    return {}
  }
}

function writeRecent(recent: RecentURLs) {
  try {
    window.localStorage.setItem(recentStorageKey, JSON.stringify(recent))
  } catch {
    // The page still opens; it is only not remembered.
  }
}

// A request to focus another project's address field waits here while the
// window switches to that project; its workspace takes it once mounted.
let pendingFocus: string | null = null

// ProjectBrowser is a project's Browser tab's link to its guest window
// (decision 0181).
export interface ProjectBrowser {
  // available says this window can open a guest window: the desktop app's
  // local window.
  available: boolean
  // state is the guest window's, or null without one.
  state: BrowserState | null
  // recent is the project's pages, most recent first; the first is the last
  // page reviewed, which a closed window reopens.
  recent: readonly string[]
  open(url: string): void
  act(action: BrowserAction): void
  // requestFocus gives the address field the keyboard, once the tab has
  // registered it with registerField.
  requestFocus(): void
  registerField(focus: (() => void) | null): void
}

// useProjectBrowser follows a project's guest window: it reads the window's
// state on mount, when the app announces a change (zero:browser, whose
// detail is the project), and when this window regains focus, which
// catches a page's own history moves.
export function useProjectBrowser(project: string): ProjectBrowser {
  const bridge = useMemo(() => desktopBridge(), [])
  const openReview = bridge?.openReview ?? null
  const browserState = bridge?.browserState ?? null
  const browserAction = bridge?.browserAction ?? null
  const available = Boolean(openReview && browserState && browserAction)
  const [state, setState] = useState<BrowserState | null>(null)
  const [recent, setRecent] = useState<readonly string[]>(() => readRecent()[project] ?? [])
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
    if (!available) return
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
  }, [available, project, refresh])

  const open = useCallback((url: string) => {
    if (!openReview) return
    const remembered = rememberURL(readRecent(), project, url)
    writeRecent(remembered)
    setRecent(remembered[project] ?? [])
    openReview(project, url)
  }, [openReview, project])

  const act = useCallback((action: BrowserAction) => {
    browserAction?.(project, action)
  }, [browserAction, project])

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

  return { available, state, recent, open, act, requestFocus, registerField }
}

// focusBrowserLater asks the workspace of project, once it mounts, to focus
// its Browser tab's address field.
export function focusBrowserLater(project: string) {
  pendingFocus = project
}

// useDesktopBrowserFocus answers the desktop app's requests for the address
// field: Review › Review URL… (zero:review-url, for this window's project)
// and a guest window's Open Location… (zero:browser-focus, whose detail is
// the guest's project).
export function useDesktopBrowserFocus(focus: (project: string | null) => void) {
  const latest = useRef(focus)
  useEffect(() => {
    latest.current = focus
  }, [focus])
  useEffect(() => {
    function onReviewURL(event: Event) {
      event.preventDefault()
      latest.current(null)
    }
    function onFocus(event: Event) {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string" || !event.detail) return
      event.preventDefault()
      latest.current(event.detail)
    }
    window.addEventListener("zero:review-url", onReviewURL)
    window.addEventListener("zero:browser-focus", onFocus)
    return () => {
      window.removeEventListener("zero:review-url", onReviewURL)
      window.removeEventListener("zero:browser-focus", onFocus)
    }
  }, [])
}
