import { compilePattern, escapePattern, type PatternQuery } from "../search/search-engine.ts"

// Find in file (decision 0172) matches a query against a view's segments:
// Source and Format lines, Preview text blocks, or a review's diff rows.
// Matches never span segments.

// maximumFindMatches bounds the matches one find paints and steps through.
export const maximumFindMatches = 10_000

export type FindQuery = PatternQuery

export const emptyFindQuery: FindQuery = { pattern: "", matchCase: false, wholeWord: false, regex: false }

// FindMatch is one occurrence: a segment index and its UTF-16 columns.
export interface FindMatch {
  segment: number
  start: number
  end: number
}

// SegmentRange is an inclusive range of segment indexes, e.g. a selection.
export interface SegmentRange {
  start: number
  end: number
}

export type FindOutcome =
  | { kind: "matches"; matches: readonly FindMatch[]; truncated: boolean }
  | { kind: "invalid"; message: string }

const noMatches: FindOutcome = { kind: "matches", matches: [], truncated: false }

// findMatches lists every match in segment order, within scope when given.
export function findMatches(
  segments: readonly string[], query: FindQuery, scope: SegmentRange | null = null, limit = maximumFindMatches,
): FindOutcome {
  const compiled = compilePattern(query)
  if (compiled.kind === "invalid") return compiled
  const { pattern } = compiled
  if (!pattern) return noMatches
  const first = scope ? Math.max(0, scope.start) : 0
  const last = scope ? Math.min(segments.length - 1, scope.end) : segments.length - 1
  const matches: FindMatch[] = []
  for (let segment = first; segment <= last; segment++) {
    const text = segments[segment] ?? ""
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index
      const end = start + match[0].length
      // Empty matches, such as "^" or "a*", mark no text.
      if (end === start) {
        pattern.lastIndex++
        continue
      }
      if (matches.length >= limit) return { kind: "matches", matches, truncated: true }
      matches.push({ segment, start, end })
    }
  }
  return { kind: "matches", matches, truncated: false }
}

// stepIndex moves current by direction, wrapping past the ends.
export function stepIndex(count: number, current: number, direction: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}

// firstFrom is the first match at or after segment, wrapping to the first.
export function firstFrom(matches: readonly FindMatch[], segment: number): number {
  if (matches.length === 0) return -1
  const index = matches.findIndex((match) => match.segment >= segment)
  return index < 0 ? 0 : index
}

function before(left: FindMatch, right: FindMatch): boolean {
  return left.segment < right.segment || (left.segment === right.segment && left.start < right.start)
}

// nearestIndex keeps a match current across a recount: the same match, else
// the first after where it was, else the first.
export function nearestIndex(matches: readonly FindMatch[], previous: FindMatch | null): number {
  if (matches.length === 0) return -1
  if (!previous) return 0
  const index = matches.findIndex((match) => !before(match, previous))
  return index < 0 ? 0 : index
}

// countLabel reads "3 of 12", "3 of 10000+", or "No results".
export function countLabel(current: number, count: number, truncated: boolean): string {
  if (count === 0) return "No results"
  const total = `${count.toLocaleString()}${truncated ? "+" : ""}`
  return current >= 0 ? `${(current + 1).toLocaleString()} of ${total}` : `${total} ${count === 1 && !truncated ? "result" : "results"}`
}

// seedPattern is the query a text selection starts find with: one line of
// at most 200 characters, quoted when the query is a regular expression.
export function seedPattern(selected: string, regex: boolean): string | null {
  if (!selected || selected.length > 200 || selected.includes("\n")) return null
  return regex ? escapePattern(selected) : selected
}
