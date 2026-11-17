import assert from "node:assert/strict"
import test from "node:test"

import { createPinRender, createReviewRenderHandler, pinLimitMs, pinQuietMs, pinSettled, pinWait } from "./review-pin.ts"

test("a pin holds while the pinned diff has not shown", () => {
  const clock = { pinnedAt: 0, changedAt: 0, shows: false }
  assert.equal(pinSettled(pinQuietMs * 2, clock), false)
  assert.equal(pinWait(pinQuietMs * 2, clock), pinLimitMs - pinQuietMs * 2)
})

test("a pin settles once the shown diff and its neighbors keep their size", () => {
  const clock = { pinnedAt: 0, changedAt: 500, shows: true }
  assert.equal(pinSettled(500 + pinQuietMs - 1, clock), false)
  assert.equal(pinWait(500 + pinQuietMs - 1, clock), 1)
  assert.equal(pinSettled(500 + pinQuietMs, clock), true)
  assert.equal(pinWait(500 + pinQuietMs, clock), 0)
})

test("content that keeps changing size holds a pin only up to the limit", () => {
  const clock = { pinnedAt: 0, changedAt: pinLimitMs - 10, shows: true }
  assert.equal(pinSettled(pinLimitMs - 1, clock), false)
  assert.equal(pinWait(pinLimitMs - 1, clock), 1)
  assert.equal(pinSettled(pinLimitMs, clock), true)
  assert.equal(pinSettled(pinLimitMs, { ...clock, shows: false }), true)
})

test("a resident diff's render completion restores its active reveal from final placement", () => {
  const callbacks = new Map<number, () => void>()
  let next = 0
  let lineTop = 250
  let scrollTop = 220
  const pin = createPinRender(() => { scrollTop = lineTop - 30 }, {
    request(callback) {
      const frame = ++next
      callbacks.set(frame, callback)
      return frame
    },
    cancel(frame) { callbacks.delete(frame) },
  })
  const instance = {}
  let received: unknown = instance
  const onPostRender = createReviewRenderHandler<typeof instance>((next) => { received = next }, pin.rendered)
  // A renderer's transient layout clamps scrolling before its final layout.
  scrollTop = 0
  onPostRender(null, instance, "update")
  lineTop = 350
  onPostRender(null, instance, "update")
  assert.equal(callbacks.size, 1)
  assert.equal(received, instance)
  assert.equal(scrollTop, 0)
  for (const callback of callbacks.values()) callback()
  assert.ok(lineTop >= scrollTop && lineTop + 22 <= scrollTop + 100)
})

test("input or teardown releases a reveal before an already queued render correction", () => {
  const callbacks: (() => void)[] = []
  let scrollTop = 220
  const pin = createPinRender(() => { scrollTop = 320 }, {
    request(callback) { callbacks.push(callback); return 1 },
    // A queued callback can already be running when cancellation arrives.
    cancel() {},
  })
  const onPostRender = createReviewRenderHandler<object>(() => {}, pin.rendered)
  onPostRender(null, {}, "mount")
  pin.release()
  scrollTop = 80
  for (const callback of callbacks) callback()
  onPostRender(null, {}, "update")
  for (const callback of callbacks) callback()
  assert.equal(scrollTop, 80)
})

test("row virtualization retains its resident instance without scheduling a reveal", () => {
  const instance = {}
  let received: unknown = null
  let scrollTop = 80
  const onPostRender = createReviewRenderHandler<typeof instance>((next) => { received = next }, () => { scrollTop = 320 })
  onPostRender(null, instance, "unmount")
  assert.equal(received, instance)
  assert.equal(scrollTop, 80)
})
