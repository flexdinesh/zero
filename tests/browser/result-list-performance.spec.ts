import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { expect, type Page } from "@playwright/test"
import type { ChangesResponse, Commit, CommitFilesResponse, CommitsResponse } from "../../packages/contracts/src/index.ts"
import { buildProfilingAssets, collectProfiles, productionSample, settle } from "./feedback-profile-capture.ts"
import { gitFixtureRoot } from "./git-fixture.ts"
import { test } from "./live-test.ts"

test.use({ seed: gitFixtureRoot, trace: "off", screenshot: "off" })

const viewport = { width: 1440, height: 900 }
const samples = 5
const pageSize = 50
const pageCount = 20
const pattern = "window-profile-needle"

function sequence(index: number) { return String(index).padStart(4, "0") }
function hash(index: number) { return (index + 1).toString(16).padStart(40, "0") }
function subject(index: number) { return `Window history ${sequence(index)}` }

const commits: Commit[] = Array.from({ length: pageSize * pageCount }, (_, index) => ({
  hash: hash(index), parents: index + 1 < pageSize * pageCount ? [hash(index + 1)] : [],
  subject: subject(index), body: "Commit details with text that wraps inside the sidebar. ".repeat(6),
  author: { name: "Window fixture", email: "fixture@example.test" }, authorTime: "2026-11-18T00:00:00Z",
}))
const changes: ChangesResponse = {
  repository: true, branch: "feature", truncated: false, warnings: [],
  files: Array.from({ length: 5000 }, (_, index) => ({ path: `window-changes/${sequence(index)}.ts`, status: "modified" })),
}

async function serveRows(page: Page) {
  await page.route("**/api/changes?*", (route) => route.fulfill({ json: changes }))
  await page.route("**/api/compare-stats?*", (route) => route.fulfill({ json: { files: [], budgetExceeded: false } }))
  await page.route("**/api/commits?*", (route) => {
    const params = new URL(route.request().url()).searchParams
    const skip = Number(params.get("skip") ?? 0)
    const next = skip + pageSize
    const result: CommitsResponse = {
      repository: true, branch: "feature", base: "main", range: params.get("range") === "all" ? "all" : "branch",
      head: hash(0), query: params.get("q") ?? "", path: params.get("path") ?? "", ahead: commits.length,
      commits: commits.slice(skip, next), more: next < commits.length, next,
    }
    return route.fulfill({ json: result })
  })
  await page.route("**/api/commit-files?*", (route) => {
    const commit = new URL(route.request().url()).searchParams.get("commit") ?? hash(0)
    const result: CommitFilesResponse = { commit, files: changes.files.slice(0, 20), truncated: false }
    return route.fulfill({ json: result })
  })
}

test("large sidebar list measurements @extended", async ({ browser, browserName, live }, info) => {
  test.skip(browserName !== "chromium" || process.env.ZERO_BROWSER_PRODUCTION_ONLY !== "1",
    "Run the isolated CDP capture with --production-only --workers=1")
  test.setTimeout(900_000)
  for (let index = 0; index < 101; index++) {
    writeFileSync(path.join(live.root, `window-search-${sequence(index)}.md`),
      Array.from({ length: 20 }, (_, line) => `${pattern} ${sequence(index)} line ${line + 1}\n`).join(""))
  }
  const directory = mkdtempSync(path.join(tmpdir(), "zero-result-list-profile-"))
  const reports: unknown[] = []
  const save = () => writeFileSync(info.outputPath("result-list-measurements.json"), JSON.stringify({
    viewport, browser: browser.version(), samples, pageSize, pageCount, searchMatches: 2000, changes: changes.files.length, reports,
  }, null, 2))

  try {
    const installProfile = buildProfilingAssets(directory, "workspace")
    for (const build of ["production", "profiling"]) for (let run = 1; run <= samples; run++) {
      const context = await browser.newContext({ viewport })
      try {
        const page = await context.newPage()
        if (build === "profiling") {
          await installProfile(page)
          await collectProfiles(page)
        }
        await serveRows(page)
        await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=clean.md`)
        const cdp = await context.newCDPSession(page)
        await cdp.send("Performance.enable")

        const search = page.getByRole("textbox", { name: "Search", exact: true })
        const results = page.getByRole("tree", { name: "Search results" })
        const sourceControl = page.getByRole("region", { name: "Source Control", exact: true })
        const history = sourceControl.getByRole("listbox", { name: "Commits", exact: true })
        const flat = sourceControl.getByRole("listbox", { name: "Uncommitted changes" })
        const option = (index: number) => history.getByRole("option", { name: new RegExp(`^${subject(index)},`) })
        const firstFile = flat.getByRole("option", { name: /^window-changes\/0000\.ts,/ })
        const lastFile = flat.getByRole("option", { name: /^window-changes\/4999\.ts,/ })
        const measure = async (scenario: string, action: () => Promise<unknown>, count: () => Promise<number>) => {
          await settle(page)
          if (build === "profiling") await page.evaluate(() => window.readZeroReactProfile())
          const interval = async () => {
            await page.evaluate((name) => performance.mark(`${name}-start`), scenario)
            await action()
            await settle(page)
            await page.evaluate((name) => performance.mark(`${name}-end`), scenario)
          }
          const metrics = build === "production"
            ? await productionSample(cdp, info.outputPath(`${scenario}-${run}.trace.json`), interval) : null
          if (build === "profiling") await interval()
          const profiles = build === "profiling" ? await page.evaluate(() => window.readZeroReactProfile()) : []
          reports.push({ scenario, run, build, metrics, profiles, mounted: await count() })
          save()
        }

        await page.keyboard.press("ControlOrMeta+Shift+f")
        await expect(search).toBeFocused()
        const resultCount = () => results.getByRole("treeitem").count()
        const lastMatch = results.getByRole("treeitem", { name: `Line 20: ${pattern} 0099 line 20`, exact: true })
        await measure("search-arrival", async () => {
          await search.fill(pattern)
          await expect(page.getByRole("status").filter({ hasText: "2,000+ results in 100 files" })).toBeVisible()
          await expect(results).toHaveAttribute("aria-busy", "false")
        }, resultCount)
        await measure("search-keys", async () => {
          await search.press("ArrowDown")
          await page.keyboard.press("End")
          await expect(lastMatch).toBeFocused()
          await page.keyboard.press("Home")
          await page.keyboard.press("Shift+F4")
          await expect(page).toHaveURL(/path=window-search-0099\.md#L20$/)
          await page.keyboard.press("F4")
          await expect(page).toHaveURL(/path=window-search-0000\.md#L1$/)
        }, resultCount)

        await page.keyboard.press("ControlOrMeta+Shift+g")
        await expect(firstFile).toBeVisible()
        const more = sourceControl.getByRole("button", { name: "Load more", exact: true })
        const commitCount = () => history.getByRole("option").count()
        const pageThrough = async (skip: number) => {
          const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/commits"
            && new URL(value.url()).searchParams.get("skip") === String(skip) && value.ok())
          await more.click()
          await response
          await expect(more).toHaveCount(skip / pageSize === pageCount - 1 ? 0 : 1)
        }
        for (let current = 1; current < pageCount - 1; current++) await pageThrough(current * pageSize)
        await measure("history-append", () => pageThrough((pageCount - 1) * pageSize), commitCount)
        const historyScroll = sourceControl.locator(".compare-scroll")
        await historyScroll.evaluate((element) => { element.scrollTop = 0 })
        await expect(option(0)).toBeVisible()
        await measure("history-keys-and-details", async () => {
          await option(0).focus()
          await page.keyboard.press("ArrowRight")
          await expect(history.locator(".commit-details-file").first()).toBeVisible()
          await page.keyboard.press("End")
          await expect(option(commits.length - 1)).toBeFocused()
          await page.keyboard.press("Shift+ArrowUp")
          await expect(option(commits.length - 2)).toHaveAttribute("aria-selected", "true")
          await page.keyboard.press("Home")
          await expect(option(0)).toBeFocused()
          await expect(option(0).getByRole("button", { name: "Hide commit details" })).toBeVisible()
        }, commitCount)

        await measure("flat-scroll-and-keys", async () => {
          await firstFile.focus()
          await page.keyboard.press("End")
          await expect(lastFile).toBeFocused()
          await lastFile.hover()
          const scrollTop = () => flat.locator("..").evaluate((element) => element.scrollTop)
          const before = await scrollTop()
          await page.mouse.wheel(0, -1000)
          await expect.poll(scrollTop).toBeLessThan(before - 500)
          await page.keyboard.press("Home")
          await expect(firstFile).toBeFocused()
        }, () => flat.getByRole("option").count())
      } finally {
        await context.close()
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
