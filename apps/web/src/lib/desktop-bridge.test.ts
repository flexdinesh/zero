import assert from "node:assert/strict"
import test from "node:test"

import { desktopBridge, readDesktopBridge, type NativeMenuItem } from "./desktop-bridge.ts"

test("a version 1 bridge is read; folders open in the page, not through it (decision 0146)", () => {
  const bridge = readDesktopBridge({ version: 1, openFolder() {} })
  assert.equal(bridge?.version, 1)
  assert.equal(bridge !== null && "openFolder" in bridge, false)
})

test("showAppMenu passes the point through when exposed and is null otherwise", () => {
  const calls: unknown[] = []
  const exposed = { version: 1, openFolder() {}, showAppMenu(this: unknown, x: number, y: number) { calls.push([this, x, y]) } }
  readDesktopBridge(exposed)?.showAppMenu?.(4, 32)
  assert.deepEqual(calls, [[exposed, 4, 32]])
  assert.equal(readDesktopBridge({ version: 1, openFolder() {} })?.showAppMenu, null)
  assert.equal(readDesktopBridge({ version: 1, openFolder() {}, showAppMenu: "menu" })?.showAppMenu, null)
})

test("setAppearance passes the appearance through when exposed and is null otherwise", () => {
  const calls: unknown[] = []
  const exposed = { version: 2, setAppearance(this: unknown, appearance: string) { calls.push([this, appearance]) } }
  readDesktopBridge(exposed)?.setAppearance?.("system")
  readDesktopBridge(exposed)?.setAppearance?.("dark")
  assert.deepEqual(calls, [[exposed, "system"], [exposed, "dark"]])
  assert.equal(readDesktopBridge({ version: 2 })?.setAppearance, null)
  assert.equal(readDesktopBridge({ version: 2, setAppearance: "dark" })?.setAppearance, null)
})

test("closeWindow calls the native method when exposed and is null otherwise", () => {
  const calls: unknown[] = []
  const exposed = { version: 2, openFolder() {}, closeWindow(this: unknown) { calls.push(this) } }
  readDesktopBridge(exposed)?.closeWindow?.()
  assert.deepEqual(calls, [exposed])
  assert.equal(readDesktopBridge({ version: 2, openFolder() {} })?.closeWindow, null)
  assert.equal(readDesktopBridge({ version: 2, openFolder() {}, closeWindow: "close" })?.closeWindow, null)
})

test("a version 2 bridge reveals paths and resolves native menu choices", async () => {
  const calls: unknown[] = []
  const exposed = {
    version: 2,
    openFolder() {},
    revealPath(this: unknown, project: string, path: string) {
      calls.push([this, project, path])
      return Promise.resolve(true)
    },
    showContextMenu(this: unknown, items: unknown, x: number, y: number) {
      calls.push([this, items, x, y])
      return Promise.resolve("reveal")
    },
  }
  const bridge = readDesktopBridge(exposed)
  assert.equal(bridge?.version, 2)
  bridge?.revealPath?.("/src/a", "README.md")
  const items: NativeMenuItem[] = [{ id: "reveal", label: "Reveal in File Manager" }, { separator: true }]
  assert.equal(await bridge?.showContextMenu?.(items, 3, 4), "reveal")
  assert.deepEqual(calls, [[exposed, "/src/a", "README.md"], [exposed, items, 3, 4]])
})

test("native menu answers other than a string, and failures, are no choice", async () => {
  for (const answer of [null, undefined, 3, { id: "x" }]) {
    const bridge = readDesktopBridge({ version: 2, openFolder() {}, showContextMenu: () => Promise.resolve(answer) })
    assert.equal(await bridge?.showContextMenu?.([], 0, 0), null)
  }
  const failing = readDesktopBridge({ version: 2, openFolder() {}, showContextMenu: () => Promise.reject(new Error("closed")) })
  assert.equal(await failing?.showContextMenu?.([], 0, 0), null)
  const throwing = readDesktopBridge({ version: 2, openFolder() {}, revealPath: () => Promise.reject(new Error("refused")) })
  assert.doesNotThrow(() => throwing?.revealPath?.("/a", "b"))
})

test("configuring notifications passes the config and validates the status", async () => {
  const config = { project: "/code/a", commits: true, branches: false, edits: false, walkthroughs: true, feedback: true }
  const calls: unknown[][] = []
  const exposed = {
    version: 2,
    configureNotifications(this: unknown, sent: unknown) {
      calls.push([this, sent])
      return Promise.resolve({ supported: true, denied: false, extra: "dropped" })
    },
  }
  assert.deepEqual(await readDesktopBridge(exposed)?.configureNotifications?.(config), { supported: true, denied: false })
  assert.deepEqual(calls, [[exposed, config]])
  for (const answer of [null, undefined, true, { supported: true }, { supported: "yes", denied: false }]) {
    const bridge = readDesktopBridge({ version: 2, configureNotifications: () => Promise.resolve(answer) })
    assert.equal(await bridge?.configureNotifications?.(config), null)
  }
  const refused = readDesktopBridge({ version: 2, configureNotifications: () => Promise.reject(new Error("refused")) })
  assert.equal(await refused?.configureNotifications?.(config), null)
  assert.equal(readDesktopBridge({ version: 2, configureNotifications: "configure" })?.configureNotifications, null)
  assert.equal(readDesktopBridge({ version: 1 })?.configureNotifications, null)
})

test("each later method is feature-detected: a version 1 bridge or non-functions are null", () => {
  const v1 = readDesktopBridge({ version: 1, openFolder() {} })
  assert.equal(v1?.revealPath, null)
  assert.equal(v1?.showContextMenu, null)
  const odd = readDesktopBridge({ version: 2, openFolder() {}, revealPath: "reveal", showContextMenu: {} })
  assert.equal(odd?.revealPath, null)
  assert.equal(odd?.showContextMenu, null)
})

test("a remote window's bridge has its window's methods and nothing of this machine", () => {
  const remote = readDesktopBridge({ version: 2, closeWindow() {}, showAppMenu() {}, showContextMenu: () => Promise.resolve(null) })
  assert.notEqual(remote, null)
  assert.equal(remote?.revealPath, null)
  assert.equal(typeof remote?.closeWindow, "function")
  assert.equal(typeof remote?.showAppMenu, "function")
  assert.equal(typeof remote?.showContextMenu, "function")
})

test("invalid versions and non-objects are no bridge", () => {
  const openFolder = () => {}
  assert.equal(readDesktopBridge({ version: 0, openFolder }), null)
  assert.equal(readDesktopBridge({ version: 1.5, openFolder }), null)
  assert.equal(readDesktopBridge({ version: "1", openFolder }), null)
  assert.equal(readDesktopBridge({ openFolder }), null)
  for (const value of [undefined, null, 1, "bridge", [1, openFolder], openFolder]) assert.equal(readDesktopBridge(value), null)
})

test("without a window there is no bridge", () => {
  assert.equal(desktopBridge(), null)
})

test("diagnostics resolves a valid report and null for an invalid one, a refusal, or no method", async () => {
  const report = { version: "1.0.0", commit: "abc", logDir: "~/.local/state/zero/logs", logLines: ["started"], crashLines: [] }
  assert.deepEqual(await readDesktopBridge({ version: 2, diagnostics: () => Promise.resolve(report) })?.diagnostics?.(), report)
  assert.equal(await readDesktopBridge({ version: 2, diagnostics: () => Promise.resolve({ ...report, logLines: [1] }) })?.diagnostics?.(), null)
  assert.equal(await readDesktopBridge({ version: 2, diagnostics: () => Promise.reject(new Error("refused")) })?.diagnostics?.(), null)
  assert.equal(readDesktopBridge({ version: 2 })?.diagnostics, null)
})

test("openReview passes the project and URL through and swallows refusals", () => {
  const calls: unknown[][] = []
  const bridge = readDesktopBridge({ version: 2, openReview(...args: unknown[]) { calls.push(args); return Promise.reject(new Error("refused")) } })
  bridge?.openReview?.("/p", "http://a.test/")
  assert.deepEqual(calls, [["/p", "http://a.test/"]])
  assert.equal(readDesktopBridge({ version: 2 })?.openReview, null)
})

const capture = {
  id: "cap-1", project: "/p", png: "iVBORw0KGgo=",
  page: { url: "http://localhost:5173/settings", title: "Settings", viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, scroll: { x: 0, y: 1320 } },
}

test("screenCapture resolves a valid capture and null for junk, refusals, or none", async () => {
  assert.deepEqual(await readDesktopBridge({ version: 2, screenCapture: () => Promise.resolve(capture) })?.screenCapture?.(), { ...capture, hits: null, drift: false })
  assert.equal(await readDesktopBridge({ version: 2, screenCapture: () => Promise.resolve(null) })?.screenCapture?.(), null)
  const junk = { ...capture, page: { ...capture.page, viewport: { width: 1440, height: 900, deviceScaleFactor: 0 } } }
  assert.equal(await readDesktopBridge({ version: 2, screenCapture: () => Promise.resolve(junk) })?.screenCapture?.(), null)
  assert.equal(await readDesktopBridge({ version: 2, screenCapture: () => Promise.resolve({ ...capture, png: 1 }) })?.screenCapture?.(), null)
  assert.equal(await readDesktopBridge({ version: 2, screenCapture: () => Promise.reject(new Error("x")) })?.screenCapture?.(), null)
  assert.equal(readDesktopBridge({ version: 2 })?.screenCapture, null)
})

test("screenCapture keeps a sound hit map and the drift mark, and drops a broken map alone", async () => {
  // A 16 × 8 viewport in 8 px cells: 2 × 1.
  const hits = {
    step: 8, columns: 2, rows: 1, grid: [1, -1],
    elements: [
      { parent: -1, tag: "body", box: { x: 0, y: 0, width: 16, height: 8 } },
      { parent: 0, tag: "button", selector: "#save", role: "button", name: "Save", meaningful: true, box: { x: 0, y: 0, width: 8, height: 8 }, extra: "dropped" },
    ],
  }
  const small = { ...capture, page: { ...capture.page, viewport: { width: 16, height: 8, deviceScaleFactor: 1 } }, hits, drift: true }
  const read = await readDesktopBridge({ version: 2, screenCapture: () => Promise.resolve(small) })?.screenCapture?.()
  assert.deepEqual(read?.hits, {
    step: 8, columns: 2, rows: 1, grid: [1, -1],
    elements: [
      { parent: -1, tag: "body", meaningful: false, box: { x: 0, y: 0, width: 16, height: 8 } },
      { parent: 0, tag: "button", selector: "#save", role: "button", name: "Save", meaningful: true, box: { x: 0, y: 0, width: 8, height: 8 } },
    ],
  })
  assert.equal(read?.drift, true)
  for (const broken of [
    { ...hits, columns: 3 },
    { ...hits, grid: [1] },
    { ...hits, grid: [2, -1] },
    { ...hits, elements: [{ parent: 0, tag: "body" }] },
    { ...hits, elements: [hits.elements[0], { parent: 0, tag: 1 }] },
    { ...hits, elements: [hits.elements[0], { parent: 0, box: { x: 0, y: 0, width: 0, height: 1 } }] },
  ]) {
    const capture = await readDesktopBridge({ version: 2, screenCapture: () => Promise.resolve({ ...small, hits: broken }) })?.screenCapture?.()
    assert.notEqual(capture, null)
    assert.equal(capture?.hits, null)
  }
})
