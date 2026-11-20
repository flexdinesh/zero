import assert from "node:assert/strict"
import test from "node:test"

import { pageKey, pageLabel, parseRecent, rememberURL, reviewChoices, reviewURL, samePage } from "./review-model.ts"

test("reviewURL accepts http(s) pages and bare hosts only", () => {
  assert.equal(reviewURL(" localhost:5173/settings "), "http://localhost:5173/settings")
  assert.equal(reviewURL("https://example.test"), "https://example.test/")
  assert.equal(reviewURL("localhost"), "http://localhost/")
  assert.equal(reviewURL("app.test/a?b=1"), "http://app.test/a?b=1")
  for (const raw of ["", "javascript:alert(1)", "file:///etc/passwd", "zero-app://local/", "http://user:pw@host/", "http://a b", "/settings", "5173", "settings"]) {
    assert.equal(reviewURL(raw), null, raw)
  }
})

test("recent pages stay per project, newest first, bounded", () => {
  let recent = parseRecent({ "/a": ["http://a.test/", 3, "javascript:x"], "/b": "nope" })
  assert.deepEqual(recent, { "/a": ["http://a.test/"] })
  recent = rememberURL(recent, "/a", "http://b.test/")
  recent = rememberURL(recent, "/a", "http://a.test/")
  assert.deepEqual(recent["/a"], ["http://a.test/", "http://b.test/"])
  for (let index = 0; index < 12; index++) recent = rememberURL(recent, "/a", `http://h${index}.test/`)
  assert.equal(recent["/a"]?.length, 8)
  assert.equal(recent["/a"]?.[0], "http://h11.test/")
  assert.deepEqual(parseRecent(null), {})
})

test("reviewChoices puts a new typed page before remembered matches", () => {
  const recent = ["http://localhost:5173/settings", "http://localhost:3000/"]
  assert.deepEqual(reviewChoices(recent, "5173").map((choice) => [choice.url, choice.typed]), [["http://localhost:5173/settings", false]])
  assert.deepEqual(reviewChoices(recent, "localhost:4000").map((choice) => choice.typed), [true])
  assert.deepEqual(reviewChoices(recent, "http://localhost:3000/").map((choice) => choice.typed), [false])
  assert.equal(reviewChoices(recent, "").length, 2)
})

test("pageLabel drops the scheme and keeps the query", () => {
  assert.equal(pageLabel("http://localhost:5173/settings?tab=2"), "localhost:5173/settings?tab=2")
  assert.equal(pageLabel("not a url"), "not a url")
})

test("a page is its origin and path, and its hash when the hash is a route; the query never counts", () => {
  assert.equal(pageKey("http://localhost:5173/settings?tab=billing#plan"), "http://localhost:5173/settings")
  assert.equal(pageKey("http://localhost:5173/#/settings?tab=2"), "http://localhost:5173/#/settings")
  assert.equal(pageKey("http://localhost:5173/#!/inbox"), "http://localhost:5173/#!/inbox")
  assert.equal(pageKey("file:///etc/passwd"), "")
  assert.equal(pageKey("not a url"), "")
  assert.equal(samePage("http://localhost:5173/settings?tab=billing&session=REDACTED#plan", "http://localhost:5173/settings"), true)
  assert.equal(samePage("http://localhost:5173/settings", "http://localhost:5173/settings#top"), true)
  assert.equal(samePage("http://localhost:5173/#/settings", "http://localhost:5173/#/billing"), false)
  assert.equal(samePage("http://localhost:5173/#/settings", "http://localhost:5173/"), false)
  assert.equal(samePage("http://localhost:5173/settings", "http://localhost:5173/settings/"), false)
  assert.equal(samePage("http://localhost:5173/settings", "https://localhost:5173/settings"), false)
  assert.equal(samePage("http://localhost:5173/settings", "http://localhost:3000/settings"), false)
  // Nothing matches what is not a page.
  assert.equal(samePage("", ""), false)
})
