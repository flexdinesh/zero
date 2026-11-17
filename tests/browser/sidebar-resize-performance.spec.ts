import { expect } from "@playwright/test"

import { test } from "./live-test.ts"
import { gitFixtureRoot } from "./git-fixture.ts"
import { gitApiOrigin } from "./ports.ts"

test.use({ seed: gitFixtureRoot })

test("sidebar applies pointer bursts once per frame and ignores keys during the drag", async ({ page }) => {
  await page.goto(`${gitApiOrigin}/?project=${encodeURIComponent(gitFixtureRoot)}`)
  const separator = page.getByRole("separator", { name: "Resize file tree" })
  await separator.evaluate((element) => {
    element.addEventListener("pointerdown", (event) => {
      if (event instanceof PointerEvent) {
        element.setAttribute("data-test-pointer", String(event.pointerId))
        element.setAttribute("data-test-pointer-x", String(event.clientX))
      }
    }, { once: true })
    const root = document.documentElement
    let previous = root.style.getPropertyValue("--sidebar-width")
    root.dataset.sidebarUpdates = "0"
    new MutationObserver(() => {
      const width = root.style.getPropertyValue("--sidebar-width")
      if (width === previous) return
      previous = width
      root.dataset.sidebarUpdates = String(Number(root.dataset.sidebarUpdates ?? 0) + 1)
    }).observe(root, { attributes: true, attributeFilter: ["style"] })
  })
  const box = await separator.boundingBox()
  if (!box) throw new Error("Sidebar separator not found")
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 80)
  await page.mouse.down()
  const saved = await page.evaluate(() => localStorage.getItem("zero-sidebar-width"))
  await page.clock.install({ time: new Date("2026-11-17T00:00:00Z") })
  await page.clock.pauseAt(new Date("2026-11-17T00:00:01Z"))
  const pointerId = Number(await separator.getAttribute("data-test-pointer"))
  const startX = Number(await separator.getAttribute("data-test-pointer-x"))
  for (const delta of [16, 32, 64]) {
    await separator.dispatchEvent("pointermove", { pointerId, isPrimary: true, buttons: 1, clientX: startX + delta })
  }
  await expect(separator).toHaveAttribute("aria-valuenow", "288")
  expect(await page.evaluate(() => document.documentElement.dataset.sidebarUpdates)).toBe("0")
  await page.clock.runFor(16)
  await expect(separator).toHaveAttribute("aria-valuenow", "352")
  expect(await page.evaluate(() => document.documentElement.dataset.sidebarUpdates)).toBe("1")
  await separator.press("ArrowRight")
  await expect(separator).toHaveAttribute("aria-valuenow", "352")
  expect(await page.evaluate(() => localStorage.getItem("zero-sidebar-width"))).toBe(saved)
  for (const delta of [72, 80, 96]) {
    await separator.dispatchEvent("pointermove", { pointerId, isPrimary: true, buttons: 1, clientX: startX + delta })
  }
  await expect(separator).toHaveAttribute("aria-valuenow", "352")
  await page.clock.runFor(16)
  await expect(separator).toHaveAttribute("aria-valuenow", "384")
  expect(await page.evaluate(() => document.documentElement.dataset.sidebarUpdates)).toBe("2")
  await page.mouse.up()
  expect(await page.evaluate(() => localStorage.getItem("zero-sidebar-width"))).toBe("384")
  await separator.press("ArrowRight")
  await expect(separator).toHaveAttribute("aria-valuenow", "400")
})

test("sidebar saves the latest pointer position when release precedes the next frame", async ({ page }) => {
  await page.goto(`${gitApiOrigin}/?project=${encodeURIComponent(gitFixtureRoot)}`)
  const separator = page.getByRole("separator", { name: "Resize file tree" })
  await separator.evaluate((element) => {
    element.addEventListener("pointerdown", (event) => {
      if (event instanceof PointerEvent) {
        element.setAttribute("data-test-pointer", String(event.pointerId))
        element.setAttribute("data-test-pointer-x", String(event.clientX))
      }
    }, { once: true })
  })
  const box = await separator.boundingBox()
  if (!box) throw new Error("Sidebar separator not found")
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 80)
  await page.mouse.down()
  // One browser task cannot paint between these moves and release.
  await separator.evaluate((element) => {
    const pointerId = Number(element.getAttribute("data-test-pointer"))
    const startX = Number(element.getAttribute("data-test-pointer-x"))
    for (const delta of [16, 64, 97]) {
      element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId, isPrimary: true, buttons: 1, clientX: startX + delta }))
    }
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId, isPrimary: true }))
  })
  await page.mouse.up()
  await expect(separator).toHaveAttribute("aria-valuenow", "385")
  expect(await page.evaluate(() => localStorage.getItem("zero-sidebar-width"))).toBe("385")
})

for (const extended of [false, true]) {
  test(`sidebar resizing keeps storage off the drag path${extended ? " with a large diff @extended" : ""}`, async ({ page }) => {
    test.skip(extended && process.env.ZERO_BROWSER_EXTENDED !== "1", "requires the full extended git fixture")
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${gitApiOrigin}/view?project=${encodeURIComponent(gitFixtureRoot)}&review=working#f=large.txt`)
    await expect(page.locator(".diff-view [data-line-type]").first()).toBeVisible()
    const separator = page.getByRole("separator", { name: "Resize file tree" })
    const box = await separator.boundingBox()
    if (!box) throw new Error("Sidebar separator not found")
    const initial = Number(await separator.getAttribute("aria-valuenow"))
    // Count synchronous disk-backed storage work while actual pointer events
    // resize a rendered review. The final width must still survive a reload.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === "zero-sidebar-width") {
          const root = document.documentElement
          root.dataset.sidebarWrites = String(Number(root.dataset.sidebarWrites ?? 0) + 1)
        }
        return original.call(this, key, value)
      }
      document.documentElement.dataset.sidebarWrites = "0"
    })
    await page.mouse.move(box.x + box.width / 2, box.y + 80)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + 80, { steps: 24 })
    await expect(separator).toHaveAttribute("aria-valuenow", String(initial + 120))
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("")
    expect(await page.evaluate(() => document.documentElement.dataset.sidebarWrites)).toBe("0")
    await page.mouse.up()
    expect(await page.evaluate(() => document.documentElement.dataset.sidebarWrites)).toBe("1")
    expect(await page.evaluate(() => localStorage.getItem("zero-sidebar-width"))).toBe(String(initial + 120))
    await page.reload()
    await expect(separator).toHaveAttribute("aria-valuenow", String(initial + 120))
  })
}
