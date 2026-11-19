import assert from "node:assert/strict"
import test from "node:test"

import type { LineDiff } from "@zero/contracts"
import { diffFindRows, rowsInLines } from "./diff-find-rows.ts"

// Old: a b c d e f g; new: a b C d e f g h. One hunk changes line 3 with one
// line of context; gaps hold line 1 before it and lines 5-7 after it.
const oldLines = ["a\n", "b\n", "c\n", "d\n", "e\n", "f\n", "g\n"]
const newLines = ["a\n", "b\n", "C\n", "d\n", "e\n", "f\n", "g\n", "h"]
const lineDiff: LineDiff = {
  ignoreWhitespace: false,
  additions: 2,
  deletions: 1,
  hunks: [{
    oldStart: 2, oldCount: 3, newStart: 2, newCount: 3, additions: 1, deletions: 1,
    blocks: [
      { kind: "context", oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
      { kind: "change", oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 },
      { kind: "context", oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 },
    ],
  }, {
    oldStart: 8, oldCount: 0, newStart: 8, newCount: 1, additions: 1, deletions: 0,
    blocks: [{ kind: "change", oldStart: 8, oldCount: 0, newStart: 8, newCount: 1 }],
  }],
  gaps: [{ hunk: 0, oldStart: 1, newStart: 1, lines: 1 }, { hunk: 1, oldStart: 5, newStart: 5, lines: 3 }],
}

const label = (rows: ReturnType<typeof diffFindRows>) => rows.map((row) => `${row.kind[0]}${row.oldLine}/${row.newLine}:${row.text}`)

test("rows follow unified order without line endings, collapsed gaps left out", () => {
  assert.deepEqual(label(diffFindRows(lineDiff, oldLines, newLines, () => false)), [
    "c2/2:b", "d3/0:c", "a0/3:C", "c4/4:d", "a0/8:h",
  ])
})

test("expanded gap lines join in place", () => {
  const shown = new Set([1, 5])
  assert.deepEqual(label(diffFindRows(lineDiff, oldLines, newLines, (line) => shown.has(line))), [
    "c1/1:a", "c2/2:b", "d3/0:c", "a0/3:C", "c4/4:d", "c5/5:e", "a0/8:h",
  ])
})

test("a line selection covers its rows on either side", () => {
  const rows = diffFindRows(lineDiff, oldLines, newLines, () => false)
  assert.deepEqual(rowsInLines(rows, "additions", 3, "additions", 4), { start: 2, end: 3 })
  assert.deepEqual(rowsInLines(rows, "deletions", 3, "additions", 3), { start: 1, end: 2 })
  assert.equal(rowsInLines(rows, "additions", 6, "additions", 7), null)
})
