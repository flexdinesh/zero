import assert from "node:assert/strict"
import test from "node:test"

import type { CompareContext } from "../features/source-control/compare.ts"
import {
  browserTab, documentKey, documentTab, includesTab, offeredTab, parseStoredTab, placeTab, reviewTab, routeAt, sameTab, screenTab, storedTab, tabKey, tabName,
  tabSearch, walkthroughTab, welcomeTab,
} from "./workspace-tabs.ts"

const hash = "3577ec6a1b2c3d4e5f60718293a4b5c6d7e8f901"
const other = "4f76e9a1b2c3d4e5f60718293a4b5c6d7e8f9012"
const context: CompareContext = { base: "main", subject: (candidate) => candidate === hash ? "fix: preserve language server crash diagnostics" : "" }

test("documents and reviews are distinct tabs; one review per compare", () => {
  const working = reviewTab({ kind: "working" })
  assert.equal(sameTab(documentTab("a.md"), documentTab("a.md")), true)
  assert.equal(sameTab(documentTab("a.md"), working), false)
  assert.equal(sameTab(working, reviewTab({ kind: "working" })), true)
  assert.equal(sameTab(reviewTab({ kind: "commit", hash }), reviewTab({ kind: "commit", hash: other })), false)
  assert.equal(includesTab([working], reviewTab({ kind: "branch", base: "", head: "", uncommitted: false })), false)
  const keys = [documentTab("working"), working, reviewTab({ kind: "branch", base: "", head: "", uncommitted: false }), reviewTab({ kind: "branch", base: "develop", head: "", uncommitted: false }),
    reviewTab({ kind: "commit", hash }), reviewTab({ kind: "range", from: other, to: hash })].map(tabKey)
  assert.equal(new Set(keys).size, keys.length)
})

test("tabs name documents by file and reviews by what they compare", () => {
  assert.deepEqual(tabName(documentTab("web/src/App.tsx"), context), { label: "App.tsx", title: "web/src/App.tsx" })
  assert.equal(tabName(reviewTab({ kind: "working" }), context).label, "Uncommitted")
  assert.equal(tabName(reviewTab({ kind: "branch", base: "", head: "", uncommitted: false }), context).label, "vs main")
  assert.equal(tabName(reviewTab({ kind: "branch", base: "origin/develop", head: "", uncommitted: false }), context).label, "vs origin/develop")
  assert.equal(tabName(reviewTab({ kind: "branch", base: "", head: "", uncommitted: false }), { ...context, base: "" }).label, "Branch")
  assert.equal(tabName(reviewTab({ kind: "commit", hash }), context).label, "3577ec6 fix: preserve language server crash dia…")
  assert.equal(tabName(reviewTab({ kind: "commit", hash: other }), context).label, "4f76e9a")
  assert.equal(tabName(reviewTab({ kind: "range", from: other, to: hash }), context).label, "4f76e9a..3577ec6")
})

test("stored tabs round-trip and migrate per-file diff entries to their review", () => {
  for (const tab of [documentTab("a.md"), reviewTab({ kind: "working" }), reviewTab({ kind: "branch", base: "develop", head: "", uncommitted: false }),
    reviewTab({ kind: "commit", hash }), reviewTab({ kind: "range", from: other, to: hash })]) {
    assert.deepEqual(parseStoredTab(storedTab(tab)), tab)
  }
  assert.deepEqual(parseStoredTab({ diff: "a.md" }), reviewTab({ kind: "working" }))
  assert.deepEqual(parseStoredTab({ commit: hash, path: "a.md" }), reviewTab({ kind: "commit", hash }))
  assert.deepEqual(parseStoredTab({ branch: "a.md" }), reviewTab({ kind: "branch", base: "", head: "", uncommitted: false }))
  assert.deepEqual(parseStoredTab({ from: other, to: hash, path: "a.md" }), reviewTab({ kind: "range", from: other, to: hash }))
  for (const malformed of ["", { diff: "" }, { diff: 1 }, { path: "a.md" }, ["a.md"], null, 3, { commit: "3577ec6" },
    { review: "commit", commit: "x" }, { review: "range", from: other }, { review: "other" }, { branch: "" }]) {
    assert.equal(parseStoredTab(malformed), null, JSON.stringify(malformed))
  }
})

test("tab searches route documents by path and reviews without one", () => {
  assert.deepEqual(tabSearch("p", documentTab("a.md")), { project: "p", path: "a.md" })
  assert.deepEqual(tabSearch("p", reviewTab({ kind: "working" })), { project: "p", review: "working" })
  assert.deepEqual(tabSearch("p", reviewTab({ kind: "branch", base: "", head: "", uncommitted: false })), { project: "p", review: "branch" })
  assert.deepEqual(tabSearch("p", reviewTab({ kind: "branch", base: "develop", head: "", uncommitted: false })), { project: "p", review: "branch", base: "develop" })
  assert.deepEqual(tabSearch("p", reviewTab({ kind: "commit", hash })), { project: "p", commit: hash })
  assert.deepEqual(tabSearch("p", reviewTab({ kind: "range", from: other, to: hash })), { project: "p", from: other, to: hash })
})

test("snapshots are document tabs of a commit, distinct from the working file", () => {
  const snapshot = documentTab("web/src/App.tsx", hash)
  assert.equal(sameTab(snapshot, documentTab("web/src/App.tsx")), false)
  assert.equal(sameTab(snapshot, documentTab("web/src/App.tsx", other)), false)
  assert.equal(tabKey(snapshot), `document:${hash}:web/src/App.tsx`)
  assert.equal(tabKey(documentTab("web/src/App.tsx")), "document:web/src/App.tsx")
  assert.deepEqual(tabName(snapshot, context), { label: "App.tsx @ 3577ec6", title: `web/src/App.tsx at ${hash}` })
  assert.deepEqual(tabSearch("p", snapshot), { project: "p", path: "web/src/App.tsx", at: hash })
  assert.equal(documentKey("a.md"), "a.md")
  assert.equal(documentKey("a.md", hash), `${hash}:a.md`)
})

test("stored snapshots round-trip; plain paths stay working-tree documents", () => {
  const snapshot = documentTab("a.md", hash)
  assert.deepEqual(storedTab(snapshot), { path: "a.md", at: hash })
  assert.deepEqual(parseStoredTab(storedTab(snapshot)), snapshot)
  assert.deepEqual(parseStoredTab("a.md"), documentTab("a.md"))
  for (const malformed of [{ path: "a.md", at: "3577ec6" }, { path: "", at: hash }, { path: 1, at: hash }, { at: hash }, { path: "a.md", at: hash.toUpperCase() }]) {
    assert.equal(parseStoredTab(malformed), null, JSON.stringify(malformed))
  }
})

test("routes read a snapshot commit only as a full hash with a path", () => {
  assert.equal(routeAt("a.md", hash), hash)
  assert.equal(routeAt(undefined, hash), undefined)
  assert.equal(routeAt("a.md", "3577ec6"), undefined)
  assert.equal(routeAt("a.md", hash.toUpperCase()), undefined)
  assert.equal(routeAt("a.md", 1), undefined)
})

test("walkthrough tabs key, name, store, and route by ID", () => {
  const tab = walkthroughTab("tour")
  assert.equal(tabKey(tab), "walkthrough:tour")
  assert.equal(sameTab(tab, walkthroughTab("tour")), true)
  assert.equal(sameTab(tab, documentTab("tour")), false)
  assert.deepEqual(tabName(tab, context), { label: "Walkthrough", title: "Walkthrough tour" })
  assert.deepEqual(tabName(tab, context, (id) => id === "tour" ? "How login works" : ""), { label: "How login works", title: "Walkthrough: How login works" })
  assert.deepEqual(storedTab(tab), { walkthrough: "tour" })
  assert.deepEqual(parseStoredTab({ walkthrough: "tour" }), tab)
  assert.equal(parseStoredTab({ walkthrough: "" }), null)
  assert.equal(parseStoredTab({ walkthrough: 3 }), null)
  assert.deepEqual(tabSearch("/p", tab), { project: "/p", wt: "tour" })
})

test("the Welcome tab is one tab that keys, names, stores, and routes", () => {
  const tab = welcomeTab()
  assert.equal(tabKey(tab), "welcome")
  assert.equal(sameTab(tab, welcomeTab()), true)
  assert.equal(sameTab(tab, documentTab("welcome")), false)
  assert.deepEqual(tabName(tab, context), { label: "Welcome", title: "Welcome" })
  assert.deepEqual(storedTab(tab), { welcome: true })
  assert.deepEqual(parseStoredTab(storedTab(tab)), tab)
  assert.equal(parseStoredTab({ welcome: false }), null)
  assert.equal(parseStoredTab({ welcome: "yes" }), null)
  assert.deepEqual(tabSearch("/p", tab), { project: "/p", welcome: 1 })
})

test("the Browser tab is one tab per project, named by its page", () => {
  const tab = browserTab()
  assert.equal(tabKey(tab), "browser")
  assert.equal(sameTab(tab, browserTab()), true)
  assert.equal(sameTab(tab, documentTab("browser")), false)
  assert.deepEqual(tabName(tab, context), { label: "Browser", title: "Browser" })
  assert.deepEqual(tabName(tab, context, () => "", () => ({ label: "localhost:5173", title: "Browser: localhost:5173/" })),
    { label: "localhost:5173", title: "Browser: localhost:5173/" })
  assert.deepEqual(storedTab(tab), { browser: true })
  assert.deepEqual(parseStoredTab(storedTab(tab)), tab)
  assert.equal(parseStoredTab({ browser: 1 }), null)
  assert.deepEqual(tabSearch("/p", tab), { project: "/p", browser: 1 })
  assert.deepEqual(placeTab({ tabs: [], preview: null }, tab, true), { tabs: [tab], preview: null })
})

test("a walkthrough step's tab is the preview tab the next step replaces", () => {
  const welcome = welcomeTab()
  const cover = walkthroughTab("tour")
  const a = documentTab("a.md")
  const b = documentTab("b.md")
  const working = reviewTab({ kind: "working" })
  let placed = placeTab({ tabs: [welcome], preview: null }, cover, true)
  assert.deepEqual(placed, { tabs: [welcome, cover], preview: null })
  placed = placeTab(placed, a, true)
  assert.deepEqual(placed, { tabs: [welcome, cover, a], preview: a })
  placed = placeTab(placed, working, true)
  assert.deepEqual(placed, { tabs: [welcome, cover, working], preview: working })
  // An open tab is left as it is, and stays out of the next replacement.
  assert.equal(placeTab(placed, cover, true), placed)
  placed = placeTab({ ...placed, tabs: [...placed.tabs, b] }, b, true)
  assert.deepEqual(placed.preview, working)
  // Ordinary tabs join the end and keep the preview tab.
  const c = documentTab("c.md")
  placed = placeTab(placed, c, false)
  assert.deepEqual(placed, { tabs: [welcome, cover, working, b, c], preview: working })
  // A pinned or closed preview tab is not replaced.
  assert.deepEqual(placeTab({ tabs: [welcome], preview: a }, b, true), { tabs: [welcome, b], preview: b })
  assert.deepEqual(placeTab({ tabs: [welcome], preview: null }, a, true), { tabs: [welcome, a], preview: a })
})

test("a visual thread's screen tab is one per feedback and thread, routed by fb and thread, and remembered", () => {
  const five = screenTab("fb-3k2q8m", 5)
  assert.equal(sameTab(five, screenTab("fb-3k2q8m", 5)), true)
  assert.equal(sameTab(five, screenTab("fb-3k2q8m", 6)), false)
  assert.equal(sameTab(five, screenTab("fb-7hq2mx", 5)), false)
  assert.equal(tabKey(five), "screen:fb-3k2q8m:5")
  assert.deepEqual(tabSearch("p", five), { project: "p", fb: "fb-3k2q8m", thread: 5 })
  assert.deepEqual(storedTab(five), { screen: "fb-3k2q8m", thread: 5 })
  assert.deepEqual(parseStoredTab(storedTab(five)), five)
  for (const malformed of [{ screen: "fb-3k2q8m" }, { screen: "fb-3k2q8m", thread: 0 }, { screen: "fb-3k2q8m", thread: 1.5 },
    { screen: "fb-3K2Q8M", thread: 5 }, { screen: "", thread: 5 }, { screen: "fb-3k2q8m", thread: "5x" }]) {
    assert.equal(parseStoredTab(malformed), null, JSON.stringify(malformed))
  }
})

test("screen tabs name the thread and its page once read, and the thread alone before", () => {
  const five = screenTab("fb-3k2q8m", 5)
  assert.deepEqual(tabName(five, context), { label: "Thread #5", title: "Thread 5 of fb-3k2q8m" })
  const named = tabName(five, context, () => "", undefined, (feedback, thread) => feedback === "fb-3k2q8m" && thread === 5
    ? { place: "localhost:5173/settings", title: "Save overlaps the card edge" }
    : null)
  assert.deepEqual(named, { label: "#5 · localhost:5173/settings", title: "Thread 5: Save overlaps the card edge\nlocalhost:5173/settings" })
})

test("a screen tab opened as preview replaces the preview tab, as walkthrough steps do", () => {
  const welcome = welcomeTab()
  const five = screenTab("fb-3k2q8m", 5)
  const six = screenTab("fb-3k2q8m", 6)
  let placed = placeTab({ tabs: [welcome], preview: null }, five, true)
  assert.deepEqual(placed, { tabs: [welcome, five], preview: five })
  placed = placeTab(placed, six, true)
  assert.deepEqual(placed, { tabs: [welcome, six], preview: six })
  // Once pinned, the next thread joins the end as the new preview.
  placed = placeTab({ ...placed, preview: null }, five, true)
  assert.deepEqual(placed, { tabs: [welcome, six, five], preview: five })
})

test("a window offers the Browser tab and screen tabs only with their features", () => {
  const off = { browser: false, screens: false }
  assert.equal(offeredTab(browserTab(), off), false)
  assert.equal(offeredTab(screenTab("fb-3k2q8m", 5), off), false)
  assert.equal(offeredTab(browserTab(), { browser: true, screens: true }), true)
  assert.equal(offeredTab(screenTab("fb-3k2q8m", 5), { browser: false, screens: true }), true)
  for (const tab of [documentTab("a.md"), reviewTab({ kind: "working" }), walkthroughTab("w1"), welcomeTab()]) assert.equal(offeredTab(tab, off), true)
})
