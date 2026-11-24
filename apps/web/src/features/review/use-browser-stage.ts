import { useEffect, useMemo, useState } from "react"

import { desktopBridge } from "../../lib/desktop-bridge.ts"
import { useOverlayOpen } from "../../lib/overlay-layers.ts"
import { frameOf, frameReporter, snapshotURL, stagePlan } from "./browser-stage.ts"

function nextFrame(run: () => void): () => void {
  const id = requestAnimationFrame(run)
  return () => cancelAnimationFrame(id)
}

// BrowserStage is the Browser tab's stage as its hook keeps it.
export interface BrowserStage {
  // attach takes the stage element.
  attach(element: HTMLDivElement | null): void
  // cover is the guest's snapshot standing in for it while an overlay of
  // Zero's is open; null when the guest shows, no snapshot came, or the
  // stage holds no page.
  cover: string | null
}

// useBrowserStage keeps the desktop app told where the guest of project's
// Browser tab tab shows (decisions 0184, 0195): the stage's rectangle while
// the stage holds the page and no overlay of Zero's is open, measured again
// whenever the stage resizes or the window does; nothing (hidden) otherwise
// and once the tab leaves the screen. While an overlay is open the guest's snapshot fills the stage: the
// image goes in first, then the guest hides, and coming back the guest shows
// first and the image leaves a frame later.
export function useBrowserStage(project: string, tab: number, page: boolean): BrowserStage {
  const bridge = useMemo(() => desktopBridge(), [])
  const tell = bridge?.browserFrame ?? null
  const snapshot = bridge?.browserSnapshot ?? null
  const plan = stagePlan(page, useOverlayOpen())
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  // snap is the snapshot an open overlay asked for, once it answered; src is
  // null when the app had none.
  const [snap, setSnap] = useState<{ src: string | null } | null>(null)

  const reporter = useMemo(() => tell ? frameReporter((frame) => tell(project, frame, tab), nextFrame) : null, [project, tab, tell])
  useEffect(() => () => reporter?.close(), [reporter])

  useEffect(() => {
    if (!reporter || plan === "covered") return
    if (plan === "hidden" || !element) {
      reporter.want(null)
      return
    }
    const measure = () => reporter.want(frameOf(element.getBoundingClientRect()))
    measure()
    // The stage fills what the sidebar, the bars above it, and the window
    // leave: any of them moving it resizes it too.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [element, plan, reporter])

  useEffect(() => {
    if (plan !== "covered" || !snapshot) return
    let waiting = true
    void snapshot(project, tab).then((png) => {
      // An overlay that closed meanwhile left the guest showing. A guest
      // already hidden has no frame to give: the image it gave last stays.
      if (waiting) setSnap((current) => png ? { src: snapshotURL(png) } : current ?? { src: null })
    })
    return () => {
      waiting = false
    }
  }, [plan, project, snapshot, tab])

  // Coming back, the guest shows first and the image leaves a frame after
  // it; an overlay that opens before then keeps the image.
  useEffect(() => {
    if (plan === "covered" || !snap) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSnap(null))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [plan, snap])

  // The snapshot is in the stage before the guest hides.
  useEffect(() => {
    if (plan === "covered" && snap) reporter?.want(null)
  }, [plan, reporter, snap])

  return { attach: setElement, cover: plan === "hidden" ? null : snap?.src ?? null }
}
