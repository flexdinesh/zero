import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { isDiffResponse } from "@zero/contracts"
import { sameDiffContent } from "./same-diff-content.ts"

function fixture() {
  const value: unknown = JSON.parse(readFileSync(new URL("../../../../../testdata/api/default/diff-modified.json", import.meta.url), "utf8"))
  assert.ok(isDiffResponse(value))
  return value
}

test("fresh transport objects with unchanged content preserve rendering identity", () => {
  const first = fixture()
  const next = structuredClone(first)
  if (next.original) next.original.commit = "b".repeat(40)
  assert.equal(sameDiffContent(first, next), true)
})

test("source, language, path, and structured layout changes invalidate rendering identity", () => {
  const first = fixture()
  for (const change of ["source", "language", "path", "layout", "binary"]) {
    const next = structuredClone(first)
    if (change === "source" && next.modified) next.modified.content += "another line\n"
    if (change === "language") next.documentType.language = "javascript"
    if (change === "path") next.path = "renamed.txt"
    if (change === "layout" && next.lineDiff) next.lineDiff.ignoreWhitespace = !next.lineDiff.ignoreWhitespace
    if (change === "binary" && next.modified) next.modified.binary = true
    assert.equal(sameDiffContent(first, next), false, change)
  }
})
