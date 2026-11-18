import assert from "node:assert/strict"
import test from "node:test"

import type { WalkthroughSummary } from "@zero/contracts"
import { updateWalkthroughs, type WalkthroughsState } from "./walkthroughs-state.ts"

const tour: WalkthroughSummary = { id: "tour", title: "A tour", stepCount: 3, updatedAt: "2026-11-18T00:00:00Z" }
const followup: WalkthroughSummary = { id: "followup", title: "Next steps", stepCount: 2, updatedAt: "2026-11-17T00:00:00Z" }

function initial(): WalkthroughsState {
  return { result: null, error: "", loading: false }
}

function ready(result: WalkthroughSummary[]): WalkthroughsState {
  return { result, error: "", loading: false }
}

test("equal background reads preserve state and cached list identity, including empty lists", () => {
  for (const result of [[], [tour, followup]]) {
    const state = ready(result)
    const next = updateWalkthroughs(state, { kind: "success", result: structuredClone(result) })
    assert.equal(next, state)
    assert.equal(next.result, result)
  }
})

test("all summary fields, ordering, additions, and deletions update the list", () => {
  const state = ready([tour, followup])
  const cases: { name: string; result: WalkthroughSummary[] }[] = [
    { name: "id", result: [{ ...tour, id: "renamed" }, followup] },
    { name: "title", result: [{ ...tour, title: "A revised tour" }, followup] },
    { name: "stepCount", result: [{ ...tour, stepCount: 4 }, followup] },
    { name: "updatedAt", result: [{ ...tour, updatedAt: "2026-11-18T01:00:00Z" }, followup] },
    { name: "later entry", result: [tour, { ...followup, title: "Revised next steps" }] },
    { name: "ordering", result: [followup, tour] },
    { name: "addition", result: [tour, followup, { ...tour, id: "new" }] },
    { name: "deletion", result: [followup] },
    { name: "empty after deletion", result: [] },
  ]
  for (const { name, result } of cases) {
    const next = updateWalkthroughs(state, { kind: "success", result })
    assert.notEqual(next, state, name)
    assert.equal(next.result, result, name)
    assert.deepEqual(next, { result, error: "", loading: false }, name)
  }
})

test("initial and manual reads expose loading and settle even with unchanged results", () => {
  const loading = updateWalkthroughs(initial(), { kind: "start" })
  assert.deepEqual(loading, { result: null, error: "", loading: true })
  assert.equal(updateWalkthroughs(loading, { kind: "start" }), loading)
  const result: WalkthroughSummary[] = []
  const loaded = updateWalkthroughs(loading, { kind: "success", result })
  assert.deepEqual(loaded, { result, error: "", loading: false })
  assert.notEqual(loaded, loading)

  for (const cached of [[], [tour]]) {
    const state = ready(cached)
    const refreshing = updateWalkthroughs(state, { kind: "start" })
    assert.deepEqual(refreshing, { result: cached, error: "", loading: true })
    assert.equal(refreshing.result, cached)
    const refreshed = updateWalkthroughs(refreshing, { kind: "success", result: structuredClone(cached) })
    assert.deepEqual(refreshed, state)
    assert.equal(refreshed.result, cached)
    assert.notEqual(refreshed, refreshing)
  }
})

test("failures preserve cached results and repeated failures preserve state identity", () => {
  const error = "Couldn't read walkthroughs: the server didn't respond."
  for (const result of [null, [], [tour]]) {
    const loading: WalkthroughsState = { result, error: "", loading: true }
    const failed = updateWalkthroughs(loading, { kind: "error", error })
    assert.deepEqual(failed, { result, error, loading: false })
    assert.equal(failed.result, result)
    assert.equal(updateWalkthroughs(failed, { kind: "error", error }), failed)
    const changed = updateWalkthroughs(failed, { kind: "error", error: "A different failure" })
    assert.notEqual(changed, failed)
    assert.equal(changed.error, "A different failure")
    assert.equal(changed.result, result)
  }
})

test("background recovery clears errors while preserving unchanged cached lists", () => {
  for (const result of [[], [tour]]) {
    const failed: WalkthroughsState = { result, error: "Read failed", loading: false }
    const recovered = updateWalkthroughs(failed, { kind: "success", result: structuredClone(result) })
    assert.deepEqual(recovered, { result, error: "", loading: false })
    assert.equal(recovered.result, result)
    assert.notEqual(recovered, failed)
    assert.equal(updateWalkthroughs(recovered, { kind: "success", result: structuredClone(result) }), recovered)
  }
})

test("manual retries retain errors until success or failure settles loading", () => {
  const result = [tour]
  const failed: WalkthroughsState = { result, error: "Read failed", loading: false }
  const retrying = updateWalkthroughs(failed, { kind: "start" })
  assert.deepEqual(retrying, { result, error: "Read failed", loading: true })
  const failedAgain = updateWalkthroughs(retrying, { kind: "error", error: failed.error })
  assert.deepEqual(failedAgain, failed)
  assert.notEqual(failedAgain, retrying)
  const recovered = updateWalkthroughs(retrying, { kind: "success", result: structuredClone(result) })
  assert.deepEqual(recovered, { result, error: "", loading: false })
  assert.equal(recovered.result, result)
})
