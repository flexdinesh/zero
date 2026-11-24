import assert from "node:assert/strict"
import test from "node:test"

import { defaultsToHTTP, forgetURL, pageKey, pageLabel, parseRecent, rememberURL, reviewChoices, reviewURL, samePage } from "./review-model.ts"

test("reviewURL accepts http(s) pages and bare hosts only", () => {
  assert.equal(reviewURL(" localhost:5173/settings "), "http://localhost:5173/settings")
  assert.equal(reviewURL("https://example.test"), "https://example.test/")
  assert.equal(reviewURL("localhost"), "http://localhost/")
  assert.equal(reviewURL("app.test/a?b=1"), "https://app.test/a?b=1")
  for (const raw of ["", "javascript:alert(1)", "file:///etc/passwd", "zero-app://local/", "http://user:pw@host/", "http://a b", "/settings", "5173", "settings"]) {
    assert.equal(reviewURL(raw), null, raw)
  }
})

test("a bare address takes https, and http on this machine or the local network", () => {
  assert.equal(reviewURL("barneybishop.com"), "https://barneybishop.com/")
  assert.equal(reviewURL("staging.example.test:8443/a"), "https://staging.example.test:8443/a")
  for (const host of ["localhost:5173", "app.localhost", "127.0.0.1:4321", "10.0.0.2", "172.16.4.1:80", "172.31.255.255", "192.168.1.20:5173", "mac.local:3000"]) {
    assert.match(reviewURL(host) ?? "", /^http:\/\//, host)
  }
  for (const host of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "localhost.example.test"]) {
    assert.match(reviewURL(host) ?? "", /^https:\/\//, host)
  }
  // A scheme typed is kept.
  assert.equal(reviewURL("http://barneybishop.com"), "http://barneybishop.com/")
  assert.equal(reviewURL("https://localhost:5173"), "https://localhost:5173/")
  assert.equal(defaultsToHTTP("LOCALHOST"), true)
  assert.equal(defaultsToHTTP("[::1]"), true)
  assert.equal(defaultsToHTTP("example.test"), false)
})

test("forgetURL removes one page and drops a project left empty", () => {
  const recent = { "/a": ["https://a.test/", "https://b.test/"], "/b": ["https://c.test/"] }
  assert.deepEqual(forgetURL(recent, "/a", "https://a.test/"), { "/a": ["https://b.test/"], "/b": ["https://c.test/"] })
  assert.deepEqual(Object.keys(forgetURL(recent, "/a", "https://a.test/")), ["/a", "/b"])
  assert.deepEqual(forgetURL(recent, "/b", "https://c.test/"), { "/a": ["https://a.test/", "https://b.test/"] })
  assert.deepEqual(forgetURL(recent, "/c", "https://c.test/"), recent)
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
  assert.equal(pageLabel("https://barneybishop.com/#about"), "barneybishop.com/")
  assert.equal(pageLabel("not a url"), "not a url")
})

test("pageLabel keeps the scheme when the bare label would open another address", () => {
  assert.equal(pageLabel("http://barneybishop.com/"), "http://barneybishop.com/")
  assert.equal(pageLabel("https://localhost:5173/"), "https://localhost:5173/")
  assert.equal(pageLabel("http://intranet/"), "http://intranet/")
  assert.notEqual(pageLabel("http://barneybishop.com/"), pageLabel("https://barneybishop.com/"))
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
