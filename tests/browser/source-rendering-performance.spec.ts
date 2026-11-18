import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { expect, type Locator, type Page } from "@playwright/test"

import type { NavigationStatus } from "../../packages/contracts/src/index.ts"
import { buildProfilingAssets, collectProfiles, productionSample, settle } from "./feedback-profile-capture.ts"
import { test } from "./live-test.ts"

const file = "source-profile.ts"
const lineCount = 10_000
const repetitions = 5
const viewport = { width: 1440, height: 900 }
const ready: NavigationStatus = {
  supported: true, enabled: true, eligible: true, reason: "",
  server: { name: "TypeScript", language: "TypeScript", state: "ready", message: "", install: [], docs: "", memory: 0, idleMinutes: 10,
    capabilities: { definition: true, references: true } },
}

function fixture(root: string) {
  writeFileSync(path.join(root, file), Array.from({ length: lineCount }, (_, index) =>
    `export const profileLine${index + 1} = "stable source text"\n`).join(""))
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=zero", "-c", "user.email=zero@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd: root })
  git(["add", "--", file])
  git(["commit", "--quiet", "-m", "Source profile fixture"])
}

async function center(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("Source target has no position")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function watchOpening(page: Page) {
  await page.evaluate((last) => {
    const main = document.querySelector("main")
    if (!main) throw new Error("Document pane is missing")
    const selector = `.source-document [data-line="${last}"] .source-document-line-content`
    const observer = new MutationObserver(() => {
      const content = main.querySelector(selector)
      if (!content) return
      if (!performance.getEntriesByName("source-rows-attached").length) performance.mark("source-rows-attached")
      if (!content.querySelector(".hl-keyword")) return
      performance.mark("source-highlight-attached")
      observer.disconnect()
    })
    observer.observe(main, { childList: true, subtree: true })
    performance.mark("source-open-start")
  }, lineCount)
}

test.use({ trace: "off", screenshot: "off" })

test("large Source rendering measurements @extended", async ({ browser, browserName, live }, info) => {
  test.skip(browserName !== "chromium" || process.env.ZERO_BROWSER_PRODUCTION_ONLY !== "1",
    "Run the isolated CDP capture with --production-only --workers=1")
  test.setTimeout(900_000)
  fixture(live.root)
  const directory = mkdtempSync(path.join(tmpdir(), "zero-source-profile-"))
  const reports: unknown[] = []
  const save = () => writeFileSync(info.outputPath("source-rendering-measurements.json"), JSON.stringify({
    browser: browser.version(), viewport, lineCount, repetitions,
    cpu: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(), memory: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
    protocol: "One fresh browser context per repetition. Open a tracked TypeScript file from the Explorer with a controlled ready LSP and blame off. Drag lines 3–8. Hold Control and move across three identifiers. Capture ends after asserted state, two animation frames, and a 250 ms compositor tail.",
    reports,
  }, null, 2))

  try {
    const serveProfile = buildProfilingAssets(directory, "source")
    for (const build of ["production", "profiling"]) for (let run = 1; run <= repetitions; run++) {
      const context = await browser.newContext({ viewport })
      try {
        const page = await context.newPage()
        if (build === "profiling") await serveProfile(page)
        await collectProfiles(page)
        await page.addInitScript(() => localStorage.setItem("zero-settings", JSON.stringify({ inlineBlame: "off" })))
        await page.route("**/api/navigation-status?*", (route) => route.fulfill({ json: ready }))
        await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=long.md`)
        const entry = page.getByRole("treeitem", { name: file, exact: true })
        await expect(entry).toBeVisible()
        await expect(page.locator('script[src*="/@vite/client"]')).toHaveCount(0)
        const source = page.getByRole("textbox", { name: "TypeScript source" })
        const row = (line: number) => source.locator(`[data-line="${line}"]`)
        const session = await context.newCDPSession(page)
        await session.send("Performance.enable")

        const sample = async (scenario: string, action: () => Promise<unknown>) => {
          await settle(page)
          await page.evaluate(() => window.readZeroReactProfile())
          let milestones: unknown
          const interval = async () => { milestones = await action(); await settle(page) }
          if (build === "production") {
            const metrics = await productionSample(session, info.outputPath(`${scenario}-${run}.trace.json`), interval)
            const renders = await page.evaluate(() => window.readZeroReactProfile())
            expect(renders).toEqual([])
            reports.push({ build, run, scenario, metrics, milestones })
          } else {
            await interval()
            const renders = await page.evaluate(() => window.readZeroReactProfile())
            expect(renders.some(({ id }) => id === "SourceDocument")).toBe(true)
            reports.push({ build, run, scenario, renders, milestones })
          }
          save()
        }

        await sample("open", async () => {
          await watchOpening(page)
          await entry.click()
          await expect(source.locator(".source-document-line")).toHaveCount(lineCount, { timeout: 30_000 })
          await expect(row(lineCount).locator(".hl-keyword").first()).toBeAttached({ timeout: 30_000 })
          return page.evaluate(() => {
            const mark = (name: string) => {
              const entry = performance.getEntriesByName(name)[0]
              if (!entry) throw new Error(`Missing opening milestone ${name}`)
              return entry.startTime
            }
            const start = mark("source-open-start")
            return { rowsMs: mark("source-rows-attached") - start, highlightedMs: mark("source-highlight-attached") - start }
          })
        })
        await expect(page.getByText("LSP ready", { exact: true })).toBeVisible()

        const gutters = await Promise.all([3, 4, 5, 6, 7, 8].map((line) => center(row(line).locator(".source-document-line-number"))))
        const first = gutters[0]
        if (!first) throw new Error("Missing drag start")
        await page.mouse.move(first.x, first.y)
        await sample("gutter-drag", async () => {
          await page.mouse.down()
          for (const point of gutters.slice(1)) await page.mouse.move(point.x, point.y)
          await expect(source.locator(".source-document-line.selected")).toHaveCount(6)
          await expect(page).not.toHaveURL(/#/)
          await page.mouse.up()
          await expect(page).toHaveURL(/#L3-L8$/)
          await expect(row(3).getByRole("button", { name: `Copy ${file}:3-8` })).toBeVisible()
        })

        const token = (line: number) => row(line).getByText(`profileLine${line}`, { exact: true })
        await token(5).hover()
        const underline = () => page.evaluate(() => [...CSS.highlights.get("zero-navigation-link") ?? []].map(String).join())
        await sample("modifier-hover", async () => {
          await page.keyboard.down("Control")
          try {
            await expect.poll(underline).toBe("profileLine5")
            await token(6).hover()
            await expect.poll(underline).toBe("profileLine6")
            await token(7).hover()
            await expect.poll(underline).toBe("profileLine7")
          } finally {
            await page.keyboard.up("Control")
          }
          await expect(source).not.toHaveClass(/navigation-linking/)
        })
        await session.detach()
      } finally {
        await context.close()
      }
    }
  } finally {
    save()
    rmSync(directory, { recursive: true, force: true })
  }
})
