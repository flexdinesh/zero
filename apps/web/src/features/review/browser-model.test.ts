import assert from "node:assert/strict"
import test from "node:test"

import { blockingFailure, browserTabName, currentPage, failureText, isLoopback, refusedFailure, stageView } from "./browser-model.ts"
import type { BrowserState } from "../../lib/desktop-bridge.ts"

const shown: BrowserState = {
  url: "http://localhost:5173/settings", title: "Settings", loading: false, canGoBack: true, canGoForward: false, failure: null,
  commenting: false, composing: false,
}

test("the stage is empty without a guest and holds the page otherwise", () => {
  assert.equal(stageView(null), "empty")
  assert.equal(stageView(shown), "page")
  assert.equal(stageView({ ...shown, loading: true, url: "" }), "page")
})

test("a failure takes the stage unless the guest only refused a scheme and kept its page", () => {
  for (const kind of ["load", "certificate", "crashed"] as const) {
    const state = { ...shown, loading: true, failure: { kind, url: shown.url, description: "" } }
    assert.equal(stageView(state), "failed", kind)
    assert.equal(blockingFailure(state), state.failure)
    assert.equal(refusedFailure(state), null)
  }
  const refused = { ...shown, failure: { kind: "refused" as const, url: "file:", description: "" } }
  assert.equal(stageView(refused), "page")
  assert.equal(blockingFailure(refused), null)
  assert.equal(refusedFailure(refused), refused.failure)
  assert.equal(refusedFailure(null), null)
})

test("currentPage is the guest's page, else the last one opened", () => {
  assert.equal(currentPage(shown, "http://localhost:3000/"), shown.url)
  assert.equal(currentPage({ ...shown, url: "" }, "http://localhost:3000/"), "http://localhost:3000/")
  assert.equal(currentPage(null, ""), "")
})

test("browserTabName names the page's host, with the page in the title", () => {
  assert.deepEqual(browserTabName("http://localhost:5173/settings?tab=2"), { label: "localhost:5173", title: "Browser: localhost:5173/settings?tab=2" })
  assert.deepEqual(browserTabName("https://example.com/"), { label: "example.com", title: "Browser: example.com/" })
})

test("browserTabName adds the page's title on one bounded line", () => {
  assert.deepEqual(browserTabName("http://localhost:5173/settings", "  Settings\n · Acme "), {
    label: "localhost:5173", title: "Browser: Settings · Acme · localhost:5173/settings",
  })
  assert.equal(browserTabName("http://localhost:5173/", "x".repeat(400)).title, `Browser: ${"x".repeat(120)} · localhost:5173/`)
  assert.equal(browserTabName("", "Settings").title, "Browser")
})

test("browserTabName is Browser without a page", () => {
  assert.deepEqual(browserTabName(""), { label: "Browser", title: "Browser" })
  assert.deepEqual(browserTabName("about:blank"), { label: "Browser", title: "Browser" })
})

test("isLoopback knows this machine's hosts only", () => {
  const cases: [string, boolean][] = [
    ["http://localhost:5173/", true],
    ["http://app.localhost/", true],
    ["http://127.0.0.1:8080/", true],
    ["http://127.4.5.6/", true],
    ["http://[::1]:3000/", true],
    ["https://example.com/", false],
    ["http://localhost.example.com/", false],
    ["nonsense", false],
  ]
  for (const [url, expected] of cases) assert.equal(isLoopback(url), expected, url)
})

test("failureText asks about the dev server for a local page that did not load", () => {
  assert.deepEqual(failureText({ kind: "load", url: "http://localhost:5173/", description: "Could not connect: Connection refused" }), {
    title: "Could not load localhost:5173/",
    detail: "Could not connect: Connection refused. Is its dev server running?",
    retry: "Try again",
  })
})

test("failureText asks about the address for a public page, with a fallback description", () => {
  const text = failureText({ kind: "load", url: "https://example.invalid/a", description: "" })
  assert.equal(text.title, "Could not load example.invalid/a")
  assert.equal(text.detail, "The page did not answer. Check the address and your connection.")
})

test("failureText names the host of a refused certificate", () => {
  assert.equal(failureText({ kind: "certificate", url: "https://localhost:8443/x", description: "Unacceptable TLS certificate" }).title,
    "localhost:8443 has a certificate Zero does not trust")
})

test("failureText names a refused scheme and offers Reload", () => {
  const text = failureText({ kind: "refused", url: "file:", description: "" })
  assert.equal(text.title, "The page tried to open file:")
  assert.equal(text.retry, "Reload")
})

test("failureText keeps a crashed process's reason", () => {
  assert.equal(failureText({ kind: "crashed", url: "", description: "out of memory" }).detail, "out of memory.")
  assert.equal(failureText({ kind: "crashed", url: "", description: "" }).detail, "Its web process ended. Reload to start it again.")
})
