import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect, type Locator, type Page } from "@playwright/test"

import { test } from "./live-test.ts"
import { traceScrollbars } from "./scrollbar-trace.ts"

// The live server embeds the production build. Playwright's screencast and
// screenshots would add unrelated paint work to the measured interaction.
test.use({ viewport: { width: 1280, height: 633 }, trace: "off", screenshot: "off" })

async function exercise(page: Page, area: Locator) {
  const box = await area.boundingBox()
  if (!box) throw new Error("Profile scroll area is not laid out")
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.mouse.move(box.x + box.width * 0.15, box.y + 30)
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height - 30, { steps: 240 })
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let input = 0; input < 8; input++) {
      await page.mouse.wheel(0, input % 2 === 0 ? 120 : -120)
      // Keep distinct native inputs rather than a single synthetic burst.
      await page.waitForTimeout(32)
    }
  }
  // Include the final input's presentation before ending the trace.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test("production scrollbar discovery profiles representative areas @extended", async ({ page, live, browserName, browser }, info) => {
  test.skip(browserName !== "chromium", "Chrome performance tracing requires CDP")
  test.setTimeout(180_000)
  writeFileSync(path.join(live.root, "profile.tsx"), readFileSync("apps/web/src/components/ui/overlay-scrollbars.tsx"))
  for (let index = 0; index < 180; index++) writeFileSync(path.join(live.root, `tree-${String(index).padStart(3, "0")}.ts`), `export const item = ${index}\n`)
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=profile.tsx`)
  const source = page.getByRole("textbox", { name: "TSX source" })
  await expect(source.locator(".hl-keyword").first()).toBeAttached()
  await expect(page.locator(".ui-scrollbars")).toHaveCount(1)
  // A dev server silently changes both script work and bundle boundaries.
  expect(await page.evaluate(() => [...document.scripts].some((script) => script.src.includes("/assets/")))).toBe(true)
  expect(await page.evaluate(() => [...document.scripts].some((script) => script.src.includes("/@vite/client")))).toBe(false)

  const reports: unknown[] = []
  const profile = async (name: string, area: Locator) => {
    await area.scrollIntoViewIfNeeded()
    const tracePath = info.outputPath(`${name}.chrome-trace.json`)
    const measurements = await traceScrollbars(page, tracePath, () => exercise(page, area))
    await info.attach(`${name}-chrome-trace`, { path: tracePath, contentType: "application/json" })
    expect(measurements.wheelDispatch.count).toBeGreaterThan(0)
    expect(measurements.mouseWheelLatency.count).toBeGreaterThan(0)
    reports.push({ scenario: name, measurements })
  }
  await profile("highlighted-source", page.locator("main"))

  const tree = page.locator(".file-tree-host")
  await expect(tree).toBeVisible()
  await profile("shadow-tree", tree)

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(dialog).toBeVisible()
  await profile("dialog", dialog.locator(".settings-list"))
  await expect(dialog.locator(".ui-scrollbars")).toHaveCount(1)
  await dialog.getByRole("button", { name: "Close settings" }).click()

  // A deliberately large nested area complements real product surfaces.
  // This fixture changes only the browser document, never shipped app CSS.
  await page.evaluate(() => {
    const shell = document.createElement("section")
    shell.id = "scrollbar-profile"
    shell.style.cssText = "position:fixed;inset:40px 40px 40px 350px;overflow:auto;z-index:100;background:var(--color-bg)"
    document.body.append(shell)
    let parent: Element = shell
    for (let depth = 0; depth < 24; depth++) {
      const child = document.createElement("div")
      child.style.cssText = "overflow:auto;padding:1px;min-width:0"
      parent.append(child)
      parent = child
    }
    const rows = document.createElement("div")
    rows.style.width = "1800px"
    for (let line = 0; line < 5000; line++) {
      const row = document.createElement("div")
      row.style.height = "20px"
      for (let token = 0; token < 5; token++) {
        const span = document.createElement("span")
        span.textContent = `nested-${line}-${token} `
        row.append(span)
      }
      rows.append(row)
    }
    parent.append(rows)
  })
  await profile("nested-areas", page.locator("#scrollbar-profile"))
  const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
    finePointer: matchMedia("(pointer: fine)").matches, highlightedSpans: document.querySelectorAll(".source-document span").length,
    nestedDescendants: document.querySelectorAll("#scrollbar-profile *").length }))
  await info.attach("scrollbar-measurements", { body: JSON.stringify({
    browser: browser.version(), environment, repeat: info.repeatEachIndex, cpuThrottle: 1,
    protocol: "3 cycles/area; 240-step sweep, 8 alternating +/-120px native wheel inputs spaced 32ms; 1ms CPU sampling; production embedded UI",
    limitations: "Headless container; trace overhead; native latency includes compositor scheduling, not INP; dispatch includes all listeners; no isolated React render timings",
    reports,
  }, null, 2), contentType: "application/json" })
})
