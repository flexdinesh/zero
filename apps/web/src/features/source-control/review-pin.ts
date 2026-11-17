import type { FileDiffOptions } from "@pierre/diffs"

// A review pins a revealed file while the diffs around it load and grow
// (decisions 0034, 0135). Input lets go of the pin, but WebKit sends no
// input event for a scrollbar drag or a kinetic scroll, so the pin also ends
// on its own once the reveal settles: nothing pulls the pane back after it.

// pinQuietMs is how long the content must keep its size, once the pinned
// file's diff shows, for the reveal to settle.
export const pinQuietMs = 300
// pinLimitMs is the longest a pin holds, whatever still loads.
export const pinLimitMs = 3_000

// PinClock is when a pin began, when the content last changed size or the
// pinned file's diff showed, and whether that diff shows.
export interface PinClock {
  pinnedAt: number
  changedAt: number
  shows: boolean
}

// pinSettled tells whether a pin ends on its own at now.
export function pinSettled(now: number, clock: PinClock): boolean {
  return now - clock.pinnedAt >= pinLimitMs || (clock.shows && now - clock.changedAt >= pinQuietMs)
}

// pinWait is how long until a pin with no further changes settles.
export function pinWait(now: number, clock: PinClock): number {
  const limit = clock.pinnedAt + pinLimitMs - now
  const quiet = clock.shows ? clock.changedAt + pinQuietMs - now : limit
  return Math.max(0, Math.min(limit, quiet))
}

interface PinFrames {
  request(callback: () => void): number
  cancel(frame: number): void
}

type RenderPhase = Parameters<NonNullable<FileDiffOptions<undefined, undefined>["onPostRender"]>>[2]

// Row virtualization retains the instance. Only completed row renders notify
// the active reveal; React teardown owns removing the resident registration.
export function createReviewRenderHandler<Instance>(receiveInstance: (instance: Instance) => void, rendered: () => void) {
  return (_node: unknown, instance: Instance, phase: RenderPhase) => {
    receiveInstance(instance)
    if (phase !== "unmount") rendered()
  }
}

// A resident diff can render again without changing its registration or its
// container's size. Correct the active reveal after that render, outside
// Pierre's batched layout work. Release also fences a callback already queued.
export function createPinRender(pin: () => void, frames: PinFrames) {
  let active = true
  let frame: number | null = null
  return {
    rendered() {
      if (!active || frame !== null) return
      frame = frames.request(() => {
        frame = null
        if (active) pin()
      })
    },
    release() {
      active = false
      if (frame !== null) frames.cancel(frame)
      frame = null
    },
  }
}
