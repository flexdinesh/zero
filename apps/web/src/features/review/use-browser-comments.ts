import type { Feedback } from "@zero/contracts"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { desktopBridge, hostsComments } from "../../lib/desktop-bridge.ts"
import { pagePin, pageThreads, parsePinsHidden, pinsShown, pinsStorageKey, withPinsShown, type PageThread, type PinsHidden } from "./browser-comments.ts"
import type { ProjectBrowser } from "./use-project-browser.ts"

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
// commentKeys is the app's Comment accelerator, which works while the
// guest's page has the keyboard (decision 0184). The page never handles
// the keys itself.
export const commentKeys = mac ? "⇧⌘C" : "Ctrl+Shift+C"

function readPinsHidden(): PinsHidden {
  try {
    return parsePinsHidden(JSON.parse(window.localStorage.getItem(pinsStorageKey) ?? "null"))
  } catch {
    // Unavailable or malformed storage shows every project's pins.
    return []
  }
}

function writePinsHidden(hidden: PinsHidden) {
  try {
    window.localStorage.setItem(pinsStorageKey, JSON.stringify(hidden))
  } catch {
    // The choice still holds for this page.
  }
}

// BrowserComments is the comments on the page a project's Browser shows
// (decision 0184).
export interface BrowserComments {
  // available says this window's Browser takes comments: the desktop app
  // offers comment mode and pins.
  available: boolean
  // url is the address that shows, "" without a page.
  url: string
  // threads are the visual threads of that page: open, then closed.
  threads: readonly PageThread[]
  // pins says whether the page shows its pins; remembered per project.
  pins: boolean
  setPins(shown: boolean): void
}

interface BrowserCommentsOptions {
  project: string
  browser: ProjectBrowser
  // feedback is the feedback comments join: the checkout's branch's.
  feedback: Feedback | null
  // reread reads the feedback again.
  reread(): void
  // openThread opens a thread's screen tab.
  openThread(thread: number): void
}

// useBrowserComments keeps the guest's pins in step with the feedback: it
// tells the app the pins of the page that shows whenever the threads, the
// guest's address, or the pins toggle change, and once more after the
// composer sent a comment (zero:browser-commented), having asked for the
// feedback again. A click on a pin (zero:browser-pin) opens its thread.
export function useBrowserComments({ browser, feedback, openThread, project, reread }: BrowserCommentsOptions): BrowserComments {
  const bridge = useMemo(() => desktopBridge(), [])
  const available = hostsComments(bridge)
  const sendPins = available ? bridge?.browserPins ?? null : null
  const [hidden, setHidden] = useState(readPinsHidden)
  const pins = pinsShown(hidden, project)
  const url = browser.state?.url ?? ""
  const hasGuest = browser.state !== null
  const all = feedback?.threads
  const threads = useMemo(() => all ? pageThreads(all, url) : [], [all, url])
  // commented counts the comments the composer sent, so pins go again.
  const [commented, setCommented] = useState(0)
  const sent = useRef("")

  useEffect(() => {
    if (!sendPins || !hasGuest) {
      sent.current = ""
      return
    }
    const list = threads.map(pagePin)
    const signature = JSON.stringify([url, pins, commented, list])
    if (signature === sent.current) return
    sent.current = signature
    sendPins(project, list, pins)
  }, [commented, hasGuest, pins, project, sendPins, threads, url])

  const latest = useRef({ openThread, reread })
  useEffect(() => {
    latest.current = { openThread, reread }
  }, [openThread, reread])

  useEffect(() => {
    if (!available) return
    function onCommented(event: Event) {
      if (!(event instanceof CustomEvent) || event.detail !== project) return
      latest.current.reread()
      setCommented((count) => count + 1)
    }
    function onPin(event: Event) {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (typeof detail !== "object" || detail === null || !("project" in detail) || detail.project !== project) return
      if ("thread" in detail && typeof detail.thread === "number" && Number.isSafeInteger(detail.thread) && detail.thread > 0) {
        latest.current.openThread(detail.thread)
      }
    }
    window.addEventListener("zero:browser-commented", onCommented)
    window.addEventListener("zero:browser-pin", onPin)
    return () => {
      window.removeEventListener("zero:browser-commented", onCommented)
      window.removeEventListener("zero:browser-pin", onPin)
    }
  }, [available, project])

  const setPins = useCallback((shown: boolean) => {
    const next = withPinsShown(readPinsHidden(), project, shown)
    writePinsHidden(next)
    setHidden(next)
  }, [project])

  return useMemo(() => ({ available, url, threads, pins, setPins }), [available, pins, setPins, threads, url])
}
