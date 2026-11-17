import assert from "node:assert/strict"
import test from "node:test"

import { reviewCache } from "./review-cache.ts"

test("refresh replaces only its file and notifies its mounted consumers", () => {
  const cache = reviewCache<number>()
  cache.set("a", 1)
  cache.set("b", 1)
  const changes: string[] = []
  const unsubscribe = cache.subscribe("a", () => { changes.push("a") })
  cache.subscribe("b", () => { changes.push("b") })
  cache.set("a", 2)
  assert.equal(cache.get("a"), 2)
  assert.equal(cache.get("b"), 1)
  assert.deepEqual(changes, ["a"])
  unsubscribe()
  cache.set("a", 3)
  assert.deepEqual(changes, ["a"])
})

test("visited files survive beyond the former 30-file eviction boundary", () => {
  const cache = reviewCache<number>()
  for (let index = 0; index < 100; index++) cache.set(String(index), index)
  for (let index = 0; index < 100; index++) assert.equal(cache.get(String(index)), index)
})

test("a new review starts without data from a previous review", () => {
  const previous = reviewCache<number>()
  previous.set("a", 1)
  const next = reviewCache<number>()
  assert.equal(next.get("a"), null)
})
