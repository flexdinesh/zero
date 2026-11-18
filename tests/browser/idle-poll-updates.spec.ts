import { expect, test, type Page, type Request } from "@playwright/test"

import type { LanguageServerState, NavigationStatus } from "../../packages/contracts/src/navigation.ts"
import type { Walkthrough, WalkthroughSummary } from "../../packages/contracts/src/walkthroughs.ts"
import { fixtureRoot, projectParam, rootParam } from "./fixture-root.ts"

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function summary(id = "first", title = "First tour", updatedAt = "2026-11-18T00:00:00Z"): WalkthroughSummary {
  return { id, title, updatedAt, stepCount: 2 }
}

function navigation(state: LanguageServerState, memory = 1_048_576): NavigationStatus {
  return {
    supported: true, enabled: true, eligible: true, reason: "",
    server: {
      name: "gopls", language: "Go", state, memory, message: state === "failed" ? "start failed" : "",
      install: [], docs: "https://go.dev/gopls/", idleMinutes: 10,
      capabilities: state === "ready" ? { definition: true, references: true } : null,
    },
  }
}

const walkthroughs = (page: Page) => page.getByRole("listbox", { name: "Walkthroughs" })
const provider = (page: Page) => page.getByTitle("Language server status", { exact: true })
const navigationPanel = (page: Page) => page.locator(".status-navigation-panel")
const walkthroughView = (page: Page) => page.locator(".walkthroughs-view")

test("status polls preserve the remembered caret for F12 and palette navigation", async ({ page }) => {
  let memory = 1_048_576
  const targets: { endpoint: string; path: string | null; column: string | null }[] = []
  await page.clock.install()
  await page.route("**/api/navigation-status?*", (route) => route.fulfill({ json: navigation("ready", memory) }))
  for (const endpoint of ["definition", "references"]) await page.route(`**/api/${endpoint}?*`, (route) => {
    const query = new URL(route.request().url()).searchParams
    targets.push({ endpoint, path: query.get("path"), column: query.get("column") })
    return route.fulfill({ json: { symbol: "Format", locations: [], server: "gopls", filtered: 0, truncated: false } })
  })
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  const source = page.getByRole("textbox", { name: "Go source" })
  await source.locator('[data-line="6"] .source-document-line-content').getByText("Format", { exact: true }).click()
  await pause(page)
  memory = 2_097_152
  await poll(page, "/api/navigation-status", 3_000)
  await source.press("F12")
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Format")
  await page.keyboard.press("Escape")
  await expect(source).toBeFocused()
  await poll(page, "/api/navigation-status", 3_000)
  await page.keyboard.press("ControlOrMeta+Shift+P")
  const palette = page.getByRole("dialog", { name: "Command palette" })
  await palette.getByRole("combobox", { name: "Command" }).fill("Find All References")
  await palette.getByRole("option", { name: "Navigation: Find All References, Shift+F12", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Format")
  expect(targets.map((target) => target.endpoint)).toEqual(["definition", "references"])
  expect(targets[0]?.path).toBe("navigation/greet.go")
  expect(targets[1]?.path).toBe(targets[0]?.path)
  expect(targets[1]?.column).toBe(targets[0]?.column)
  expect(Number(targets[0]?.column)).toBeGreaterThan(8)
})

for (const stale of ["success", "error"]) {
  test(`a changed walkthrough version replaces detail and ignores superseded ${stale}`, async ({ page }) => {
    let revision = 1
    const pending = gate()
    const handled = gate()
    let captureObsolete = (_request: Request) => {}
    const obsolete = new Promise<Request>((resolve) => { captureObsolete = resolve })
    const updatedAt = (value: number) => `2026-11-18T00:0${value}:00Z`
    await page.clock.install()
    await page.route("**/api/walkthroughs?*", (route) => route.fulfill({ json: [{ ...summary("first", `Version ${revision}`, updatedAt(revision)), stepCount: 1 }] }))
    await page.route("**/api/walkthrough?*", async (route) => {
      const requestedRevision = revision
      if (requestedRevision === 2) {
        captureObsolete(route.request())
        await pending.promise
      }
      const detail: Walkthrough = { id: "first", project: fixtureRoot, title: `Version ${requestedRevision}`,
        summaryHTML: "<p>A versioned tour</p>", steps: [{ title: "Note", bodyHTML: "<p>A note</p>" }],
        createdAt: updatedAt(1), updatedAt: updatedAt(requestedRevision) }
      await route.fulfill(requestedRevision === 2 && stale === "error"
        ? { status: 503, json: { error: "obsolete failure" } } : { json: detail })
      if (requestedRevision === 2) handled.release()
    })
    try {
      await page.goto(`/view?project=${rootParam}&wt=first`)
      await expect(page.getByRole("heading", { level: 1, name: "Version 1", exact: true })).toBeVisible()
      await pause(page)
      revision = 2
      await poll(page, "/api/walkthroughs", 5_000)
      const old = await obsolete
      const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request === old })
      revision = 3
      await poll(page, "/api/walkthroughs", 5_000)
      await aborted
      await expect(page.getByRole("heading", { level: 1, name: "Version 3", exact: true })).toBeVisible()
    } finally { pending.release() }
    await handled.promise
    await page.clock.runFor(50)
    await expect(page.getByRole("heading", { level: 1, name: "Version 3", exact: true })).toBeVisible()
    await expect(page.getByText("obsolete failure", { exact: false })).toHaveCount(0)
  })
}

async function pause(page: Page) {
  // Freeze wall time across the RPC before pausing timers. A live Date.now()
  // plus a small offset can already be in the past on a loaded browser.
  const time = await page.evaluate(() => Date.now())
  await page.clock.setFixedTime(time)
  try {
    await page.clock.pauseAt(time)
  } finally {
    await page.clock.setSystemTime(time)
  }
}

async function poll(page: Page, endpoint: string, milliseconds: number) {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint)
  await page.clock.runFor(milliseconds)
  await response
}

async function visibility(page: Page, visible: boolean) {
  await page.evaluate((visible) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visible ? "visible" : "hidden" })
    Object.defineProperty(document, "hidden", { configurable: true, value: !visible })
    document.dispatchEvent(new Event("visibilitychange"))
  }, visible)
}

test("hidden polls pause, walkthroughs catch up on visibility and focus, and navigation resumes on its tick", async ({ page }) => {
  let title = "First tour"
  let listReads = 0
  let statusReads = 0
  await page.clock.install()
  await page.route("**/api/walkthroughs?*", (route) => { listReads++; return route.fulfill({ json: [summary("first", title)] }) })
  await page.route("**/api/navigation-status?*", (route) => { statusReads++; return route.fulfill({ json: navigation("ready") }) })
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  await expect(provider(page)).toHaveText("LSP ready")
  await page.getByRole("button", { name: /^Walkthroughs/ }).click()
  await expect(walkthroughs(page).getByRole("option", { name: /^First tour/ })).toBeVisible()
  await pause(page)
  await visibility(page, false)
  const hiddenReads = { list: listReads, status: statusReads }
  await page.clock.runFor(6_000)
  expect({ list: listReads, status: statusReads }).toEqual(hiddenReads)
  title = "Visible return tour"
  const returned = page.waitForResponse("**/api/walkthroughs?*")
  await visibility(page, true)
  await returned
  await expect(walkthroughs(page).getByRole("option", { name: /^Visible return tour/ })).toBeVisible()
  expect(statusReads).toBe(hiddenReads.status)
  await poll(page, "/api/navigation-status", 3_000)
  title = "Focus return tour"
  const focused = page.waitForResponse("**/api/walkthroughs?*")
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await focused
  await expect(walkthroughs(page).getByRole("option", { name: /^Focus return tour/ })).toBeVisible()
})

async function openNavigationProject(page: Page) {
  await page.keyboard.press("Control+o")
  const picker = page.getByRole("dialog", { name: /Switch project|Open folder/ })
  await picker.getByRole("combobox").press("/")
  await picker.getByRole("combobox").fill(`${fixtureRoot}/navigation/`)
  await expect(picker.getByRole("option", { name: `Open ${fixtureRoot}/navigation/`, exact: true })).toBeVisible()
  await picker.getByRole("combobox").press("Enter")
  await expect(page).toHaveURL(new RegExp(`project=${projectParam("navigation")}`))
}

test("unchanged walkthrough polls keep the pending list and keyboard focus", async ({ page }) => {
  const pending = gate()
  const handled = gate()
  let reads = 0
  await page.clock.install()
  await page.route("**/api/walkthroughs?*", async (route) => {
    reads++
    const read = reads
    if (read === 2) await pending.promise
    // Each response is freshly decoded, including the unchanged summary.
    await route.fulfill({ json: [summary(), summary("second", "Second tour", "2026-11-17T00:00:00Z")] })
    if (read === 2) handled.release()
  })
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  await page.getByRole("button", { name: /^Walkthroughs/ }).click()
  const row = walkthroughs(page).getByRole("option", { name: /^First tour, new, 2 steps/ })
  await expect(row).toBeVisible()
  await row.focus()
  await pause(page)

  try {
    const requested = page.waitForRequest("**/api/walkthroughs?*")
    await page.clock.runFor(5_000)
    await requested
    await expect(row).toBeVisible()
    await expect(row).toBeFocused()
    await expect(walkthroughView(page).getByText("Loading walkthroughs…", { exact: true })).toHaveCount(0)
  } finally {
    pending.release()
  }
  await handled.promise
  await poll(page, "/api/walkthroughs", 5_000)
  await expect(row).toBeFocused()
  await row.press("ArrowDown")
  await expect(walkthroughs(page).getByRole("option", { name: /^Second tour/ })).toBeFocused()
})

test("walkthrough polls publish changed summaries and remove deleted badges", async ({ page }) => {
  let entries: WalkthroughSummary[] = []
  await page.clock.install()
  await page.route("**/api/walkthroughs?*", (route) => route.fulfill({ json: entries }))
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  await page.getByRole("button", { name: /^Walkthroughs/ }).click()
  await expect(walkthroughView(page)).toContainText("No walkthroughs for this project yet.")
  await page.getByRole("button", { name: "Explorer", exact: true }).click()
  await pause(page)

  entries = [summary()]
  await poll(page, "/api/walkthroughs", 5_000)
  await expect(page.getByRole("button", { name: "Walkthroughs, 1 new walkthrough", exact: true })).toBeVisible()
  entries = [{ ...summary("first", "Revised tour", "2026-11-18T00:01:00Z"), stepCount: 3 }]
  await poll(page, "/api/walkthroughs", 5_000)
  await page.getByRole("button", { name: /^Walkthroughs/ }).click()
  await expect(walkthroughs(page).getByRole("option", { name: /^Revised tour, new, 3 steps/ })).toBeVisible()
  await expect(walkthroughs(page).getByRole("option", { name: /^First tour/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Walkthroughs", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Explorer", exact: true }).click()

  entries = [summary("second", "Second tour", "2026-11-18T00:02:00Z")]
  await poll(page, "/api/walkthroughs", 5_000)
  await expect(page.getByRole("button", { name: "Walkthroughs, 1 new walkthrough", exact: true })).toBeVisible()
  entries = []
  await poll(page, "/api/walkthroughs", 5_000)
  await expect(page.getByRole("button", { name: "Walkthroughs", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Walkthroughs", exact: true }).click()
  await expect(walkthroughView(page)).toContainText("No walkthroughs for this project yet.")
})

for (const cached of ["empty", "populated"]) {
  test(`walkthrough errors remain visible over a cached ${cached} list and refresh recovers`, async ({ page }) => {
    let failing = false
    const entries = cached === "empty" ? [] : [summary()]
    await page.clock.install()
    await page.route("**/api/walkthroughs?*", (route) => route.fulfill(failing
      ? { status: 503, json: { error: "store unavailable" } }
      : { json: entries }))
    await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
    await page.getByRole("button", { name: /^Walkthroughs/ }).click()
    const cachedContent = cached === "empty"
      ? walkthroughView(page).getByText("No walkthroughs for this project yet.", { exact: true })
      : walkthroughs(page).getByRole("option", { name: /^First tour/ })
    await expect(cachedContent).toBeVisible()
    await pause(page)
    failing = true
    await poll(page, "/api/walkthroughs", 5_000)
    await expect(walkthroughView(page).getByRole("alert")).toContainText("store unavailable")
    await expect(cachedContent).toBeVisible()
    failing = false
    await walkthroughView(page).getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(walkthroughView(page).getByRole("alert")).toHaveCount(0)
    await expect(cachedContent).toBeVisible()
  })
}

test("an initial walkthrough error offers Retry and then the empty state", async ({ page }) => {
  let failing = true
  await page.route("**/api/walkthroughs?*", (route) => route.fulfill(failing
    ? { status: 503, json: { error: "store unavailable" } }
    : { json: [] }))
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  await page.getByRole("button", { name: /^Walkthroughs/ }).click()
  await expect(walkthroughView(page).getByRole("alert")).toContainText("store unavailable")
  failing = false
  await walkthroughView(page).getByRole("button", { name: "Retry", exact: true }).click()
  await expect(walkthroughView(page).getByRole("alert")).toHaveCount(0)
  await expect(walkthroughView(page)).toContainText("No walkthroughs for this project yet.")
})

test("a newer walkthrough refresh aborts a pending poll and ignores its old list", async ({ page }) => {
  const pending = gate()
  const handled = gate()
  let reads = 0
  await page.clock.install()
  await page.route("**/api/walkthroughs?*", async (route) => {
    const read = ++reads
    if (read === 2) await pending.promise
    await route.fulfill({ json: [summary("first", read === 2 ? "Obsolete tour" : read > 2 ? "Latest tour" : "First tour")] })
    if (read === 2) handled.release()
  })
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  await page.getByRole("button", { name: /^Walkthroughs/ }).click()
  await expect(walkthroughs(page).getByRole("option", { name: /^First tour/ })).toBeVisible()
  await pause(page)
  try {
    const requested = page.waitForRequest("**/api/walkthroughs?*")
    await page.clock.runFor(5_000)
    const old = await requested
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request === old })
    await walkthroughView(page).getByRole("button", { name: "Refresh", exact: true }).click()
    await aborted
    await expect(walkthroughs(page).getByRole("option", { name: /^Latest tour/ })).toBeVisible()
  } finally {
    pending.release()
  }
  await handled.promise
  await page.clock.runFor(50)
  await expect(walkthroughs(page).getByRole("option", { name: /^Latest tour/ })).toBeVisible()
  await expect(walkthroughs(page).getByRole("option", { name: /^Obsolete tour/ })).toHaveCount(0)
  await expect(walkthroughView(page).getByRole("alert")).toHaveCount(0)
})

test("a project switch aborts a walkthrough list and keeps the new project's summaries", async ({ page }) => {
  const pending = gate()
  const handled = gate()
  const requested = page.waitForRequest("**/api/walkthroughs?*")
  await page.route("**/api/walkthroughs?*", async (route) => {
    const oldProject = new URL(route.request().url()).searchParams.get("project") === fixtureRoot
    if (oldProject) await pending.promise
    await route.fulfill({ json: [summary("first", oldProject ? "Old project tour" : "Navigation tour")] })
    if (oldProject) handled.release()
  })
  try {
    await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
    const old = await requested
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request === old })
    await openNavigationProject(page)
    await aborted
    await page.getByRole("button", { name: /^Walkthroughs/ }).click()
    await expect(walkthroughs(page).getByRole("option", { name: /^Navigation tour/ })).toBeVisible()
  } finally {
    pending.release()
  }
  await handled.promise
  await expect(walkthroughs(page).getByRole("option", { name: /^Old project tour/ })).toHaveCount(0)
})

test("ready navigation polls retain the open panel and focus, update memory, and notice idle stop", async ({ page }) => {
  const pending = gate()
  const handled = gate()
  let status = navigation("ready")
  let reads = 0
  await page.clock.install()
  await page.route("**/api/navigation-status?*", async (route) => {
    reads++
    const read = reads
    if (read === 2) await pending.promise
    await route.fulfill({ json: status })
    if (read === 2) handled.release()
  })
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  await expect(provider(page)).toHaveText("LSP ready")
  await provider(page).click()
  await expect(navigationPanel(page)).toContainText("gopls is running, using 1.0 MB.")
  const check = navigationPanel(page).getByRole("button", { name: "Check again", exact: true })
  await check.focus()
  await pause(page)
  try {
    const requested = page.waitForRequest("**/api/navigation-status?*")
    await page.clock.runFor(3_000)
    await requested
    await expect(provider(page)).toHaveText("LSP ready")
    await expect(navigationPanel(page)).toBeVisible()
    await expect(check).toBeFocused()
  } finally {
    pending.release()
  }
  await handled.promise
  await poll(page, "/api/navigation-status", 3_000)
  await expect(check).toBeFocused()
  status = navigation("ready", 2_097_152)
  await poll(page, "/api/navigation-status", 3_000)
  await expect(navigationPanel(page)).toContainText("gopls is running, using 2.0 MB.")
  await expect(check).toBeFocused()
  status = navigation("stopped", 0)
  await poll(page, "/api/navigation-status", 3_000)
  await expect(provider(page)).toHaveText("LSP available")
  await expect(navigationPanel(page)).toContainText("gopls starts on the next navigation.")
  const stoppedReads = reads
  await page.clock.runFor(6_000)
  expect(reads).toBe(stoppedReads)
})

test("starting navigation polls to failure, and Check again refreshes discovery only once", async ({ page }) => {
  let status = navigation("starting", 0)
  const queries: URLSearchParams[] = []
  await page.clock.install()
  await page.route("**/api/navigation-status?*", (route) => {
    queries.push(new URL(route.request().url()).searchParams)
    return route.fulfill({ json: status })
  })
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  await expect(provider(page)).toHaveText("LSP starting…")
  await provider(page).click()
  await expect(navigationPanel(page)).toContainText("gopls is starting.")
  await pause(page)
  status = navigation("failed", 0)
  await poll(page, "/api/navigation-status", 3_000)
  await expect(provider(page)).toHaveText("LSP failed")
  await expect(navigationPanel(page)).toContainText("gopls failed: start failed")
  const failedReads = queries.length
  await page.clock.runFor(6_000)
  expect(queries).toHaveLength(failedReads)
  status = navigation("starting", 0)
  await navigationPanel(page).getByRole("button", { name: "Check again", exact: true }).click()
  await expect(provider(page)).toHaveText("LSP starting…")
  expect(queries.at(-1)?.get("refresh")).toBe("1")
  status = navigation("ready")
  await poll(page, "/api/navigation-status", 3_000)
  await expect(provider(page)).toHaveText("LSP ready")
  expect(queries.at(-1)?.has("refresh")).toBe(false)
  expect(queries.at(-1)?.get("path")).toBe("navigation/greet.go")
  expect(queries.at(-1)?.get("project")).toBe(fixtureRoot)
})

test("navigation transport failure can be retried and policy ineligibility stays explicit", async ({ page }) => {
  let failing = true
  let reads = 0
  await page.clock.install()
  await page.route("**/api/navigation-status?*", (route) => {
    reads++
    return route.fulfill(failing ? { status: 503, json: { error: "status unavailable" } } : {
      json: { supported: true, enabled: true, eligible: false, reason: "This file is ignored.", server: null },
    })
  })
  await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
  await expect(provider(page)).toHaveText("LSP unknown")
  await provider(page).click()
  await expect(navigationPanel(page)).toContainText("Could not check language server availability. Check again to retry.")
  await pause(page)
  const failedReads = reads
  await page.clock.runFor(6_000)
  expect(reads).toBe(failedReads)
  failing = false
  await navigationPanel(page).getByRole("button", { name: "Check again", exact: true }).click()
  await expect(provider(page)).toHaveText("LSP unavailable")
  await expect(navigationPanel(page)).toContainText("This file is ignored.")
  await expect(navigationPanel(page)).not.toContainText("Could not check language server availability.")
})

for (const change of ["file", "project", "settings", "binary"]) {
  test(`a ${change} switch aborts pending navigation status and ignores its late response`, async ({ page }) => {
    const pending = gate()
    const handled = gate()
    let reads = 0
    const requests: { path: string | null; project: string | null; enabled: boolean }[] = []
    await page.clock.install()
    await page.route("**/api/navigation-status?*", async (route) => {
      const read = ++reads
      if (read === 1) await pending.promise
      const enabled = route.request().headers()["x-zero-language-servers"] === "on"
      const query = new URL(route.request().url()).searchParams
      requests.push({ path: query.get("path"), project: query.get("project"), enabled })
      await route.fulfill({ json: { ...navigation(read === 1 ? "failed" : "stopped", 0), enabled } })
      if (read === 1) handled.release()
    })
    const requested = page.waitForRequest("**/api/navigation-status?*")
    try {
      await page.goto(`/view?project=${rootParam}&path=navigation%2Fgreet.go`)
      await expect(page.getByRole("textbox", { name: "Go source" })).toBeVisible()
      const old = await requested
      const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request === old })
      const tree = page.getByRole("complementary", { name: "Files" })
      if (change === "file") {
        await tree.getByRole("treeitem", { name: "format.go", exact: true }).click()
        await expect(page.getByRole("tab", { name: "format.go", exact: true })).toHaveAttribute("aria-selected", "true")
      } else if (change === "project") {
        await openNavigationProject(page)
        await tree.getByRole("treeitem", { name: "format.go", exact: true }).click()
      } else if (change === "settings") {
        await page.keyboard.press("ControlOrMeta+,")
        const settings = page.getByRole("dialog", { name: "Settings", exact: true })
        await settings.getByRole("combobox", { name: "Code Navigation: Language Servers" }).selectOption("off")
        await settings.getByRole("button", { name: "Close settings" }).click()
      } else {
        await tree.getByRole("treeitem", { name: "assets", exact: true }).click()
        await tree.getByRole("treeitem", { name: "sample.bin", exact: true }).click()
        await expect(page.getByRole("tab", { name: "sample.bin", exact: true })).toHaveAttribute("aria-selected", "true")
      }
      await aborted
      if (change !== "binary") await expect(provider(page)).toHaveText(change === "settings" ? "LSP off" : "LSP available")
    } finally {
      pending.release()
    }
    await handled.promise
    const settledReads = reads
    await pause(page)
    await page.clock.runFor(6_000)
    expect(reads).toBe(settledReads)
    if (change === "binary") {
      await expect(provider(page)).toHaveCount(0)
      expect(reads).toBe(1)
    } else {
      await expect(provider(page)).toHaveText(change === "settings" ? "LSP off" : "LSP available")
      // The held request finishes last; the current request precedes it here.
      expect(requests.at(-2)).toEqual({
        path: change === "project" ? "format.go" : change === "file" ? "navigation/format.go" : "navigation/greet.go",
        project: change === "project" ? `${fixtureRoot}/navigation` : fixtureRoot,
        enabled: change !== "settings",
      })
      await provider(page).click()
      await expect(navigationPanel(page)).not.toContainText("start failed")
    }
  })
}
