import assert from "node:assert/strict"
import test from "node:test"

import { fenceHighlightBatch } from "./preview-fences.ts"

test("fence batches preserve every row while bounding rows and markup per update", () => {
  const rows = Array.from({ length: 450 }, (_, index) => `<span class="hl-number">${index}</span>`)
  const batches: string[] = []
  let offset = 0
  while (offset < rows.length) {
    const batch = fenceHighlightBatch(rows, offset)
    assert.ok(batch.next > offset)
    assert.ok(batch.next - offset <= 100)
    assert.ok(batch.html.length <= 16_384)
    batches.push(batch.html)
    offset = batch.next
  }
  assert.equal(batches.join("\n"), rows.join("\n"))
  const longRows = Array.from({ length: 10 }, () => "escaped ".repeat(800))
  assert.ok(fenceHighlightBatch(longRows, 0).next < 10)
  assert.equal(fenceHighlightBatch(["x".repeat(20_000)], 0).next, 1, "a single long row must not stall the queue")
})
