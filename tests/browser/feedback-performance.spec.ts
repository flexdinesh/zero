import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { expect } from "@playwright/test"
import { buildProfilingAssets, collectProfiles, productionSample, settle } from "./feedback-profile-capture.ts"
import { createChangedFiles, paths, region, replyText, serveFeedback, target, warmReview } from "./feedback-profile-fixture.ts"
import { test } from "./live-test.ts"

test.use({ trace: "off", screenshot: "off" })

test("many-file review feedback measurements @extended", async ({ browser, browserName, live }, info) => {
  test.skip(browserName !== "chromium" || process.env.ZERO_BROWSER_PRODUCTION_ONLY !== "1",
    "Run the isolated CDP capture with --production-only --workers=1")
  test.setTimeout(1_200_000)
  createChangedFiles(live.root)
  const viewport = { width: 1440, height: 900 }
  const directory = mkdtempSync(path.join(tmpdir(), "zero-feedback-profile-"))
  const reports: unknown[] = []
  const save = () => writeFileSync(info.outputPath("feedback-measurements.json"), JSON.stringify({
    browser: browser.version(), viewport, paths, target, threads: 256, repetitions: 5,
    cpu: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(), memory: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
    protocol: "Fresh context per repetition. Visit all files in order and return to review-00.txt. Every sample ends after the asserted state, two animation frames and 250 ms.",
    reports,
  }, null, 2))
  try {
    const serveProfile = buildProfilingAssets(directory)
    for (const build of ["production", "profiling"]) for (let run = 1; run <= 5; run++) {
      const context = await browser.newContext({ viewport })
      try {
        const page = await context.newPage()
        if (build === "profiling") await serveProfile(page)
        await collectProfiles(page)
        await serveFeedback(page, live.root)
        await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&review=working#f=${target}`)
        await warmReview(page)
        await settle(page)
        const warm = await page.evaluate(() => window.readZeroReactProfile())
        expect([...new Set(warm.map((entry) => entry.id))].sort()).toEqual(build === "production"
          ? [] : ["ReviewDocument", ...paths.map((file) => `ReviewFile:${file}`)].sort())
        const session = await context.newCDPSession(page)
        await session.send("Performance.enable")
        const sample = async (scenario: string, action: () => Promise<void>) => {
          await settle(page)
          await page.evaluate(() => window.readZeroReactProfile())
          const interval = async () => { await action(); await settle(page) }
          if (build === "production") {
            const metrics = await productionSample(session, info.outputPath(`${scenario}-${run}.trace.json`), interval)
            reports.push({ build, run, scenario, metrics })
          } else {
            await interval()
            const renders = await page.evaluate(() => window.readZeroReactProfile())
            reports.push({ build, run, scenario, renders })
          }
          save()
        }
        const first = region(page, target)
        const composer = first.getByRole("textbox", { name: `Comment on ${target}:3` })
        await sample("open-composer", async () => {
          await page.keyboard.press("c")
          await expect(composer).toBeFocused()
        })
        await sample("cancel-composer", async () => {
          await page.keyboard.press("Escape")
          await expect(composer).toHaveCount(0)
        })

        const thread = first.getByRole("region", { name: /^Thread 1: / })
        const reply = thread.getByRole("textbox", { name: "Reply to thread 1" })
        await reply.fill(replyText)
        await thread.getByRole("button", { name: "Reply", exact: true }).focus()
        await sample("reply-refresh", async () => {
          const read = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return url.pathname === "/api/feedback" && url.searchParams.get("compare") === "working"
          })
          await page.keyboard.press("Enter")
          expect(await (await read).finished()).toBeNull()
          await expect(first.getByText(replyText, { exact: true })).toBeVisible()
          await expect(reply).toHaveValue("")
        })

        const resolved = first.locator('.feedback-thread[data-status="resolved"]')
        const option = page.getByRole("menuitemcheckbox", { name: "Show resolved comments" })
        for (const show of [false, true]) {
          if (!await option.isVisible()) await page.getByRole("button", { name: /^View options/ }).click()
          await expect(option).toHaveAttribute("aria-checked", String(!show))
          await option.hover()
          await sample(show ? "show-resolved" : "hide-resolved", async () => {
            await option.click()
            await expect(resolved).toHaveCount(show ? 1 : 0)
            await expect(first.getByText(replyText, { exact: true })).toBeAttached()
          })
        }
        await session.detach()
      } finally { await context.close() }
    }
  } finally {
    save()
    rmSync(directory, { recursive: true, force: true })
  }
})
