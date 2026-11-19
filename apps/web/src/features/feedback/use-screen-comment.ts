import { useEffect, useRef } from "react"

import { desktopBridge, type ScreenCapture, type ScreenHits } from "../../lib/desktop-bridge.ts"
import { decodeBase64PNG } from "./screen-image.ts"
import type { ScreenPage } from "./visual-model.ts"

// ScreenSource is what a screen comment is about (decisions 0176, 0180): the
// frozen image, the page it froze (null for a pasted or dropped image), the
// hit map recorded with it (null without one), and whether the page moved
// while it was captured.
export interface ScreenSource {
  blob: Blob
  page: ScreenPage | null
  hits: ScreenHits | null
  drift: boolean
}

// pastedSource is a pasted or dropped image: nothing known but its pixels.
export function pastedSource(blob: Blob): ScreenSource {
  return { blob, page: null, hits: null, drift: false }
}

// A capture waits here while the page switches to its project, or while
// no workspace is mounted to take it; the workspace mounted for its project
// takes it.
let held: { project: string; source: ScreenSource } | null = null

interface Receiver {
  project: string
  open(source: ScreenSource): void
  switchProject(project: string): void
}

let receiver: Receiver | null = null

function take(project: string): ScreenSource | null {
  if (held?.project !== project) return null
  const { source } = held
  held = null
  return source
}

function deliver(capture: ScreenCapture) {
  const blob = decodeBase64PNG(capture.png)
  if (!blob) return
  const source: ScreenSource = { blob, page: capture.page, hits: capture.hits, drift: capture.drift }
  if (receiver?.project === capture.project) {
    receiver.open(source)
    return
  }
  held = { project: capture.project, source }
  receiver?.switchProject(capture.project)
}

// receive asks the bridge for a waiting capture; it reports whether the
// desktop app offers captures at all.
function receive(): boolean {
  const read = desktopBridge()?.screenCapture
  if (!read) return false
  void read().then((capture) => {
    if (capture) deliver(capture)
  })
  return true
}

// useDesktopScreenComment opens the composer for the desktop app's Comment
// on Screen: the app dispatches zero:screen-comment on an open window when
// a capture waits, or loads the project's page, which asks once it mounts;
// the bridge hands each capture out once. A capture of another project
// switches to it first, as Review URL does.
export function useDesktopScreenComment(project: string, open: (source: ScreenSource) => void, switchProject: (project: string) => void) {
  const latest = useRef({ open, switchProject })
  useEffect(() => {
    latest.current = { open, switchProject }
  }, [open, switchProject])

  useEffect(() => {
    const own: Receiver = {
      project,
      open: (source) => latest.current.open(source),
      switchProject: (next) => latest.current.switchProject(next),
    }
    receiver = own
    function onCapture(event: Event) {
      if (receive()) event.preventDefault()
    }
    const waiting = take(project)
    if (waiting) own.open(waiting)
    else receive()
    window.addEventListener("zero:screen-comment", onCapture)
    return () => {
      if (receiver === own) receiver = null
      window.removeEventListener("zero:screen-comment", onCapture)
    }
  }, [project])
}
