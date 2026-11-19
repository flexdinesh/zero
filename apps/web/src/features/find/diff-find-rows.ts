import type { LineDiff } from "@zero/contracts"

// A review's find (decision 0172) matches the rows a diff shows, in unified
// order: each hunk's context, deleted, then added rows, plus the unchanged
// lines of collapsed gaps the reader expanded. A context row counts once,
// even when a split view shows it on both sides.

export type DiffFindRowKind = "context" | "deletion" | "addition"

// DiffFindRow is one shown row: its old and new line numbers (0 for a side
// without one) and its text.
export interface DiffFindRow {
  kind: DiffFindRowKind
  oldLine: number
  newLine: number
  text: string
}

// lineText is a side's line by number, without its line ending.
function lineText(lines: readonly string[], line: number): string {
  return (lines[line - 1] ?? "").replace(/\r?\n$/, "")
}

// diffFindRows lists the rows of a diff; shown reports whether a gap's line,
// by its new line number, is expanded.
export function diffFindRows(
  lineDiff: LineDiff, oldLines: readonly string[], newLines: readonly string[], shown: (newLine: number) => boolean,
): DiffFindRow[] {
  const rows: DiffFindRow[] = []
  const context = (oldLine: number, newLine: number) => rows.push({ kind: "context", oldLine, newLine, text: lineText(newLines, newLine) })
  const gapsBefore = (hunk: number) => {
    for (const gap of lineDiff.gaps) {
      if (gap.hunk !== hunk) continue
      for (let offset = 0; offset < gap.lines; offset++) {
        if (shown(gap.newStart + offset)) context(gap.oldStart + offset, gap.newStart + offset)
      }
    }
  }
  lineDiff.hunks.forEach((hunk, index) => {
    gapsBefore(index)
    for (const block of hunk.blocks) {
      if (block.kind === "context") {
        for (let offset = 0; offset < block.newCount; offset++) context(block.oldStart + offset, block.newStart + offset)
        continue
      }
      for (let offset = 0; offset < block.oldCount; offset++) {
        rows.push({ kind: "deletion", oldLine: block.oldStart + offset, newLine: 0, text: lineText(oldLines, block.oldStart + offset) })
      }
      for (let offset = 0; offset < block.newCount; offset++) {
        rows.push({ kind: "addition", oldLine: 0, newLine: block.newStart + offset, text: lineText(newLines, block.newStart + offset) })
      }
    }
  })
  gapsBefore(lineDiff.hunks.length)
  return rows
}

// rowsInLines is the inclusive row range a line selection covers, null when
// it covers none. Lines are on side, ending on endSide.
export function rowsInLines(
  rows: readonly DiffFindRow[], side: "deletions" | "additions", start: number, endSide: "deletions" | "additions", end: number,
): { start: number; end: number } | null {
  const lineOf = (row: DiffFindRow, on: "deletions" | "additions") => on === "deletions" ? row.oldLine : row.newLine
  const first = rows.findIndex((row) => lineOf(row, side) >= start && lineOf(row, side) !== 0)
  let last = -1
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    const line = row ? lineOf(row, endSide) : 0
    if (line !== 0 && line <= end) {
      last = index
      break
    }
  }
  return first >= 0 && last >= first ? { start: first, end: last } : null
}
