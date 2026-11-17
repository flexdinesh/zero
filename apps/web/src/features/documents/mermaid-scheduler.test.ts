import assert from "node:assert/strict"
import test from "node:test"

import { createMermaidWidthScheduler, scheduleMermaidTask } from "./mermaid-scheduler.ts"

test("first positive rounded width compiles in a separate task without a settle delay", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const widths: number[] = []
  const scheduler = createMermaidWidthScheduler((width) => widths.push(width))
  scheduler.resize(0)
  scheduler.resize(0.4)
  context.mock.timers.tick(500)
  assert.deepEqual(widths, [])

  scheduler.resize(400.4)
  assert.deepEqual(widths, [])
  context.mock.timers.tick(0)
  assert.deepEqual(widths, [400])
})

test("width motion replaces pending work and compiles the final width after 150ms quiet", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const widths: number[] = []
  const scheduler = createMermaidWidthScheduler((width) => widths.push(width))
  scheduler.resize(700)
  context.mock.timers.tick(0)

  for (const width of [620, 520, 420, 320]) {
    scheduler.resize(width)
    context.mock.timers.tick(50)
    assert.deepEqual(widths, [700])
  }
  context.mock.timers.tick(99)
  assert.deepEqual(widths, [700])
  context.mock.timers.tick(1)
  assert.deepEqual(widths, [700, 320])
})

test("unchanged rounded observations neither compile again nor postpone pending work", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const widths: number[] = []
  const scheduler = createMermaidWidthScheduler((width) => widths.push(width))
  scheduler.resize(400)
  context.mock.timers.tick(0)
  scheduler.resize(400.4)
  context.mock.timers.tick(200)
  assert.deepEqual(widths, [400])

  scheduler.resize(300)
  context.mock.timers.tick(100)
  scheduler.resize(300.4)
  context.mock.timers.tick(50)
  assert.deepEqual(widths, [400, 300])
})

test("returning to the displayed width cancels an unnecessary layout", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const widths: number[] = []
  const scheduler = createMermaidWidthScheduler((width) => widths.push(width))
  scheduler.resize(400)
  context.mock.timers.tick(0)
  scheduler.resize(300)
  context.mock.timers.tick(100)
  scheduler.resize(400)
  context.mock.timers.tick(200)
  assert.deepEqual(widths, [400])
})

test("zero width cancels pending layout and a later positive width still settles", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const widths: number[] = []
  const scheduler = createMermaidWidthScheduler((width) => widths.push(width))
  scheduler.resize(400)
  context.mock.timers.tick(0)
  scheduler.resize(300)
  scheduler.resize(0)
  context.mock.timers.tick(200)
  assert.deepEqual(widths, [400])

  scheduler.resize(300)
  context.mock.timers.tick(149)
  assert.deepEqual(widths, [400])
  context.mock.timers.tick(1)
  assert.deepEqual(widths, [400, 300])
})

test("before the initial task runs, only the latest positive width compiles", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const widths: number[] = []
  const scheduler = createMermaidWidthScheduler((width) => widths.push(width))
  scheduler.resize(700)
  scheduler.resize(600)
  scheduler.resize(0)
  context.mock.timers.tick(0)
  assert.deepEqual(widths, [])

  scheduler.resize(500)
  scheduler.resize(400)
  context.mock.timers.tick(0)
  assert.deepEqual(widths, [400])
})

test("disposing obsolete source work prevents compilation and permits a fresh owner", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const widths: number[] = []
  const obsolete = createMermaidWidthScheduler((width) => widths.push(width))
  obsolete.resize(700)
  obsolete.dispose()
  obsolete.resize(600)
  const current = createMermaidWidthScheduler((width) => widths.push(width))
  current.resize(400)
  context.mock.timers.tick(0)
  assert.deepEqual(widths, [400])

  current.resize(300)
  current.dispose()
  context.mock.timers.tick(200)
  assert.deepEqual(widths, [400])
})

test("independent compilation tasks can be cancelled separately", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const completed: string[] = []
  const cancelInline = scheduleMermaidTask(() => completed.push("inline"))
  scheduleMermaidTask(() => completed.push("expanded"))
  assert.deepEqual(completed, [])
  cancelInline()
  context.mock.timers.tick(0)
  assert.deepEqual(completed, ["expanded"])
})
