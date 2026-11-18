import assert from "node:assert/strict"
import { test } from "node:test"

import { rowAt, rowOffsets, windowedIndexes } from "./row-window.ts"

test("the first row through an offset accounts for variable and fractional heights", () => {
  const heights = [24.5, 120, 24.5]
  const offsets = rowOffsets(heights.length, (index) => heights[index] ?? 0)
  assert.deepEqual(offsets, [0, 24.5, 144.5, 169])
  assert.equal(rowAt(offsets, 24.49), 0)
  assert.equal(rowAt(offsets, 24.5), 1)
  assert.equal(rowAt(offsets, 144.5), 2)
})

test("the window intersects one viewport of overscan and retains distant focus in list order", () => {
  const offsets = rowOffsets(100, () => 20)
  assert.deepEqual(windowedIndexes(offsets, 300, 60, [90, 1, 15, 1]),
    [1, 12, 13, 14, 15, 16, 17, 18, 19, 20, 90])
  assert.deepEqual(windowedIndexes(offsets, 2020, 20, [3]), [3])
  assert.deepEqual(windowedIndexes(offsets, -40, 20, []), [])
  assert.deepEqual(windowedIndexes(offsets, 1995, 20, []), [98, 99])
})
