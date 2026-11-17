import { expect } from "@playwright/test"

import { test } from "./live-test.ts"
import { gitFixtureRoot } from "./git-fixture.ts"
import { gitApiOrigin } from "./ports.ts"

test.use({ seed: gitFixtureRoot })

test("sidebar saves the latest pointer position when release precedes the next frame", async ({ page }) => {
  await page.goto(`${gitApiOrigin}/?project=${encodeURIComponent(gitFixtureRoot)}`)
  const separator = page.getByRole("separator", { name: "Resize file tree" })
  await separator.evaluate((element) => {
    element.addEventListener("pointerdown", (event) => {
      if (event instanceof PointerEvent) element.setAttribute("data-test-pointer", String(event.pointerId))
    }, { once: true })
  })
  const box = await separator.boundingBox()
  if (!box) throw new Error("Sidebar separator not found")
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 80)
  await page.mouse.down()
  // One browser task cannot paint between these moves and release.
  await separator.evaluate((element, startX) => {
    const pointerId = Number(element.getAttribute("data-test-pointer"))
    for (const delta of [16, 64, 97]) {
      element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId, isPrimary: true, buttons: 1, clientX: startX + delta }))
    }
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId, isPrimary: true }))
  }, x)
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
