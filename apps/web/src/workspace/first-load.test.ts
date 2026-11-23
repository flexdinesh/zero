import assert from "node:assert/strict"
import test from "node:test"

import { firstPaintBudget, loadsWorkspace, remainingWait, settleWithin } from "./first-load.ts"

test("the remaining wait spends the budget from the loader's start", () => {
  assert.equal(remainingWait(1_000, 1_000, firstPaintBudget), 500)
  assert.equal(remainingWait(1_000, 1_320, firstPaintBudget), 180)
  assert.equal(remainingWait(1_000, 1_500, firstPaintBudget), 0)
  assert.equal(remainingWait(1_000, 9_000, firstPaintBudget), 0)
  // A clock that went back spends nothing.
  assert.equal(remainingWait(1_000, 900, firstPaintBudget), 500)
})

test("only routes that show a workspace draw its frame", () => {
  assert.equal(loadsWorkspace("/", {}), false)
  assert.equal(loadsWorkspace("/", { project: "" }), false)
  assert.equal(loadsWorkspace("/", { welcome: 1 }), false)
  assert.equal(loadsWorkspace("/", { project: "/work/zero" }), true)
  assert.equal(loadsWorkspace("/", { repo: "github.com/me/zero" }), true)
  assert.equal(loadsWorkspace("/view", {}), true)
  assert.equal(loadsWorkspace("/view", { path: "README.md" }), true)
  assert.equal(loadsWorkspace("/composer", {}), false)
})

test("settleWithin reports a settled promise, a timeout, or an abort", async () => {
  assert.equal(await settleWithin(Promise.resolve("tree"), 50), true)
  assert.equal(await settleWithin(Promise.reject(new Error("failed")), 50), true)
  assert.equal(await settleWithin(new Promise(() => {}), 5), false)
  const controller = new AbortController()
  const waiting = settleWithin(new Promise(() => {}), 60_000, controller.signal)
  controller.abort()
  assert.equal(await waiting, false)
})
