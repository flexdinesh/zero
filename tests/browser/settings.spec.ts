import { expect, test } from "@playwright/test"
import { rootParam } from "./fixture-root.ts"

test("shared list buttons keep selection and focus inside the scrollbar lane", async ({ page }) => {
  await page.goto(`/?project=${rootParam}`)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const categories = page.getByRole("navigation", { name: "Settings categories" })
  const row = categories.getByRole("button", { name: "Code Navigation" })
  await row.click()
  await row.press("Space")
  const paint = await row.evaluate((element) => {
    const row = getComputedStyle(element)
    const state = getComputedStyle(element, "::before")
    return {
      inset: Number.parseFloat(state.right),
      contentInset: Number.parseFloat(row.paddingRight),
      background: state.backgroundColor,
      shadow: state.boxShadow,
      outline: state.outlineStyle,
      rowShadow: row.boxShadow,
      rowOutline: row.outlineStyle,
    }
  })
  expect(paint.inset).toBeGreaterThan(0)
  expect(paint.contentInset - paint.inset).toBe(4)
  expect(paint.background).not.toBe("rgba(0, 0, 0, 0)")
  expect(paint.shadow).not.toBe("none")
  expect(paint.outline).toBe("solid")
  expect(paint.rowShadow).toBe("none")
  expect(paint.rowOutline).toBe("none")
})

test("settings categories, global search, and modified filter compose and recover", async ({ page }) => {
  await page.goto(`/?project=${rootParam}`)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  const categories = dialog.getByRole("navigation", { name: "Settings categories" })
  const search = dialog.getByRole("searchbox", { name: "Search settings" })
  const modified = dialog.getByRole("button", { name: "Show modified settings" })
  await expect(search).toBeFocused()
  await expect(dialog.getByRole("status")).toHaveText("6 settings")
  // A browser cannot show desktop notifications, so it offers no settings for them.
  await expect(categories.getByRole("button", { name: "Notifications" })).toHaveCount(0)
  await categories.getByRole("button", { name: "Code Navigation" }).click()
  await expect(dialog.getByRole("combobox", { name: "Code Navigation: Language Servers" })).toBeVisible()
  await expect(dialog.getByRole("spinbutton")).toHaveCount(0)
  await search.fill("nord")
  await expect(dialog.getByRole("status")).toHaveText("1 setting")
  const theme = dialog.getByRole("combobox", { name: "Appearance: Theme" })
  await theme.selectOption("nord")
  await modified.click()
  await expect(modified).toHaveAttribute("aria-pressed", "true")
  await expect(theme).toHaveValue("nord")
  await dialog.getByRole("button", { name: "Reset Theme", exact: true }).click()
  await expect(modified).toBeFocused()
  await expect(dialog.getByRole("status")).toHaveText("0 settings")
  await dialog.getByRole("button", { name: "Clear filters" }).click()
  await expect(search).toBeFocused()
  await expect(dialog.getByRole("status")).toHaveText("6 settings")
  await search.fill("nothing matches")
  await dialog.getByRole("button", { name: "Clear settings search" }).click()
  await expect(search).toHaveValue("")
  await expect(search).toBeFocused()
  await search.fill("font")
  await dialog.getByRole("spinbutton").focus()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(search).toHaveValue("")
  await expect(search).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused()
})

test("settings keeps controls and footer reachable on short desktop and mobile", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 480 }, { width: 390, height: 667 }]) {
    await page.setViewportSize(viewport)
    await page.goto(`/?project=${rootParam}`)
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
    const font = dialog.getByRole("spinbutton", { name: "Appearance: Font Size" })
    await font.fill("20")
    const categories = dialog.getByRole("navigation", { name: "Settings categories" })
    await categories.getByRole("button", { name: "Code Navigation" }).click()
    const servers = dialog.getByRole("combobox", { name: "Code Navigation: Language Servers" })
    await servers.scrollIntoViewIfNeeded()
    await expect(servers).toBeInViewport()
    const reset = dialog.getByRole("button", { name: "Reset all", exact: true })
    await expect(reset).toBeInViewport()
    await reset.click()
    await expect(dialog.getByRole("searchbox")).toBeFocused()
    await dialog.getByRole("button", { name: "Close settings" }).click()
  }
})
