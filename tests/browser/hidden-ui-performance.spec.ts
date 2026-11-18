import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { expect, type Page } from "@playwright/test"

import { buildProfilingAssets, collectProfiles, productionSample, settle } from "./feedback-profile-capture.ts"
import { createChangedFiles, serveFeedback } from "./feedback-profile-fixture.ts"
import { gitFixtureRoot } from "./git-fixture.ts"
import { test } from "./live-test.ts"

test.use({ seed: gitFixtureRoot, trace: "off", screenshot: "off" })

const viewport = { width: 1440, height: 900 }
const runs = 5
const pattern = "hidden-ui-needle"

function activity(page: Page, name: RegExp) {
  return page.getByRole("navigation", { name: "Views" }).getByRole("button", { name })
}

test("sidebar and picker work with hidden bodies @extended", async ({ browser, browserName, live }, info) => {
  test.skip(browserName !== "chromium" || process.env.ZERO_HIDDEN_UI_PROFILE !== "1", "Chromium diagnostic measurements")
  test.setTimeout(900_000)
  createChangedFiles(live.root)
  for (let index = 0; index < 32; index++) {
    writeFileSync(path.join(live.root, `hidden-${String(index).padStart(2, "0")}.ts`),
      Array.from({ length: 12 }, (_, line) => `export const line${line} = "${pattern} ${line}"\n`).join(""))
  }
  const project = encodeURIComponent(live.root)
  const url = `${live.origin}/view?project=${project}&path=src%2Fapp.ts`
  const directory = mkdtempSync(path.join(tmpdir(), "zero-hidden-ui-profile-"))
  const reports: unknown[] = []
  const save = () => writeFileSync(info.outputPath("samples.json"), JSON.stringify({
    browser: browser.version(), viewport, searchFiles: 32, linesPerFile: 12, samplesPerBuild: runs, reports,
  }))

  try {
    const installProfile = buildProfilingAssets(directory, "workspace")
    for (const profiling of [false, true]) {
      for (let run = 0; run < runs; run++) {
        const context = await browser.newContext({ viewport })
        try {
          const page = await context.newPage()
          await serveFeedback(page, live.root)
          if (run === 0 && !profiling) {
            for (let id = 0; id < 16; id++) {
              const result = await page.request.post(`${live.origin}/api/walkthroughs`, { data: {
                project: live.root, id: `hidden-ui-${id}`, title: `Hidden UI tour ${id}`, summary: "Sidebar profiling fixture",
                steps: [{ title: "Overview", body: "A note about this checkout." }],
              } })
              expect(result.status()).toBe(201)
            }
          }
          if (profiling) {
            await collectProfiles(page)
            await installProfile(page)
          }
          await page.goto(url)
          const explorer = activity(page, /^Explorer/)
          const search = activity(page, /^Search/)
          const scm = activity(page, /^Source Control/)
          const walkthroughs = activity(page, /^Walkthroughs/)
          const feedback = activity(page, /^Feedback/)
          const input = page.getByRole("textbox", { name: "Search", exact: true })
          const results = page.getByRole("tree", { name: "Search results" })
          const shell = await context.newCDPSession(page)
          await shell.send("Performance.enable")
          await expect(explorer).toBeVisible()
          await expect(feedback).toHaveAccessibleName(/open threads/)
          await expect(walkthroughs).toHaveAccessibleName(/new walkthroughs/)
          await expect(scm).toHaveAccessibleName(/pending changes/)
          await settle(page)

          const measure = async (scenario: string, action: () => Promise<void>) => {
            if (profiling) await page.evaluate(() => window.readZeroReactProfile())
            const interval = async () => {
              await page.evaluate((name) => performance.mark(`${name}-start`), scenario)
              await action()
              await settle(page)
              await page.evaluate((name) => performance.mark(`${name}-end`), scenario)
            }
            const metrics = profiling ? null
              : await productionSample(shell, info.outputPath(`${scenario}-${run}.trace.json`), interval)
            if (profiling) await interval()
            const profiles = profiling ? await page.evaluate(() => window.readZeroReactProfile()) : []
            reports.push({ scenario, run, profiling, metrics, profiles })
            save()
          }

          const tours = page.getByRole("option", { name: /Hidden UI tour/ })
          const threads = page.getByRole("listbox", { name: "Threads" })
          const commits = page.getByRole("listbox", { name: "Commits", exact: true })
          await measure("first-reveal", async () => {
            await scm.click()
            await expect(commits).toBeVisible()
            await walkthroughs.click()
            await expect(tours).toHaveCount(16)
            await feedback.click()
            await expect(threads).toBeVisible()
          })
          await page.keyboard.press("ControlOrMeta+Shift+f")
          await input.fill(pattern)
          await expect(results).toHaveAttribute("aria-busy", "false")
          await expect(results.getByRole("treeitem").filter({ hasText: pattern })).toHaveCount(384)

          await measure("repeat-switches", async () => {
            for (let index = 0; index < 3; index++) {
              await explorer.click()
              await scm.click()
              await walkthroughs.click()
              await feedback.click()
              await search.click()
            }
          })
          await measure("hidden-search-and-live-update", async () => {
            await explorer.click()
            await expect(input).toBeHidden()
            for (let index = 0; index < 6; index++) await page.keyboard.press("F4")
            await expect(page).toHaveURL(/path=hidden-00\.ts#L6$/)
            const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/changes" && response.ok())
            writeFileSync(path.join(live.root, "hidden-live.ts"), `export const live = "${run} ${profiling}"\n`)
            await refreshed
            await expect(explorer).toHaveAttribute("aria-pressed", "true")
          })

          const quick = page.getByRole("combobox", { name: "Go to file" })
          const command = page.getByRole("combobox", { name: "Command", exact: true })
          const theme = page.getByRole("combobox", { name: "Color theme" })
          await measure("picker-shortcuts", async () => {
            for (let index = 0; index < 3; index++) {
              await page.keyboard.press("F1")
              await expect(command).toBeFocused()
              await command.press("ArrowDown")
              await command.press("Escape")
              await page.keyboard.press("ControlOrMeta+p")
              await expect(quick).toBeFocused()
              await quick.fill(">color theme")
              await expect(command).toBeFocused()
              await command.press("Enter")
              await expect(theme).toBeFocused()
              await theme.press("ArrowUp")
              await theme.press("Escape")
              await expect(theme).toBeHidden()
            }
          })
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
