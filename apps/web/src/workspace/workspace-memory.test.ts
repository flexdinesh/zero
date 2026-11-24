import assert from "node:assert/strict"
import test from "node:test"

import {
  emptyMemory,
  forgetProject,
  lastProject,
  missingTabs,
  parseMemory,
  projectMemory,
  rememberExpanded,
  rememberProject,
  rememberScan,
  rememberedProjects,
  restoreTabs,
  restoreExpanded,
  scanConfirmed,
  startupTab,
  type ProjectMemory,
} from "./workspace-memory.ts"
import { browserTab, documentTab, reviewTab, screenTab, welcomeTab, type TabFeatures } from "./workspace-tabs.ts"

const working = reviewTab({ kind: "working" })
// every is a window that offers the Browser and screen tabs.
const every: TabFeatures = { browser: true, browserTabs: true, screens: true }

const docs = (...paths: string[]) => paths.map((path) => documentTab(path))

test("a project opens on its remembered tab, else Welcome when nothing was restored", () => {
  const readme = documentTab("README.md")
  assert.deepEqual(startupTab(null, { tabs: [readme], active: readme }, true), readme)
  assert.deepEqual(startupTab(null, { tabs: [], active: null }, true), welcomeTab())
  assert.equal(startupTab(null, { tabs: [], active: null }, false), null)
  // Restored tabs without an active one keep the pane empty.
  assert.equal(startupTab(null, { tabs: [readme], active: null }, true), null)
  // A routed tab wins over memory and Welcome.
  assert.equal(startupTab(working, { tabs: [], active: null }, true), null)
  assert.equal(startupTab(working, { tabs: [readme], active: readme }, true), null)
})

test("the Welcome tab is remembered like any tab", () => {
  const memory = rememberProject(emptyMemory, "/r", "/r", [welcomeTab(), documentTab("a.md")], welcomeTab())
  assert.deepEqual(restoreTabs(projectMemory(memory, "/r"), new Set(["a.md"]), every), { tabs: [welcomeTab(), documentTab("a.md")], active: welcomeTab() })
})

test("memory shares a project's tabs across sessions and keeps the last project per session key", () => {
  let memory = rememberProject(emptyMemory, "/a", "/a/api", docs("README.md", "go.mod"), documentTab("go.mod"))
  memory = rememberProject(memory, "/a\n/b", "/b/web", docs("other.md"), documentTab("other.md"))
  assert.deepEqual(projectMemory(memory, "/a/api"), { tabs: ["README.md", "go.mod"], active: "go.mod" })
  assert.deepEqual(projectMemory(memory, "/b/web"), { tabs: ["other.md"], active: "other.md" })
  assert.equal(lastProject(memory, "/a"), "/a/api")
  assert.equal(lastProject(memory, "/a\n/b"), "/b/web")
  assert.equal(lastProject(memory, "/b\n/a"), "")
  assert.equal(projectMemory(memory, "/a/web"), undefined)
})

test("the daemon session keeps its own last project beside CLI sessions", () => {
  let memory = rememberProject(emptyMemory, "/a", "/a/api", [], null)
  memory = rememberProject(memory, "daemon", "/b/web", [], null)
  assert.equal(lastProject(memory, "daemon"), "/b/web")
  assert.equal(lastProject(memory, "/a"), "/a/api")
  memory = rememberProject(memory, "daemon", "/a/api", [], null)
  assert.equal(lastProject(memory, "daemon"), "/a/api")
  assert.deepEqual(memory.last, { "/a": "/a/api", daemon: "/a/api" })
})

test("CLI memory stored under served roots keeps reopening", () => {
  const stored = parseMemory({ last: { "/a\n/b": "/b/web" }, projects: {} })
  assert.equal(lastProject(stored, "/a\n/b"), "/b/web")
})

test("remembering a project drops an active tab that is not open", () => {
  const memory = rememberProject(emptyMemory, "/a", "/a/api", docs("README.md"), documentTab("closed.md"))
  assert.equal(projectMemory(memory, "/a/api")?.active, "")
})

test("remembered projects list most recent first and can be forgotten", () => {
  let memory = rememberProject(emptyMemory, "/a", "/a/web", [], null)
  memory = rememberProject(memory, "/a", "/a/notes", docs("a.md"), documentTab("a.md"))
  memory = rememberProject(memory, "/a", "/a/web", [], null)
  assert.deepEqual(rememberedProjects(memory), ["/a/web", "/a/notes"])
  memory = forgetProject(memory, "/a/web")
  assert.deepEqual(memory, { last: {}, projects: { "/a/notes": { tabs: ["a.md"], active: "a.md" } } })
  memory = forgetProject(memory, "/a/missing")
  assert.deepEqual(rememberedProjects(memory), ["/a/notes"])
})

test("memory caps remembered projects", () => {
  let memory = emptyMemory
  for (let index = 0; index < 110; index++) memory = rememberProject(memory, "/a", `/a/p-${index}`, [], null)
  const projects = rememberedProjects(memory)
  assert.equal(projects.length, 100)
  assert.equal(projects[0], "/a/p-109")
  assert.equal(projects.includes("/a/p-0"), false)
})

test("restored tabs keep only files in the fresh tree", () => {
  const files = new Set(["README.md", "src/main.go"])
  assert.deepEqual(restoreTabs({ tabs: ["README.md", "gone.md", "src/main.go", "README.md"], active: "gone.md" }, files, every),
    { tabs: docs("README.md", "src/main.go"), active: null })
  assert.deepEqual(restoreTabs({ tabs: ["src/main.go"], active: "src/main.go" }, files, every),
    { tabs: docs("src/main.go"), active: documentTab("src/main.go") })
  assert.deepEqual(restoreTabs(undefined, files, every), { tabs: [], active: null })
})

test("parseMemory ignores malformed stored data", () => {
  assert.deepEqual(parseMemory(null), emptyMemory)
  assert.deepEqual(parseMemory(["x"]), emptyMemory)
  assert.deepEqual(parseMemory({ last: { "/a": 3, "/b": "/b/x" }, projects: { p: { tabs: "x" }, q: null } }),
    { last: { "/b": "/b/x" }, projects: { p: { tabs: [], active: "" } } })
  const hostile = parseMemory(JSON.parse('{"last": {"__proto__": "x"}, "projects": {"__proto__": {"tabs": ["t"]}}}'))
  assert.equal(projectMemory(hostile, "constructor"), undefined)
  assert.equal(lastProject(hostile, "toString"), "")
})

test("folder expansion and tabs preserve each other when saved independently", () => {
  let memory = rememberProject(emptyMemory, "/a", "/a/api", docs("README.md"), documentTab("README.md"))
  memory = rememberExpanded(memory, "/a/api", ["src/", "src/", "docs/"])
  memory = rememberExpanded(memory, "/a/web", [])
  memory = rememberProject(memory, "/a", "/a/api", docs("main.go"), documentTab("main.go"))
  assert.deepEqual(projectMemory(memory, "/a/api"), {
    tabs: ["main.go"], active: "main.go", expanded: ["src/", "docs/"],
  })
  assert.deepEqual(projectMemory(memory, "/a/web"), { tabs: [], active: "", expanded: [] })
  assert.equal(lastProject(memory, "/a"), "/a/api")
  assert.equal(projectMemory(forgetProject(memory, "/a/web"), "/a/web"), undefined)
})

test("restoring expansion validates fresh directories and preserves all-collapsed preference", () => {
  const directories = new Set(["src/", "docs/"])
  assert.deepEqual(restoreExpanded({ tabs: [], active: "", expanded: ["src/", "gone/", "../outside/", "main.go", "src/"] }, directories), ["src/"])
  assert.deepEqual(restoreExpanded({ tabs: [], active: "", expanded: [] }, directories), [])
  assert.equal(restoreExpanded({ tabs: [], active: "" }, directories), undefined)
  assert.equal(restoreExpanded(undefined, directories), undefined)
})

test("stored expansion is optional for existing memories and rejects malformed values", () => {
  const memory = parseMemory({ projects: {
    old: { tabs: ["a.md"], active: "a.md" },
    collapsed: { expanded: [] },
    mixed: { expanded: ["src/", 3, null] },
    invalid: { expanded: "src/" },
  } })
  assert.deepEqual(projectMemory(memory, "old"), { tabs: ["a.md"], active: "a.md" })
  assert.deepEqual(projectMemory(memory, "collapsed"), { tabs: [], active: "", expanded: [] })
  assert.deepEqual(projectMemory(memory, "mixed")?.expanded, ["src/"])
  assert.equal(projectMemory(memory, "invalid")?.expanded, undefined)
})

test("review tabs are remembered beside legacy document paths", () => {
  const tabs = [documentTab("README.md"), working]
  const memory = rememberProject(emptyMemory, "/a", "/a/api", tabs, working)
  assert.deepEqual(projectMemory(memory, "/a/api"), { tabs: ["README.md", { review: "working" }], active: { review: "working" } })
  assert.equal(projectMemory(rememberProject(emptyMemory, "/a", "/a/api", tabs, reviewTab({ kind: "branch", base: "", head: "", uncommitted: false })), "/a/api")?.active, "")
})

test("restored review tabs need no tree entry; documents still do", () => {
  const hash = "3577ec6a1b2c3d4e5f60718293a4b5c6d7e8f901"
  const commit = reviewTab({ kind: "commit", hash })
  assert.deepEqual(restoreTabs({ tabs: ["README.md", { review: "commit", commit: hash }, "removed.md"], active: { review: "commit", commit: hash } },
    new Set(["README.md"]), every), { tabs: [documentTab("README.md"), commit], active: commit })
})

test("restored snapshots need no tree entry", () => {
  const hash = "3577ec6a1b2c3d4e5f60718293a4b5c6d7e8f901"
  const snapshot = documentTab("removed.md", hash)
  assert.deepEqual(restoreTabs({ tabs: [{ path: "removed.md", at: hash }, "removed.md"], active: { path: "removed.md", at: hash } },
    new Set(["README.md"]), every), { tabs: [snapshot], active: snapshot })
})

test("per-file diff tabs stored before reviews restore as one review per compare", () => {
  const hash = "3577ec6a1b2c3d4e5f60718293a4b5c6d7e8f901"
  const memory = parseMemory({ projects: { p: {
    tabs: ["a.md", { diff: "b.md" }, { diff: "c.md" }, { commit: hash, path: "a.md" }, { commit: hash, path: "b.md" }, { diff: 3 }, "", null],
    active: { diff: "c.md" },
  } } })
  assert.deepEqual(projectMemory(memory, "p"), {
    tabs: ["a.md", { review: "working" }, { review: "working" }, { review: "commit", commit: hash }, { review: "commit", commit: hash }],
    active: { review: "working" },
  })
  assert.deepEqual(restoreTabs(projectMemory(memory, "p"), new Set(["a.md"]), every), {
    tabs: [documentTab("a.md"), working, reviewTab({ kind: "commit", hash })], active: working,
  })
})

test("Browser and screen tabs restore only where the window offers them (decision 0184)", () => {
  const memory: ProjectMemory = { tabs: ["a.md", { browser: true }, { screen: "fb-3k2q8m", thread: 5 }], active: { browser: true } }
  const files = new Set(["a.md"])
  assert.deepEqual(restoreTabs(memory, files, every), { tabs: [documentTab("a.md"), browserTab(), screenTab("fb-3k2q8m", 5)], active: browserTab() })
  assert.deepEqual(restoreTabs(memory, files, { browser: false, browserTabs: false, screens: false }), { tabs: [documentTab("a.md")], active: null })
  // Experimental features without the browser methods keep screen tabs only.
  assert.deepEqual(restoreTabs(memory, files, { browser: false, browserTabs: false, screens: true }).tabs, [documentTab("a.md"), screenTab("fb-3k2q8m", 5)])
})

test("Browser tabs past the first restore only where the app keeps a page per tab (decision 0195)", () => {
  const memory: ProjectMemory = { tabs: [{ browser: true }, { browser: true, id: 3 }], active: { browser: true, id: 3 } }
  assert.deepEqual(restoreTabs(memory, new Set(), every), { tabs: [browserTab(), browserTab(3)], active: browserTab(3) })
  assert.deepEqual(restoreTabs(memory, new Set(), { ...every, browserTabs: false }).tabs, [browserTab()])
})

test("documents restored before the tree are kept, then the removed ones go", () => {
  const memory = { tabs: ["README.md", "gone.md", { path: "gone.md", at: "a".repeat(40) }], active: "gone.md" }
  const restored = restoreTabs(memory, null, { browser: true, browserTabs: true, screens: true })
  assert.deepEqual(restored.tabs, [documentTab("README.md"), documentTab("gone.md"), documentTab("gone.md", "a".repeat(40))])
  assert.deepEqual(restored.active, documentTab("gone.md"))
  const files = new Set(["README.md"])
  // The active tab stays to say its file is gone; snapshots read git.
  assert.deepEqual(missingTabs(restored.tabs, files, documentTab("gone.md")), [])
  assert.deepEqual(missingTabs(restored.tabs, files, documentTab("README.md")), [documentTab("gone.md")])
})

// Decision 0194: a broad folder is scanned once this browser asked, and
// stays so across tab and folder memory and a reload.
test("a confirmed scan is remembered per project beside tabs and folders", () => {
  const readme = documentTab("README.md")
  let memory = rememberScan(emptyMemory, "/home/me")
  assert.equal(scanConfirmed(memory, "/home/me"), true)
  assert.equal(scanConfirmed(memory, "/work/zero"), false)
  memory = rememberProject(memory, "daemon", "/home/me", [readme], readme)
  memory = rememberExpanded(memory, "/home/me", ["notes/"])
  assert.equal(scanConfirmed(memory, "/home/me"), true)
  const parsed = parseMemory(JSON.parse(JSON.stringify(memory)))
  assert.equal(scanConfirmed(parsed, "/home/me"), true)
  assert.deepEqual(projectMemory(parsed, "/home/me")?.expanded, ["notes/"])
  assert.equal(scanConfirmed(parseMemory({ last: {}, projects: { "/home/me": { tabs: [], active: "", scan: "yes" } } }), "/home/me"), false)
  assert.equal(scanConfirmed(forgetProject(memory, "/home/me"), "/home/me"), false)
})
