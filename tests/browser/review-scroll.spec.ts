import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { expect } from "@playwright/test"
import { test } from "./live-test.ts"

// Trace screencasts add capture/paint work to every scroll frame, especially
// in software-rendered WebKit. Keep explicit screenshots and measured data.
test.use({ trace: "off" })

function lockfile(changed: boolean): string {
  return "lockfileVersion: '9.0'\npackages:\n" + Array.from({ length: 2_000 }, (_, index) => {
    const version = changed && index % 3 === 0 ? "2.0.0" : "1.0.0"
    return `  package-${index}@${version}:\n    resolution: {integrity: sha512-${"abcde".repeat(16)}}\n    engines: {node: '>=20'}\n    dependencies:\n      dependency-${index}: ${version}\n    dev: false\n`
  }).join("")
}

test("large lockfile scrolling bounds geometry work and renders the destination @extended", async ({ page, live }, info) => {
  test.skip(process.env.ZERO_BROWSER_EXTENDED !== "1", "requires extended scroll measurements")
  test.setTimeout(180_000)
  const file = path.join(live.root, "pnpm-lock.yaml")
  writeFileSync(file, lockfile(false))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  for (const args of [["add", "pnpm-lock.yaml"], ["-c", "user.name=zero", "-c", "user.email=zero@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Lockfile"]]) {
    const result = spawnSync("git", args, { cwd: live.root, env, encoding: "utf8" })
    expect(result.status, result.stderr).toBe(0)
  }
  writeFileSync(file, lockfile(true))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&review=working#f=pnpm-lock.yaml`)
  const diff = page.getByRole("region", { name: "pnpm-lock.yaml", exact: true }).locator(".diff-view")
  await expect(diff.locator("[data-line]").first()).toBeVisible({ timeout: 20_000 })
  // Wait for worker highlighting before measuring steady-state scrolling.
  await expect.poll(() => diff.locator("[data-line] span").count()).toBeGreaterThan(0)

  const reports = []
  for (const style of ["Unified", "Split"]) {
    await page.getByRole("button", { name: style, exact: true }).click()
    for (const wrap of [false, true]) {
      if (wrap) {
        await page.getByRole("button", { name: "View options" }).click()
        await page.getByRole("menuitemcheckbox", { name: "Wrap lines" }).click()
        await page.keyboard.press("Escape")
      }
      const report = await page.locator("main").evaluate(async (pane) => {
        pane.dispatchEvent(new WheelEvent("wheel"))
        pane.scrollTop = 0
        const intervals: number[] = []
        let reads = 0
        let inserted = 0
        let maxRows = 0
        const rect = Element.prototype.getBoundingClientRect
        Element.prototype.getBoundingClientRect = function () {
          reads++
          return rect.call(this)
        }
        const host = pane.querySelector(".diff-view")?.shadowRoot
        const observer = new MutationObserver((changes) => {
          for (const change of changes) inserted += change.addedNodes.length
        })
        if (host) observer.observe(host, { childList: true, subtree: true })
        try {
          let last = await new Promise<number>((resolve) => requestAnimationFrame(resolve))
          for (let frame = 0; frame < 240; frame++) {
            const now = await new Promise<number>((resolve) => requestAnimationFrame(resolve))
            intervals.push(now - last)
            last = now
            pane.scrollTop += frame < 120 ? 90 : -90
            if (frame % 30 === 0) maxRows = Math.max(maxRows, host?.querySelectorAll("[data-line]").length ?? 0)
          }
          intervals.sort((a, b) => a - b)
          return { frames: intervals.length, p50: intervals[Math.floor(intervals.length * .5)], p95: intervals[Math.floor(intervals.length * .95)],
            longFrames: intervals.filter((ms) => ms > 34).length, reads, inserted, maxRows }
        } finally {
          Element.prototype.getBoundingClientRect = rect
          observer.disconnect()
        }
      })
      reports.push({ style, wrap, ...report })
      console.log(JSON.stringify({ style, wrap, ...report }))
      expect(report.maxRows).toBeGreaterThan(0)
      expect(report.maxRows).toBeLessThan(1_000)
      // Bounds work rather than frame timing: the former linear anchor scan
      // made about 200 geometry reads per frame on the same rows.
      expect(report.reads / report.frames).toBeLessThan(80)
      await page.locator("main").evaluate((pane) => { pane.scrollTop = pane.scrollHeight })
      await expect(diff.locator("[data-line]").filter({ hasText: "package-1999@" }).first()).toBeVisible()
    }
    // Reset wrapping for the next layout.
    await page.getByRole("button", { name: "View options" }).click()
    await page.getByRole("menuitemcheckbox", { name: "Wrap lines" }).click()
    await page.keyboard.press("Escape")
  }
  await page.screenshot({ path: info.outputPath("review-end.png") })
  await info.attach("scroll-measurements", { body: JSON.stringify(reports, null, 2), contentType: "application/json" })
})
