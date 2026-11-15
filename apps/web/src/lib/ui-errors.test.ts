import assert from "node:assert/strict"
import test from "node:test"

import { describeThrown, requestPath, UIErrorLog } from "./ui-errors.ts"

test("the log keeps only the newest entries, oldest first", () => {
  const log = new UIErrorLog(3)
  for (const message of ["a", "b", "c", "d", "e"]) log.record(message, new Date(0))
  assert.deepEqual(log.entries().map((entry) => entry.message), ["c", "d", "e"])
  assert.equal(log.entries()[0]?.at, "1970-01-01T00:00:00.000Z")
})

test("blank messages are not recorded", () => {
  const log = new UIErrorLog()
  log.record("   ")
  assert.equal(log.entries().length, 0)
})

test("entries are a copy", () => {
  const log = new UIErrorLog()
  log.record("a")
  const entries = log.entries()
  log.record("b")
  assert.equal(entries.length, 1)
})

test("requestPath drops the query, which names files", () => {
  assert.equal(requestPath("/api/page?project=/home/u/x&path=a.go"), "/api/page")
  assert.equal(requestPath("/api/projects"), "/api/projects")
  assert.equal(requestPath("/api/x#y"), "/api/x")
})

test("describeThrown phrases errors, strings, and other values", () => {
  const error = new TypeError("bad")
  error.stack = undefined
  assert.equal(describeThrown(error), "TypeError: bad")
  assert.equal(describeThrown("text"), "text")
  assert.equal(describeThrown({ a: 1 }), "{\"a\":1}")
})
