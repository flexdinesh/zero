// Pure logic of the Browser tab's stage (decision 0184): the rectangle the
// desktop app draws the guest over. Zero's page is under the guest and
// cannot draw over it, so the stage decides when the guest shows, when its
// snapshot stands in for it, and which frames the app is told.

import type { BrowserFrame } from "../../lib/desktop-bridge.ts"

// StagePlan is who fills the stage: the guest itself; its snapshot, while
// one of Zero's overlays is open and would otherwise sit under it; or
// neither, when the stage holds no page.
export type StagePlan = "guest" | "covered" | "hidden"

// stagePlan decides who fills the stage. page says the stage holds the
// guest's page (not the empty or failed state); overlay that a layer of
// Zero's is open.
export function stagePlan(page: boolean, overlay: boolean): StagePlan {
  if (!page) return "hidden"
  return overlay ? "covered" : "guest"
}

// Box is an element's bounding box in CSS pixels of the viewport.
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

// frameOf is a box as the frame the app is told: whole CSS pixels, edges
// rounded together so a fractional layout never opens a gap; null for a box
// with no area, which shows nothing.
export function frameOf(box: Box): BrowserFrame | null {
  const x = Math.round(box.left)
  const y = Math.round(box.top)
  const width = Math.round(box.right) - x
  const height = Math.round(box.bottom) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

export function sameFrame(a: BrowserFrame | null, b: BrowserFrame | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

// FrameReporter tells the app where the guest shows, at most once per
// animation frame and only when the frame changed.
export interface FrameReporter {
  // want sets the frame to tell at the next animation frame; null hides
  // the guest.
  want(frame: BrowserFrame | null): void
  // close hides a guest still told to show, at once, and drops what waits:
  // the tab left the screen.
  close(): void
}

// frameReporter reports through send; schedule runs a callback at the next
// animation frame and returns its cancel.
export function frameReporter(send: (frame: BrowserFrame | null) => void, schedule: (run: () => void) => () => void): FrameReporter {
  // sent is undefined until the app has been told anything.
  let sent: BrowserFrame | null | undefined
  let wanted: BrowserFrame | null = null
  let cancel: (() => void) | null = null
  const flush = () => {
    cancel = null
    if (sent !== undefined && sameFrame(sent, wanted)) return
    sent = wanted
    send(wanted)
  }
  return {
    want(frame) {
      wanted = frame
      cancel ??= schedule(flush)
    },
    close() {
      cancel?.()
      cancel = null
      if (!sent) return
      sent = null
      send(null)
    },
  }
}

// snapshotURL is a base64 PNG as an image source.
export function snapshotURL(png: string): string {
  return `data:image/png;base64,${png}`
}
