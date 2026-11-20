import assert from "node:assert/strict"
import test from "node:test"

import {
  browserAvailable, desktopBridge, hostsBrowser, hostsComments, hostsComposer, readComposerCapture, readDesktopBridge, readElementFacts, type NativeMenuItem,
} from "./desktop-bridge.ts"

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

test("browserOpen passes the project and URL through and swallows refusals", async () => {
  const calls: unknown[][] = []
  const bridge = readDesktopBridge({ version: 2, browserOpen(...args: unknown[]) { calls.push(args); return Promise.reject(new Error("refused")) } })
  await bridge?.browserOpen?.("/p", "http://a.test/")
  assert.deepEqual(calls, [["/p", "http://a.test/"]])
  assert.equal(readDesktopBridge({ version: 2 })?.browserOpen, null)
})

test("browserState passes the project and keeps a well-formed state only", async () => {
  const calls: unknown[][] = []
  const state = {
    url: "http://localhost:5173/", title: "Home", loading: false, canGoBack: true, canGoForward: false,
    failure: { kind: "load", url: "http://localhost:5173/", description: "refused" }, commenting: true, composing: false, extra: 1,
  }
  const bridge = readDesktopBridge({ version: 2, browserState(...args: unknown[]) { calls.push(args); return Promise.resolve(state) } })
  assert.deepEqual(await bridge?.browserState?.("/p"), {
    url: "http://localhost:5173/", title: "Home", loading: false, canGoBack: true, canGoForward: false,
    failure: { kind: "load", url: "http://localhost:5173/", description: "refused" }, commenting: true, composing: false,
  })
  assert.deepEqual(calls, [["/p"]])
  const answer = (value: unknown) => readDesktopBridge({ version: 2, browserState: () => Promise.resolve(value) })?.browserState?.("/p")
  assert.equal(await answer(null), null)
  assert.equal(await answer({ ...state, loading: "no" }), null)
  assert.equal(await answer({ ...state, failure: { kind: "boom", url: "", description: "" } }), null)
  assert.equal(await readDesktopBridge({ version: 2, browserState: () => Promise.reject(new Error("refused")) })?.browserState?.("/p"), null)
  assert.equal(readDesktopBridge({ version: 2 })?.browserState, null)
})

test("browserState reads a missing title as empty and missing comment state as off", async () => {
  const state = { url: "http://localhost:5173/", loading: true, canGoBack: false, canGoForward: false, failure: null }
  assert.deepEqual(await readDesktopBridge({ version: 2, browserState: () => Promise.resolve(state) })?.browserState?.("/p"), {
    ...state, title: "", commenting: false, composing: false,
  })
})

test("browserAction passes the project and action through and swallows refusals", async () => {
  const calls: unknown[][] = []
  const bridge = readDesktopBridge({ version: 2, browserAction(...args: unknown[]) { calls.push(args); return Promise.reject(new Error("refused")) } })
  await bridge?.browserAction?.("/p", "back")
  assert.deepEqual(calls, [["/p", "back"]])
  assert.equal(readDesktopBridge({ version: 2 })?.browserAction, null)
})

test("browserFrame passes a frame or null and swallows refusals", () => {
  const calls: unknown[][] = []
  const bridge = readDesktopBridge({ version: 2, browserFrame(...args: unknown[]) { calls.push(args); return Promise.reject(new Error("refused")) } })
  bridge?.browserFrame?.("/p", { x: 240, y: 64, width: 800, height: 600 })
  bridge?.browserFrame?.("/p", null)
  assert.deepEqual(calls, [["/p", { x: 240, y: 64, width: 800, height: 600 }], ["/p", null]])
  assert.equal(readDesktopBridge({ version: 2 })?.browserFrame, null)
})

test("browserSnapshot resolves a base64 PNG, and null for anything else or a refusal", async () => {
  const snapshot = (value: unknown) => readDesktopBridge({ version: 2, browserSnapshot: () => Promise.resolve(value) })?.browserSnapshot?.("/p")
  assert.equal(await snapshot("iVBORw0KGgo="), "iVBORw0KGgo=")
  for (const value of [null, undefined, "", 3, { png: "x" }]) assert.equal(await snapshot(value), null)
  assert.equal(await readDesktopBridge({ version: 2, browserSnapshot: () => Promise.reject(new Error("x")) })?.browserSnapshot?.("/p"), null)
  assert.equal(readDesktopBridge({ version: 2 })?.browserSnapshot, null)
})

test("a window hosts the Browser only with experimental features on and all five methods", () => {
  const methods = { browserOpen() {}, browserState() {}, browserAction() {}, browserFrame() {}, browserSnapshot() {} }
  const on = { enabled: true, source: "env" }
  assert.equal(hostsBrowser(readDesktopBridge({ version: 2, experimental: on, ...methods })), true)
  assert.equal(hostsBrowser(readDesktopBridge({ version: 2, experimental: { enabled: false, source: "" }, ...methods })), false)
  assert.equal(hostsBrowser(readDesktopBridge({ version: 2, ...methods })), false)
  for (const missing of Object.keys(methods)) {
    assert.equal(hostsBrowser(readDesktopBridge({ version: 2, experimental: on, ...methods, [missing]: undefined })), false, missing)
  }
  assert.equal(hostsBrowser(null), false)
  assert.equal(browserAvailable(), false)
})

test("the bridge carries the app's experimental state and sets the user's choice (decision 0184)", async () => {
  const calls: unknown[] = []
  const exposed = {
    version: 2,
    experimental: { enabled: false, source: "" },
    setExperimental(this: unknown, enabled: boolean) {
      calls.push([this, enabled])
      return Promise.resolve({ enabled, source: enabled ? "setting" : "" })
    },
  }
  const bridge = readDesktopBridge(exposed)
  assert.deepEqual(bridge?.experimental, { enabled: false, source: "" })
  assert.deepEqual(await bridge?.setExperimental?.(true), { enabled: true, source: "setting" })
  assert.deepEqual(calls, [[exposed, true]])
  assert.equal(readDesktopBridge({ version: 2 })?.experimental, null)
  assert.equal(readDesktopBridge({ version: 2 })?.setExperimental, null)
  assert.equal(readDesktopBridge({ version: 2, experimental: { enabled: "yes", source: "" } })?.experimental, null)
  assert.equal(readDesktopBridge({ version: 2, experimental: { enabled: true, source: "magic" } })?.experimental, null)
  const refusing = readDesktopBridge({ version: 2, setExperimental() { return Promise.reject(new Error("refused")) } })
  assert.equal(await refusing?.setExperimental?.(true), null)
})

const pick = {
  project: "/p",
  png: "iVBORw0KGgo=",
  page: { url: "http://localhost:5173/settings", title: "Settings", viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, scroll: { x: 0, y: 1320 }, colorScheme: "dark" },
  rect: { x: 605, y: 320, width: 210, height: 48 },
  kind: "element",
  element: {
    tag: "button", box: { x: 605, y: 320, width: 210, height: 48 }, selector: "#save", name: "Save changes", text: "",
    attributes: [{ name: "type", value: "submit" }], styles: [], component: "SettingsForm › Button", source: "src/a.tsx:42", extra: 1,
  },
  canWalkUp: true,
  canWalkDown: false,
  extra: true,
}

test("a pick is read with its element's facts; absent and empty facts are left out", () => {
  assert.deepEqual(readComposerCapture(pick), {
    project: "/p", png: "iVBORw0KGgo=", page: pick.page, rect: pick.rect, kind: "element",
    element: {
      tag: "button", box: pick.rect, selector: "#save", name: "Save changes",
      attributes: [{ name: "type", value: "submit" }], component: "SettingsForm › Button", source: "src/a.tsx:42",
    },
    canWalkUp: true, canWalkDown: false,
  })
  // A region may name the element at its center, or none.
  assert.equal(readComposerCapture({ ...pick, kind: "region", element: null })?.element, null)
  assert.equal(readComposerCapture({ ...pick, kind: "region" })?.element?.tag, "button")
  // Walking is possible only where the app says so.
  assert.equal(readComposerCapture({ ...pick, canWalkUp: undefined, canWalkDown: "yes" })?.canWalkUp, false)
  assert.equal(readComposerCapture({ ...pick, page: { ...pick.page, title: undefined } })?.page.title, "")
})

test("anything that is not a pick is none", () => {
  for (const value of [
    null, undefined, "pick", { ...pick, project: "" }, { ...pick, png: "" }, { ...pick, png: 3 }, { ...pick, kind: "window" },
    { ...pick, rect: { x: 0, y: 0, width: "210", height: 48 } }, { ...pick, element: null }, { ...pick, element: "button" },
    { ...pick, element: { ...pick.element, tag: "" } }, { ...pick, element: { ...pick.element, box: null } },
    { ...pick, element: { ...pick.element, selector: 3 } }, { ...pick, element: { ...pick.element, styles: [{ name: "color" }] } },
    { ...pick, page: { ...pick.page, colorScheme: "sepia" } }, { ...pick, page: { ...pick.page, url: 3 } },
    { ...pick, page: { ...pick.page, viewport: { width: 0, height: 900, deviceScaleFactor: 2 } } },
    { ...pick, page: { ...pick.page, viewport: { width: 1440, height: 900, deviceScaleFactor: 0 } } },
  ]) {
    assert.equal(readComposerCapture(value), null, JSON.stringify(value))
  }
  assert.equal(readElementFacts({ tag: "a", box: pick.rect, attributes: "href" }), null)
  assert.deepEqual(readElementFacts({ tag: "a", box: pick.rect, nearby: "Docs", selectedText: null }), { tag: "a", box: pick.rect, nearby: "Docs" })
})

test("browserPins passes the project, pins, and whether they show, and swallows refusals", () => {
  const calls: unknown[][] = []
  const bridge = readDesktopBridge({ version: 2, browserPins(...args: unknown[]) { calls.push(args); return Promise.reject(new Error("refused")) } })
  const pins = [{ thread: 3, resolved: false, selector: "#save", x: 815, y: 1640 }, { thread: 1, resolved: true, x: 10, y: 20 }]
  bridge?.browserPins?.("/p", pins, true)
  bridge?.browserPins?.("/p", [], false)
  assert.deepEqual(calls, [["/p", pins, true], ["/p", [], false]])
  assert.equal(readDesktopBridge({ version: 2 })?.browserPins, null)
  assert.equal(readDesktopBridge({ version: 2, browserPins: true })?.browserPins, null)
})

test("the composer's methods read the pick, walk it, size the page, and close it", async () => {
  const calls: unknown[][] = []
  const bridge = readDesktopBridge({
    version: 2,
    composerCapture() { calls.push(["capture"]); return Promise.resolve(pick) },
    composerWalk(...args: unknown[]) { calls.push(["walk", ...args]); return Promise.resolve(args[0] === "parent" ? { ...pick, canWalkDown: true } : null) },
    composerResize(...args: unknown[]) { calls.push(["resize", ...args]); return Promise.reject(new Error("refused")) },
    composerClose(...args: unknown[]) { calls.push(["close", ...args]); return Promise.reject(new Error("refused")) },
  })
  assert.equal((await bridge?.composerCapture?.())?.project, "/p")
  assert.equal((await bridge?.composerWalk?.("parent"))?.canWalkDown, true)
  assert.equal(await bridge?.composerWalk?.("child"), null)
  bridge?.composerResize?.(212)
  await bridge?.composerClose?.(true)
  assert.deepEqual(calls, [["capture"], ["walk", "parent"], ["walk", "child"], ["resize", 212], ["close", true]])
  // Refusals and answers that are no pick are no pick.
  const refusing = readDesktopBridge({ version: 2, composerCapture: () => Promise.reject(new Error("refused")), composerWalk: () => Promise.resolve({ png: "" }) })
  assert.equal(await refusing?.composerCapture?.(), null)
  assert.equal(await refusing?.composerWalk?.("parent"), null)
  const none = readDesktopBridge({ version: 2 })
  assert.deepEqual([none?.composerCapture, none?.composerWalk, none?.composerResize, none?.composerClose], [null, null, null, null])
})

test("comments need the Browser and its pins; the composer needs experimental features and all four methods", () => {
  const on = { enabled: true, source: "env" }
  const browser = { browserOpen() {}, browserState() {}, browserAction() {}, browserFrame() {}, browserSnapshot() {} }
  assert.equal(hostsComments(readDesktopBridge({ version: 2, experimental: on, ...browser, browserPins() {} })), true)
  // Layer 3's app: the Browser without comments.
  assert.equal(hostsComments(readDesktopBridge({ version: 2, experimental: on, ...browser })), false)
  assert.equal(hostsComments(readDesktopBridge({ version: 2, experimental: on, browserPins() {} })), false)
  assert.equal(hostsComments(readDesktopBridge({ version: 2, experimental: { enabled: false, source: "" }, ...browser, browserPins() {} })), false)
  const composer = { composerCapture() {}, composerWalk() {}, composerResize() {}, composerClose() {} }
  assert.equal(hostsComposer(readDesktopBridge({ version: 2, experimental: on, ...composer })), true)
  assert.equal(hostsComposer(readDesktopBridge({ version: 2, experimental: { enabled: false, source: "off" }, ...composer })), false)
  for (const missing of Object.keys(composer)) {
    assert.equal(hostsComposer(readDesktopBridge({ version: 2, experimental: on, ...composer, [missing]: undefined })), false, missing)
  }
  assert.equal(hostsComposer(null), false)
})
