import assert from "node:assert/strict"
import test from "node:test"

import type { BrowserFrame } from "../../lib/desktop-bridge.ts"
import { frameOf, frameReporter, sameFrame, snapshotURL, stagePlan } from "./browser-stage.ts"

test("the guest fills the stage only when it holds a page and no overlay is open", () => {
  assert.equal(stagePlan(true, false), "guest")
  assert.equal(stagePlan(true, true), "covered")
  assert.equal(stagePlan(false, false), "hidden")
  // Without a page there is nothing to snapshot.
  assert.equal(stagePlan(false, true), "hidden")
})

test("frameOf rounds a box's edges to whole pixels and drops one with no area", () => {
  assert.deepEqual(frameOf({ left: 280, top: 64, right: 1280, bottom: 772 }), { x: 280, y: 64, width: 1000, height: 708 })
  assert.deepEqual(frameOf({ left: 280.4, top: 63.6, right: 1279.6, bottom: 771.5 }), { x: 280, y: 64, width: 1000, height: 708 })
  assert.equal(frameOf({ left: 10, top: 10, right: 10.3, bottom: 400 }), null)
  assert.equal(frameOf({ left: 0, top: 0, right: 0, bottom: 0 }), null)
})

test("sameFrame compares by value, and null only with null", () => {
  const frame = { x: 1, y: 2, width: 3, height: 4 }
  assert.equal(sameFrame(frame, { ...frame }), true)
  assert.equal(sameFrame(frame, { ...frame, width: 5 }), false)
  assert.equal(sameFrame(frame, null), false)
  assert.equal(sameFrame(null, null), true)
})

// A stand-in for animation frames: tick runs what was scheduled.
function frames() {
  let pending: (() => void) | null = null
  let cancelled = 0
  return {
    schedule(run: () => void) {
      pending = run
      return () => {
        pending = null
        cancelled++
      }
    },
    tick() {
      const run = pending
      pending = null
      run?.()
    },
    get waiting() { return pending !== null },
    get cancelled() { return cancelled },
  }
}

const a: BrowserFrame = { x: 280, y: 64, width: 1000, height: 708 }
const b: BrowserFrame = { x: 320, y: 64, width: 960, height: 708 }

test("a reporter tells the newest frame once per animation frame", () => {
  const sent: (BrowserFrame | null)[] = []
  const clock = frames()
  const reporter = frameReporter((frame) => sent.push(frame), clock.schedule)
  reporter.want(a)
  reporter.want(b)
  reporter.want(a)
  assert.deepEqual(sent, [])
  clock.tick()
  assert.deepEqual(sent, [a])
  assert.equal(clock.waiting, false)
})

test("a reporter stays quiet while the frame is the one it last told", () => {
  const sent: (BrowserFrame | null)[] = []
  const clock = frames()
  const reporter = frameReporter((frame) => sent.push(frame), clock.schedule)
  reporter.want(a)
  clock.tick()
  reporter.want({ ...a })
  clock.tick()
  reporter.want(b)
  clock.tick()
  reporter.want(null)
  clock.tick()
  reporter.want(null)
  clock.tick()
  assert.deepEqual(sent, [a, b, null])
})

test("the first report tells the app even a hidden guest", () => {
  const sent: (BrowserFrame | null)[] = []
  const clock = frames()
  const reporter = frameReporter((frame) => sent.push(frame), clock.schedule)
  reporter.want(null)
  clock.tick()
  assert.deepEqual(sent, [null])
})

test("closing hides a shown guest at once and drops the frame that waited", () => {
  const sent: (BrowserFrame | null)[] = []
  const clock = frames()
  const reporter = frameReporter((frame) => sent.push(frame), clock.schedule)
  reporter.want(a)
  clock.tick()
  reporter.want(b)
  reporter.close()
  assert.deepEqual(sent, [a, null])
  assert.equal(clock.cancelled, 1)
  clock.tick()
  assert.deepEqual(sent, [a, null])
  // Closing a hidden or untold guest says nothing.
  reporter.close()
  const untold = frameReporter((frame) => sent.push(frame), clock.schedule)
  untold.want(a)
  untold.close()
  assert.deepEqual(sent, [a, null])
})

test("a reporter shows the guest again after closing", () => {
  const sent: (BrowserFrame | null)[] = []
  const clock = frames()
  const reporter = frameReporter((frame) => sent.push(frame), clock.schedule)
  reporter.want(a)
  clock.tick()
  reporter.close()
  reporter.want(a)
  clock.tick()
  assert.deepEqual(sent, [a, null, a])
})

test("snapshotURL is the PNG as an image source", () => {
  assert.equal(snapshotURL("iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=")
})
