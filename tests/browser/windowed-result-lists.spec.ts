import { existsSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect, type Locator, type Page } from "@playwright/test"
import type {
  ChangesResponse, Commit, CommitFilesResponse, CommitsResponse, RangeFilesResponse,
} from "../../packages/contracts/src/index.ts"

import { gitFixtureRoot } from "./git-fixture.ts"
import { test } from "./live-test.ts"
import { gitApiOrigin } from "./ports.ts"
import { dragWithoutSelection, resizeBox } from "./resize.ts"

const searchFileCount = 32
const matchesPerFile = 64
const lastSearchLine = 2_000 - (searchFileCount - 1) * matchesPerFile
const searchMarker = "windowed-needle"

function searchPath(file: number) {
  return `windowed-search-${String(file).padStart(2, "0")}.txt`
}

async function openSearch(page: Page, live: { root: string; origin: string }) {
  for (let file = 1; file <= searchFileCount; file++) {
    const length = file === searchFileCount ? lastSearchLine + 1 : matchesPerFile
    const lines = Array.from({ length }, (_, index) => `${searchMarker} ${file}.${index + 1}`)
    writeFileSync(path.join(live.root, searchPath(file)), `${lines.join("\n")}\n`)
  }
  await page.goto(`${live.origin}/?project=${encodeURIComponent(live.root)}`)
  // Keys reach the workspace once its page loads (decision 0192).
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Shift+f")
  const search = page.getByRole("region", { name: "Search", exact: true })
  const input = search.getByRole("textbox", { name: "Search", exact: true })
  const tree = search.getByRole("tree", { name: "Search results" })
  const file = (number: number) => tree.getByRole("treeitem", { name: new RegExp(`^${searchPath(number).replace(".", "\\.")}\\s*,`) })
  const match = (number: number, line: number) => tree.getByRole("treeitem", {
    name: `Line ${line}: ${searchMarker} ${number}.${line}`, exact: true,
  })
  await expect(input).toBeFocused()
  await input.fill(searchMarker)
  await expect(search.getByRole("status")).toContainText("2,000+ results in 32 files")
  await expect(tree).toHaveAttribute("aria-busy", "false")
  return { search, input, tree, file, match }
}

async function wheel(page: Page, scroller: Locator, delta: number) {
  const box = await resizeBox(scroller)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, delta)
}

test("Search windows capped results and keeps roving focus through scrolling and collapse", async ({ page, live }) => {
  await page.setViewportSize({ width: 1160, height: 400 })
  const { search, input, tree, file, match } = await openSearch(page, live)
  const first = match(1, 1)
  const last = match(searchFileCount, lastSearchLine)
  await expect(first).toBeInViewport()
  await expect(last).toHaveCount(0)
  await expect(file(1)).toHaveAttribute("aria-level", "1")
  await expect(first).toHaveAttribute("aria-level", "2")
  await expectPosition(file(1), 1, searchFileCount)
  await expectPosition(first, 1, matchesPerFile)

  await input.press("ArrowDown")
  await expect(file(1)).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(first).toBeFocused()
  await wheel(page, tree, 5_000)
  await expect(first).not.toBeInViewport()
  await expect(match(1, 2)).toHaveCount(0)
  await expect(first).toBeFocused()
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)
  await expect.poll(() => tree.evaluate((element) => {
    const viewport = element.getBoundingClientRect()
    const rows = Array.from(element.querySelectorAll('[role="treeitem"][tabindex="-1"]'), (row) => row.getBoundingClientRect())
    const before = viewport.top - Math.min(...rows.map((row) => row.top))
    const after = Math.max(...rows.map((row) => row.bottom)) - viewport.bottom
    return [before, after].every((extra) => extra >= viewport.height / 2 && extra <= viewport.height * 1.25)
  })).toBe(true)

  await page.keyboard.press("End")
  await expect(last).toBeFocused()
  await expect(last).toBeInViewport({ ratio: 0.9 })
  await expectPosition(last, lastSearchLine, lastSearchLine)
  await page.keyboard.press("ArrowUp")
  await expect(match(searchFileCount, lastSearchLine - 1)).toBeFocused()
  await page.keyboard.press("Home")
  await expect(file(1)).toBeFocused()
  await expect(file(1)).toBeInViewport({ ratio: 0.9 })

  await page.keyboard.press("ArrowLeft")
  await expect(file(1)).toHaveAttribute("aria-expanded", "false")
  await expect(first).toHaveCount(0)
  await page.keyboard.press("ArrowDown")
  await expect(file(2)).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("ArrowRight")
  await expect(file(1)).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("ArrowRight")
  await expect(first).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(file(1)).toBeFocused()

  await search.getByRole("button", { name: "Collapse All" }).click()
  await expect(first).toHaveCount(0)
  // All 32 headers are mounted, even the one below the viewport.
  await expect(file(searchFileCount)).toHaveAttribute("aria-expanded", "false")
  await expect(file(searchFileCount)).not.toBeInViewport()
  await search.getByRole("button", { name: "Expand All" }).click()
  await expect(first).toBeInViewport()
  await expect(last).toHaveCount(0)
})

test("F4 wraps across the Search window and respects input, tree, and editor focus", async ({ page, live }) => {
  const { search, input, tree, file, match } = await openSearch(page, live)
  const first = match(1, 1)
  const last = match(searchFileCount, lastSearchLine)
  const main = page.getByRole("main")
  const expectLocation = (number: number, line: number) => expect.poll(() => {
    const url = new URL(page.url())
    return [url.searchParams.get("path"), url.hash]
  }).toEqual([searchPath(number), `#L${line}`])

  await search.getByRole("button", { name: "Collapse All" }).click()
  await input.press("Shift+F4")
  await expectLocation(searchFileCount, lastSearchLine)
  await expect(last).toHaveAttribute("aria-selected", "true")
  await expect(last).toBeInViewport({ ratio: 0.9 })
  await expect(input).toBeFocused()
  await page.keyboard.press("F4")
  await expectLocation(1, 1)
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect(first).toBeInViewport({ ratio: 0.9 })
  await expect(input).toBeFocused()

  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Home")
  await expect(file(1)).toBeFocused()
  await page.keyboard.press("Shift+F4")
  await expectLocation(searchFileCount, lastSearchLine)
  await expect(last).toBeFocused()
  await expect(last).toBeInViewport({ ratio: 0.9 })
  await page.keyboard.press("F4")
  await expectLocation(1, 1)
  await expect(first).toBeFocused()

  await page.keyboard.press("ArrowDown")
  await expect(match(1, 2)).toBeFocused()
  await page.keyboard.press("Enter")
  await expectLocation(1, 2)
  await expect(main).toBeFocused()
  await page.keyboard.press("Shift+F4")
  await expectLocation(1, 1)
  await expect(first).toBeInViewport({ ratio: 0.9 })
  await expect(main).toBeFocused()

  await page.keyboard.press("ControlOrMeta+b")
  await expect(tree).toBeHidden()
  await page.keyboard.press("Shift+F4")
  await expectLocation(searchFileCount, lastSearchLine)
  await expect(tree).toBeHidden()
  await page.keyboard.press("ControlOrMeta+Shift+f")
  await expect(input).toBeFocused()
  await expect(last).toHaveAttribute("aria-selected", "true")
  await expect(last).toBeInViewport({ ratio: 0.9 })
  await page.keyboard.press("F4")
  await expectLocation(1, 1)
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect(first).toBeInViewport({ ratio: 0.9 })
})

const historySize = 250
const historyPageSize = 50
const changeCount = 120
const gitProject = `${gitApiOrigin}/?project=${encodeURIComponent(gitFixtureRoot)}`

function commitHash(number: number) {
  return number.toString(16).padStart(7, "0").padEnd(40, "0")
}

const history: Commit[] = Array.from({ length: historySize }, (_, index) => ({
  hash: commitHash(index + 1),
  parents: index + 1 === historySize ? [] : [commitHash(index + 2)],
  subject: `Windowed commit ${index + 1}`,
  body: index === 0 ? "The expanded commit description wraps as this sidebar changes width. ".repeat(5).trim() : "",
  author: { name: "Test Author", email: "author@example.invalid" },
  authorTime: "2025-01-01T12:00:00Z",
}))

async function routeHistory(page: Page, failSecondPage = false) {
  const requests: { skip: number; limit: number; head: string | null }[] = []
  await page.route("**/api/commits?*", async (route) => {
    const params = new URL(route.request().url()).searchParams
    const skip = Number(params.get("skip") ?? 0)
    const limit = Number(params.get("limit") ?? historyPageSize)
    requests.push({ skip, limit, head: params.get("head") })
    if (failSecondPage && skip === historyPageSize) {
      failSecondPage = false
      await route.fulfill({ status: 503, json: { error: "History page temporarily unavailable" } })
      return
    }
    const next = Math.min(skip + limit, historySize)
    const result: CommitsResponse = {
      repository: true, branch: "feature", base: "main", range: params.get("range") === "all" ? "all" : "branch",
      query: "", path: "", head: commitHash(1), ahead: historySize, commits: history.slice(skip, next),
      more: next < historySize, next,
    }
    await route.fulfill({ json: result })
  })
  await page.route("**/api/range-files?*", async (route) => {
    const params = new URL(route.request().url()).searchParams
    const result: RangeFilesResponse = {
      from: params.get("from") ?? "", to: params.get("to") ?? "", files: [], truncated: false,
    }
    await route.fulfill({ json: result })
  })
  return requests
}

function sourceControl(page: Page) {
  return page.getByRole("region", { name: "Source Control", exact: true })
}

function scmPane(page: Page, name: "Commits" | "Uncommitted" | "Branches") {
  return sourceControl(page).getByRole("region", { name, exact: true })
}

async function desktopSourceControl(page: Page, url: string) {
  await page.goto(url)
  // Keys reach the workspace once its page loads (decision 0192).
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Shift+g")
  await expect(sourceControl(page)).toBeVisible()
}

function commitRows(page: Page) {
  const pane = scmPane(page, "Commits")
  const list = pane.getByRole("listbox", { name: "Commits", exact: true })
  const row = (number: number) => list.getByRole("option", { name: new RegExp(`^Windowed commit ${number},`) })
  return { pane, list, row, scroller: pane.locator(".compare-scroll") }
}

async function expectPosition(row: Locator, position: number, size: number) {
  await expect(row).toHaveAttribute("aria-posinset", String(position))
  await expect(row).toHaveAttribute("aria-setsize", String(size))
}

async function expectRange(page: Page, oldest: number, newest: number) {
  await expect.poll(() => {
    const { searchParams } = new URL(page.url())
    return [searchParams.get("from"), searchParams.get("to")]
  }).toEqual([commitHash(oldest), commitHash(newest)])
  await expect(page.getByRole("tab", { name: `${commitHash(oldest).slice(0, 7)}..${commitHash(newest).slice(0, 7)}`, exact: true }))
    .toHaveAttribute("aria-selected", "true")
}

test("paged Commits retries in place and selects a range across disjoint windows", async ({ page }) => {
  test.skip(!existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
  const requests = await routeHistory(page, true)
  await desktopSourceControl(page, gitProject)
  const { pane, row, scroller } = commitRows(page)
  const first = row(1)
  const last = row(historySize)
  const more = pane.getByRole("button", { name: "Load more", exact: true })
  const filter = pane.getByRole("textbox", { name: "Filter commits by message, author, or hash" })
  await expectPosition(first, 1, -1)
  await expect(row(historyPageSize)).toHaveCount(0)
  await filter.press("ArrowDown")
  await expect(first).toBeFocused()
  await page.keyboard.press("End")
  await expect(row(historyPageSize)).toBeFocused()
  await expect(row(historyPageSize)).toBeInViewport({ ratio: 0.9 })
  await expectPosition(row(historyPageSize), historyPageSize, -1)

  await more.click()
  await expect(pane.getByRole("alert")).toContainText("History page temporarily unavailable")
  await expectPosition(row(historyPageSize), historyPageSize, -1)
  for (let skip = historyPageSize; skip < historySize; skip += historyPageSize) {
    const loaded = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === "/api/commits" && url.searchParams.get("skip") === String(skip) && response.ok()
    })
    if (skip + historyPageSize === historySize) {
      await more.press("Enter")
      await expect(row(skip + 1)).toBeFocused()
    } else {
      await (skip === historyPageSize ? pane.getByRole("button", { name: "Retry", exact: true }) : more).click()
    }
    await loaded
  }
  await expect(more).toHaveCount(0)
  expect(requests.filter(({ skip }) => skip > 0)).toEqual([50, 50, 100, 150, 200].map((skip) => ({
    skip, limit: historyPageSize, head: commitHash(1),
  })))

  await filter.press("ArrowDown")
  await page.keyboard.press("Home")
  await expect(first).toBeFocused()
  await expectPosition(first, 1, historySize)
  await page.keyboard.press("Space")
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect(last).toHaveCount(0)

  await wheel(page, scroller, await scroller.evaluate((element) => element.scrollHeight))
  await expect(last).toBeInViewport({ ratio: 0.9 })
  await expect(first).toBeFocused()
  await expect(first).not.toBeInViewport()
  await expectPosition(last, historySize, historySize)
  await last.click({ modifiers: ["Shift"] })
  await expectRange(page, historySize, 1)
  await expect(last).toHaveAttribute("aria-selected", "true")
  await scroller.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2 })
  const middle = row(historySize / 2)
  await expect(middle).toBeInViewport()
  await expectPosition(middle, historySize / 2, historySize)
  await expect(middle).toHaveAttribute("aria-selected", "true")
})

test("expanded Commits remeasure after files arrive and the sidebar widens", async ({ page }) => {
  test.skip(!existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
  await page.setViewportSize({ width: 1280, height: 800 })
  await routeHistory(page)
  let releaseFiles = () => {}
  const filesReady = new Promise<void>((resolve) => { releaseFiles = resolve })
  await page.route("**/api/commit-files?*", async (route) => {
    await filesReady
    const result: CommitFilesResponse = {
      commit: commitHash(1), truncated: false,
      files: Array.from({ length: 7 }, (_, index) => ({ path: `details-${index + 1}.md`, status: "added" })),
    }
    await route.fulfill({ json: result })
  })

  try {
    await desktopSourceControl(page, gitProject)
    for (const name of ["Uncommitted", "Branches"] satisfies ("Uncommitted" | "Branches")[]) {
      const toggle = scmPane(page, name).getByRole("heading", { level: 3 }).getByRole("button")
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await toggle.click()
    }
    const { list, row, scroller } = commitRows(page)
    const first = row(1)
    const next = row(2)
    const details = list.locator(".commit-details")
    const gap = async () => {
      const [above, below] = await Promise.all([resizeBox(first), resizeBox(next)])
      return below.y - above.y - above.height
    }
    const scrollHeight = () => scroller.evaluate((element) => element.scrollHeight)
    await expect(first).toBeInViewport()
    const collapsedGap = await gap()
    await first.press("ArrowRight")
    await expect(details.getByText("Reading files…", { exact: true })).toBeVisible()
    await expect(first).toBeFocused()
    await expect(first).toHaveAccessibleDescription(/The expanded commit description wraps/)
    await expect.poll(gap).toBeGreaterThan(collapsedGap)
    const pendingGap = await gap()
    const pendingHeight = await scrollHeight()

    releaseFiles()
    await expect(details.getByText("details-7.md", { exact: true })).toBeVisible()
    await expect.poll(gap).toBeGreaterThan(pendingGap)
    await expect.poll(scrollHeight).toBeGreaterThan(pendingHeight)
    const loadedGap = await gap()
    const loadedHeight = await scrollHeight()

    const separator = page.getByRole("separator", { name: "Resize file tree" })
    await dragWithoutSelection(page, separator, { x: 220, y: 0 })
    await expect.poll(gap).toBeLessThan(loadedGap)
    await expect.poll(scrollHeight).toBeLessThan(loadedHeight)
    await first.press("End")
    await expect(row(historyPageSize)).toBeFocused()
    await expect(row(historyPageSize)).toBeInViewport({ ratio: 0.9 })
    await page.keyboard.press("Home")
    await expect(first).toBeFocused()
    await expect(details.getByText("details-7.md", { exact: true })).toBeVisible()
    await page.keyboard.press("ArrowLeft")
    await expect(details).toHaveCount(0)
    await expect.poll(gap).toBeCloseTo(collapsedGap, 0)
  } finally {
    releaseFiles()
  }
})

function changePath(number: number) {
  return `windowed-change-${String(number).padStart(3, "0")}.md`
}

function changeRows(page: Page) {
  const list = scmPane(page, "Uncommitted").getByRole("listbox", { name: "Uncommitted changes", exact: true })
  const row = (number: number) => list.getByRole("option", { name: new RegExp(`^${changePath(number).replace(".", "\\.")},`) })
  return { list, row }
}

test("flat Uncommitted moves keyboard focus across the window and reconciles live removals", async ({ page, live }) => {
  const write = (number: number) => writeFileSync(path.join(live.root, changePath(number)), `# Change ${number}\n`)
  for (let number = 1; number <= changeCount; number++) write(number)
  await desktopSourceControl(page, `${live.origin}/?project=${encodeURIComponent(live.root)}`)
  await expect(page.locator(".status-live")).toHaveAttribute("data-mode", "watching")
  const { list, row } = changeRows(page)
  const last = row(changeCount)
  await expectPosition(row(1), 1, changeCount)
  await expect(last).toHaveCount(0)
  await row(1).press("End")
  await expect(last).toBeFocused()
  await expect(last).toBeInViewport({ ratio: 0.9 })
  await expectPosition(last, changeCount, changeCount)
  await page.keyboard.press("ArrowUp")
  await expect(row(changeCount - 1)).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(last).toBeFocused()

  rmSync(path.join(live.root, changePath(1)))
  await expectPosition(last, changeCount - 1, changeCount - 1)
  await expect(last).toBeFocused()
  await expect(last).toBeInViewport({ ratio: 0.9 })

  rmSync(path.join(live.root, changePath(changeCount)))
  write(changeCount + 1)
  await expect(last).toHaveCount(0)
  const roving = list.locator('[role="option"][tabindex="0"]')
  await expect(roving).toHaveCount(1)
  await expect(roving).toBeFocused()
  await roving.press("End")
  const added = row(changeCount + 1)
  await expect(added).toBeFocused()
  await expect(added).toBeInViewport({ ratio: 0.9 })
  await expectPosition(added, changeCount - 1, changeCount - 1)
  await page.keyboard.press("Home")
  await expect(row(2)).toBeFocused()
  await expect(row(2)).toBeInViewport({ ratio: 0.9 })
})

test.describe("touch Source Control", () => {
  test.use({ viewport: { width: 390, height: 720 }, hasTouch: true, isMobile: true })

  test("the shared scroller windows both panes and a long press anchors a distant commit range", async ({ page }) => {
    test.skip(!existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
    await routeHistory(page)
    const changes: ChangesResponse = {
      repository: true, branch: "feature", truncated: false, warnings: [],
      files: Array.from({ length: changeCount }, (_, index) => ({ path: changePath(index + 1), status: "untracked" })),
    }
    await page.route("**/api/changes?*", (route) => route.fulfill({ json: changes }))
    await page.goto(gitProject)
    await page.getByRole("button", { name: "Open files" }).tap()
    await page.getByRole("button", { name: /^Source Control, / }).tap()
    const drawer = page.getByRole("dialog", { name: "Source Control" })
    const shared = drawer.locator(".scm-panes")
    const { row: change } = changeRows(page)
    const { list: commits, pane, row: commit } = commitRows(page)
    const first = commit(1)
    const last = commit(historyPageSize)
    await expect(change(1)).toBeInViewport()
    await expect(change(changeCount)).toHaveCount(0)
    await expect(last).toHaveCount(0)
    await change(1).press("End")
    await expect(change(changeCount)).toBeInViewport({ ratio: 0.9 })
    await expectPosition(change(changeCount), changeCount, changeCount)
    await expect.poll(() => shared.evaluate((element) => element.scrollTop > element.clientHeight)).toBe(true)

    const afterChanges = await shared.evaluate((element) => element.scrollTop)
    const filter = pane.getByRole("textbox", { name: "Filter commits by message, author, or hash" })
    await filter.evaluate((element) => element.scrollIntoView({ block: "center" }))
    await expect(first).toBeInViewport({ ratio: 0.9 })
    await expect(commits).not.toHaveAttribute("aria-multiselectable", "true")
    await expectPosition(first, 1, -1)

    // Playwright exposes tap in both engines, but no touch hold/release sequence.
    const touch = { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 }
    await first.dispatchEvent("pointerdown", { ...touch, buttons: 1 })
    await expect(drawer.getByText("Tap another commit to compare a range.", { exact: true })).toBeVisible()
    await first.dispatchEvent("pointerup", { ...touch, buttons: 0 })
    await first.dispatchEvent("click")
    await expect(drawer).toBeVisible()
    await pane.getByRole("button", { name: "Load more", exact: true }).scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport({ ratio: 0.9 })
    await expect(first).not.toBeInViewport()
    await expect.poll(() => shared.evaluate((element) => element.scrollTop)).toBeGreaterThan(afterChanges)
    await last.tap()
    await expect(drawer).toBeHidden()
    await expectRange(page, historyPageSize, 1)
  })
})
