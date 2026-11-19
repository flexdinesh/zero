import assert from "node:assert/strict"
import test from "node:test"

import {
  countLabel, emptyFindQuery, findMatches, firstFrom, nearestIndex, seedPattern, stepIndex, type FindMatch, type FindOutcome,
  type FindQuery,
} from "./find-model.ts"

const lines = ["const Alpha = alpha()", "", "alphabet and alpha", "beta"]

function query(pattern: string, options: Partial<FindQuery> = {}): FindQuery {
  return { ...emptyFindQuery, pattern, ...options }
}

function spots(outcome: FindOutcome): string[] {
  assert.equal(outcome.kind, "matches")
  return outcome.kind === "matches" ? outcome.matches.map((match) => `${match.segment}:${match.start}-${match.end}`) : []
}

test("a literal finds every case-insensitive occurrence by segment and UTF-16 column", () => {
  assert.deepEqual(spots(findMatches(lines, query("alpha"))), ["0:6-11", "0:14-19", "2:0-5", "2:13-18"])
})

test("match case, whole word, and regular expressions narrow the matches", () => {
  assert.deepEqual(spots(findMatches(lines, query("Alpha", { matchCase: true }))), ["0:6-11"])
  assert.deepEqual(spots(findMatches(lines, query("alpha", { wholeWord: true }))), ["0:6-11", "0:14-19", "2:13-18"])
  assert.deepEqual(spots(findMatches(lines, query("^b\\w+", { regex: true }))), ["3:0-4"])
})

test("literal text with regular-expression characters matches as typed", () => {
  assert.deepEqual(spots(findMatches(lines, query("alpha()"))), ["0:14-21"])
})

test("an empty query finds nothing and an invalid expression says so", () => {
  assert.deepEqual(spots(findMatches(lines, emptyFindQuery)), [])
  assert.deepEqual(findMatches(lines, query("(", { regex: true })), { kind: "invalid", message: "Invalid regular expression." })
})

test("empty matches mark no text and never stall", () => {
  assert.deepEqual(spots(findMatches(lines, query("x*", { regex: true }))), [])
})

test("a scope keeps matches within its segments", () => {
  assert.deepEqual(spots(findMatches(lines, query("alpha"), { start: 1, end: 3 })), ["2:0-5", "2:13-18"])
})

test("the limit truncates the matches", () => {
  const outcome = findMatches(lines, query("a"), null, 3)
  assert.equal(outcome.kind === "matches" && outcome.truncated, true)
  assert.equal(spots(outcome).length, 3)
})

test("steps wrap past either end", () => {
  assert.equal(stepIndex(3, 2, 1), 0)
  assert.equal(stepIndex(3, 0, -1), 2)
  assert.equal(stepIndex(3, -1, 1), 0)
  assert.equal(stepIndex(3, -1, -1), 2)
  assert.equal(stepIndex(0, 0, 1), -1)
})

const matches: FindMatch[] = [{ segment: 0, start: 2, end: 4 }, { segment: 2, start: 0, end: 1 }, { segment: 5, start: 3, end: 6 }]

test("a search starts at the first match at or after the viewport's top, wrapping to the first", () => {
  assert.equal(firstFrom(matches, 1), 1)
  assert.equal(firstFrom(matches, 2), 1)
  assert.equal(firstFrom(matches, 6), 0)
  assert.equal(firstFrom([], 0), -1)
})

test("a recount keeps the current match, else the next one after where it was", () => {
  assert.equal(nearestIndex(matches, { segment: 2, start: 0, end: 1 }), 1)
  assert.equal(nearestIndex(matches, { segment: 3, start: 0, end: 1 }), 2)
  assert.equal(nearestIndex(matches, { segment: 9, start: 0, end: 1 }), 0)
  assert.equal(nearestIndex(matches, null), 0)
})

test("the count reads the current position, a truncated total, or no results", () => {
  assert.equal(countLabel(2, 12, false), "3 of 12")
  assert.equal(countLabel(0, 10_000, true), "1 of 10,000+")
  assert.equal(countLabel(-1, 0, false), "No results")
})

test("a one-line selection seeds the query, quoted for regular expressions", () => {
  assert.equal(seedPattern("a.b", false), "a.b")
  assert.equal(seedPattern("a.b", true), "a\\.b")
  assert.equal(seedPattern("two\nlines", false), null)
  assert.equal(seedPattern("", false), null)
  assert.equal(seedPattern("x".repeat(201), false), null)
})
