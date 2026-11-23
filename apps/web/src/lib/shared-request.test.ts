import assert from "node:assert/strict"
import test from "node:test"

import { isAbort } from "../api/http.ts"
import { sharedRequest } from "./shared-request.ts"

// deferred runs: each run waits until the test settles it.
function runs() {
  const started: { signal: AbortSignal; resolve(value: string): void; reject(error: Error): void }[] = []
  const run = (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    started.push({ signal, resolve, reject })
  })
  return { started, run }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error("expected a rejection")
}

test("concurrent callers share one request", async () => {
  const { started, run } = runs()
  const request = sharedRequest(run)
  const first = request()
  const second = request(new AbortController().signal)
  assert.equal(started.length, 1)
  started[0]?.resolve("projects")
  assert.deepEqual(await Promise.all([first, second]), ["projects", "projects"])
})

test("a request after the shared one settles runs again", async () => {
  const { started, run } = runs()
  const request = sharedRequest(run)
  const first = request()
  started[0]?.resolve("one")
  assert.equal(await first, "one")
  const second = request()
  assert.equal(started.length, 2)
  started[1]?.resolve("two")
  assert.equal(await second, "two")

  const failed = request()
  started[2]?.reject(new Error("unreachable"))
  assert.equal(await rejection(failed) instanceof Error, true)
  void request()
  assert.equal(started.length, 4)
})

test("a caller's abort rejects only that caller", async () => {
  const { started, run } = runs()
  const request = sharedRequest(run)
  const leaving = new AbortController()
  const left = request(leaving.signal)
  const staying = request(new AbortController().signal)
  leaving.abort()
  assert.equal(isAbort(await rejection(left)), true)
  assert.equal(started[0]?.signal.aborted, false)
  started[0]?.resolve("projects")
  assert.equal(await staying, "projects")
})

test("the request aborts once every caller has aborted", async () => {
  const { started, run } = runs()
  const request = sharedRequest(run)
  const one = new AbortController()
  const two = new AbortController()
  const first = request(one.signal)
  const second = request(two.signal)
  one.abort()
  assert.equal(started[0]?.signal.aborted, false)
  two.abort()
  assert.equal(started[0]?.signal.aborted, true)
  assert.equal(isAbort(await rejection(first)), true)
  assert.equal(isAbort(await rejection(second)), true)
  // The aborted request is not joined: the next caller starts afresh.
  void request()
  assert.equal(started.length, 2)
})

test("an already aborted caller starts nothing", async () => {
  const { started, run } = runs()
  const request = sharedRequest(run)
  const controller = new AbortController()
  controller.abort()
  assert.equal(isAbort(await rejection(request(controller.signal))), true)
  assert.equal(started.length, 0)
})
