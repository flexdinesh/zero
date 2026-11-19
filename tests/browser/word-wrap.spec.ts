import { expect, test, type Locator, type Page } from "@playwright/test"

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" })
const command = (page: Page) => palette(page).getByRole("combobox", { name: "Command" })
const source = (page: Page) => page.getByRole("textbox", { name: / source$/ })
const wrapStyle = (view: Locator) => view.locator(".source-document-line-content").first()

async function toggleWrap(page: Page, current: "On" | "Off") {
  await page.keyboard.press("F1")
  await command(page).fill("wrap")
  await expect(palette(page).getByRole("option").first()).toHaveAccessibleName(`Editor: Toggle Word Wrap, ${current}`)
  await command(page).press("Enter")
  await expect(palette(page)).toBeHidden()
}

async function openFile(page: Page, filename: string) {
  await page.keyboard.press("ControlOrMeta+P")
  const quickOpen = page.getByRole("dialog", { name: "Go to file" }).getByRole("combobox")
  await quickOpen.fill(filename)
  await quickOpen.press("Enter")
  await expect(page.getByRole("tab", { name: filename, selected: true })).toBeVisible()
}

test("the palette wraps long lines visually and remembers the choice only for the open tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/view?path=code%2Fapp.js#L2")
  const view = source(page)
  const row = view.locator('[data-line="2"]')
  const line = row.locator(".source-document-line-content")
  const overflow = () => view.evaluate((node) => node.scrollWidth - node.clientWidth)
  await expect(row).toHaveClass(/selected/)
  const original = await line.textContent()
  const unwrappedHeight = (await row.boundingBox())?.height ?? 0
  await expect.poll(overflow).toBeGreaterThan(0)

  await view.focus()
  await toggleWrap(page, "Off")
  await expect(view).toBeFocused()
  await expect.poll(overflow).toBe(0)
  await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeGreaterThan(unwrappedHeight)
  await expect(row.locator(".source-document-line-number")).toHaveCount(1)
  expect(await line.textContent()).toBe(original)
  await expect(row).toHaveClass(/selected/)
  await expect(page).toHaveURL(/#L2$/)

  await openFile(page, "settings.json")
  await expect(wrapStyle(view)).toHaveCSS("white-space", "pre")
  await page.getByRole("tab", { name: "app.js", exact: true }).click()
  await expect(wrapStyle(view)).toHaveCSS("white-space", "pre-wrap")

  await page.getByRole("button", { name: "Close code/app.js", exact: true }).click()
  await openFile(page, "app.js")
  await expect(wrapStyle(view)).toHaveCSS("white-space", "pre")
})

test("the saved default applies to Source and Format and the tab can opt out until reload", async ({ page }) => {
  await page.goto("/view?path=config%2Fsettings.json")
  await expect(wrapStyle(source(page))).toHaveCSS("white-space", "pre")

  await page.keyboard.press("F1")
  await command(page).fill("settings word wrap")
  await command(page).press("Enter")
  const settings = page.getByRole("dialog", { name: "Settings" })
  const wrap = settings.getByRole("combobox", { name: "Editor: Word Wrap" })
  await expect(wrap).toHaveValue("off")
  await wrap.selectOption("on")
  await settings.getByRole("button", { name: "Close settings" }).click()
  await expect(wrapStyle(source(page))).toHaveCSS("white-space", "pre-wrap")

  await page.getByRole("button", { name: "Format", exact: true }).click()
  const formatted = page.getByRole("textbox", { name: / formatted$/ })
  await expect(wrapStyle(formatted)).toHaveCSS("white-space", "pre-wrap")
  await toggleWrap(page, "On")
  await expect(wrapStyle(formatted)).toHaveCSS("white-space", "pre")
  await page.getByRole("button", { name: "Source", exact: true }).click()
  await expect(wrapStyle(source(page))).toHaveCSS("white-space", "pre")

  await page.reload()
  await expect(wrapStyle(source(page))).toHaveCSS("white-space", "pre-wrap")

  await openFile(page, "README.md")
  await page.getByRole("button", { name: "Preview", exact: true }).click()
  await page.keyboard.press("F1")
  await command(page).fill("wrap")
  await expect(palette(page).getByRole("option")).toHaveCount(1)
  await expect(palette(page).getByRole("option").first()).toHaveAccessibleName("Settings: Word Wrap, On")
})
