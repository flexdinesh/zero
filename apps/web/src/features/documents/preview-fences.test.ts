import assert from "node:assert/strict"
import test from "node:test"

import { fenceHighlightChunks } from "./preview-fences.ts"

test("fence chunks preserve every row while bounding rows and markup per update", () => {
  const rows = Array.from({ length: 450 }, (_, index) => `<span class="hl-number">${index}</span>`)
  const source = Array.from({ length: 450 }, (_, index) => `${index}\n`).join("")
  const chunks = fenceHighlightChunks(source, rows)
  assert.ok(chunks)
  for (const chunk of chunks) {
    assert.ok(chunk.source.split("\n").length - 1 <= 100)
    assert.ok(chunk.html.length <= 16_384)
  }
  assert.equal(chunks.map((chunk) => chunk.source).join(""), source)
  assert.equal(chunks.map((chunk) => chunk.html).join(""), rows.join("\n") + "\n")
  const longRows = Array.from({ length: 10 }, () => "escaped ".repeat(800))
  const longChunks = fenceHighlightChunks(longRows.join("\n"), longRows)
  assert.ok(longChunks && longChunks.length > 1)
  assert.equal(fenceHighlightChunks("x".repeat(20_000), ["x".repeat(20_000)])?.length, 1, "a single long row must not stall the queue")
})

test("fence chunks retain empty rows and exact newline spelling at boundaries", () => {
  for (const ending of ["\n", "\r", "\r\n"]) {
    for (const final of ["", ending]) {
      const rows = [...Array.from({ length: 99 }, () => "row"), "", "", "last"]
      const source = rows.join(ending) + final
      const chunks = fenceHighlightChunks(source, rows)
      assert.ok(chunks)
      assert.equal(chunks.length, ending === "\r" ? 1 : 2)
      assert.equal(chunks.map((chunk) => chunk.source).join(""), source)
      assert.equal(chunks.map((chunk) => chunk.html).join(""), source.replaceAll("\r", "&#13;"))
    }
  }
  assert.deepEqual(fenceHighlightChunks("first\r\n\rsecond\nlast", ["first", "", "second", "last"]), [
    { source: "first\r\n\rsecond\nlast", html: "first&#13;\n&#13;second\nlast" },
  ])
  assert.deepEqual(fenceHighlightChunks("", [""]), [{ source: "", html: "" }])
  assert.equal(fenceHighlightChunks("one\ntwo", ["one"]), null)
  assert.equal(fenceHighlightChunks("one", []), null)
})
