import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { expect } from "@playwright/test"
import { test } from "./live-test.ts"

// Trace screencasts add capture/paint work to every scroll frame, especially
// in software-rendered WebKit. Keep explicit screenshots and measured data.
test.use({ trace: "off" })

for (const reason of ["refresh", "many files", "wrapped many files"]) {
  test(`scrolling back after ${reason} preserves a diff's space while loading`, async ({ page, live }) => {
    test.setTimeout(90_000)
    const names = reason === "refresh" ? ["a.txt", "b.txt", "c.txt"]
      : ["a.txt", ...Array.from({ length: 31 }, (_, index) => `b${String(index).padStart(2, "0")}.txt`), "c.txt"]
    const addFile = (name: string) => {
      writeFileSync(path.join(live.root, name), Array.from({ length: 420 }, (_, line) => `${name} line ${line + 1} ${reason === "wrapped many files" && name === "a.txt" ? "long text ".repeat(60) : ""}\n`).join(""))
    }
    addFile("a.txt")
    let hold = false
    let requested = false
    let release = () => {}
    const pending = new Promise<void>((resolve) => { release = resolve })
    await page.route("**/api/diff?*", async (route) => {
      if (hold && new URL(route.request().url()).searchParams.get("path") === "a.txt") {
        requested = true
        await pending
      }
      await route.continue()
    })
    await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&review=working#f=a.txt`)
    const main = page.getByRole("main")
    const first = main.getByRole("region", { name: "a.txt", exact: true })
    const last = main.getByRole("region", { name: "c.txt", exact: true })
    await expect(first.locator("[data-line]").filter({ hasText: "a.txt line 10" }).first()).toBeVisible()
    // Start with the first rendered file, then grow the review. This isolates
    // returning to visited files from initial multi-file loading order.
    for (const name of names.slice(1)) addFile(name)
    await expect(last).toBeAttached()
    if (reason === "wrapped many files") {
      await page.getByRole("button", { name: "View options" }).click()
      await page.getByRole("menuitemcheckbox", { name: "Wrap lines" }).click()
      await page.keyboard.press("Escape")
      await page.waitForTimeout(250)
    }
    const height = await first.evaluate((element) => element.getBoundingClientRect().height)
    expect(height).toBeGreaterThan(5_000)
    await main.evaluate((element) => { element.dispatchEvent(new WheelEvent("wheel")) })
    // Load intervening sections before positioning at the last file. Their
    // first load legitimately grows the document from its initial placeholders.
    for (const name of names.slice(1)) {
      const section = main.getByRole("region", { name, exact: true })
      if (reason === "wrapped many files") await page.evaluate((file) => { location.hash = `f=${file}` }, name)
      else await section.evaluate((element) => element.scrollIntoView({ block: "start" }))
      await expect(section.locator(".diff-view")).toBeAttached()
      await section.evaluate((element) => element.scrollIntoView({ block: "start" }))
      await expect(section.locator("[data-line]").first()).toBeVisible()
      await main.evaluate((element) => element.dispatchEvent(new WheelEvent("wheel")))
    }
    await expect(last.locator("[data-line]").first()).toBeVisible()
    await expect(first.locator("[data-line]")).toHaveCount(0)

    // The renderer and its measurements survive beyond the old cache limit.
    await expect(first.locator(".diff-view")).toBeAttached()
    if (reason !== "refresh") expect(await main.locator(".diff-view").count()).toBeGreaterThan(30)
    const pendingHeight = await first.evaluate((element) => element.getBoundingClientRect().height)
    const returnTop = reason === "wrapped many files" ? height - 1_400 : 1_400
    hold = true
    try {
      // Refresh invalidates offscreen files too. Their later read must not
      // discard the previous content or its measured geometry.
      await page.clock.setFixedTime(new Date(Date.now() + 60_000))
      const changes = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/changes")
      const refreshed = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname === "/api/diff" && url.searchParams.get("path") === "c.txt"
      })
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      await (await changes).finished()
      await (await refreshed).finished()
      await main.evaluate((element, top) => { element.scrollTop = top }, returnTop)
      await expect.poll(() => requested).toBe(true)
      await page.waitForTimeout(250)
      const loadedHeight = await first.evaluate((element) => element.getBoundingClientRect().height)
      // Wrapped rows newly measured on this scroll can grow the file. The
      // unchanged response must retain that measured layout afterwards.
      if (reason === "wrapped many files") expect(loadedHeight).toBeGreaterThanOrEqual(pendingHeight)
      else expect(loadedHeight).toBeCloseTo(height, 0)
      const loadedTop = await main.evaluate((element) => element.scrollTop)
      if (reason !== "wrapped many files") expect(loadedTop).toBeCloseTo(returnTop, 0)
      await expect(first).toBeInViewport()
      release()
      await expect(first.locator("[data-line]").first()).toBeAttached()
      await expect(first.getByText("Loading diff…")).toHaveCount(0)
      await expect(first).toBeInViewport()
      await page.waitForTimeout(250)
      expect(await main.evaluate((element) => element.scrollTop)).toBeCloseTo(loadedTop, 0)
      expect(await first.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(loadedHeight, 0)
      await expect(page).toHaveURL(reason === "wrapped many files" ? /#f=c\.txt$/ : /#f=a\.txt$/)
    } finally {
      hold = false
      release()
    }
  })
}

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
