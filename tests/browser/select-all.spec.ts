import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { expect, test, type Locator, type Page } from "@playwright/test"

import { grantClipboard, readClipboard } from "./clipboard.ts"
import { fixtureRoot } from "./fixture-root.ts"
import { gitFixtureRoot } from "./git-fixture.ts"
import { gitApiOrigin } from "./ports.ts"

// Select All (decision 0174): Ctrl/Cmd+A selects the document's text while
// focus is in the document pane, and nothing elsewhere; chrome is not text.

const hasGit = existsSync(path.join(gitFixtureRoot, ".git"))

// selected describes the document selection: its text and whether it lies
// within the element.
function selected(page: Page, within: Locator) {
  return within.evaluate((element) => {
    const selection = window.getSelection()
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    return {
      text: selection?.toString() ?? "",
      inside: range !== null && !range.collapsed && element.contains(range.commonAncestorContainer),
    }
  })
}

function clearSelection(page: Page) {
  return page.evaluate(() => window.getSelection()?.removeAllRanges())
}

test("Select All in Source selects the code only and copies the file as it is", async ({ page }) => {
  await grantClipboard(page)
  await page.goto("/view?path=code%2Fmain.go")
  const source = page.getByRole("textbox", { name: /source$/ })
  await expect(source.locator('[data-line="1"]')).toBeVisible()
  await source.locator('[data-line="2"] .source-document-line-content').click()

  await page.keyboard.press("ControlOrMeta+a")
  const selection = await selected(page, source)
  expect(selection.inside).toBe(true)
  expect(selection.text).toContain("package main")
  expect(selection.text).not.toContain("Open files")

  await page.keyboard.press("ControlOrMeta+c")
  expect(await readClipboard(page)).toBe(readFileSync(path.join(fixtureRoot, "code/main.go"), "utf8"))
})

test("Select All in Format selects the formatted text", async ({ page }) => {
  await page.goto("/view?path=config%2Fsettings.json")
  await page.getByRole("button", { name: "Format", exact: true }).click()
  const formatted = page.getByRole("textbox", { name: /formatted$/ })
  await expect(formatted.locator('[data-line="1"]')).toBeVisible()
  await formatted.locator('[data-line="1"] .source-document-line-content').click()

  await page.keyboard.press("ControlOrMeta+a")
  const selection = await selected(page, formatted)
  expect(selection.inside).toBe(true)
  expect(selection.text.trim()).toMatch(/^\{[\s\S]*\}$/)
})

test("Select All in Markdown Preview selects the rendered article", async ({ page }) => {
  await page.goto("/view?path=README.md")
  await page.getByRole("button", { name: "Preview", exact: true }).click()
  const article = page.locator("article")
  await expect(article.locator("h1")).toHaveText("zero test library")
  await article.locator("h1").click()

  await page.keyboard.press("ControlOrMeta+a")
  const selection = await selected(page, article)
  expect(selection.inside).toBe(true)
  expect(selection.text).toContain("zero test library")
  expect(selection.text).not.toContain("](")
})

test("Select All selects nothing in an image or outside the document", async ({ page }) => {
  await page.goto("/view?path=assets%2Fpreview.png")
  const main = page.getByRole("main")
  await expect(main.getByRole("img")).toBeVisible()
  await main.click()
  await page.keyboard.press("ControlOrMeta+a")
  expect((await selected(page, main)).text).toBe("")

  await page.goto("/view?path=code%2Fmain.go")
  await expect(page.getByRole("textbox", { name: /source$/ }).locator('[data-line="1"]')).toBeVisible()
  await page.locator(".status-bar").click()
  await clearSelection(page)
  await page.keyboard.press("ControlOrMeta+a")
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("")
})

test("Select All selects nothing in a review", async ({ page }) => {
  test.skip(!hasGit, "git is not installed")
  await page.goto(`${gitApiOrigin}/view?project=${encodeURIComponent(gitFixtureRoot)}&review=working`)
  const main = page.getByRole("main")
  await expect(main.getByRole("region", { name: "large.txt", exact: true })).toBeVisible()
  await main.focus()
  await page.keyboard.press("ControlOrMeta+a")
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("")
})

test("text fields keep their own Select All", async ({ page }) => {
  await page.goto("/view?path=code%2Fmain.go")
  const source = page.getByRole("textbox", { name: /source$/ })
  await expect(source.locator('[data-line="1"]')).toBeVisible()
  await source.click()
  await page.keyboard.press("ControlOrMeta+f")
  const field = page.getByRole("search", { name: "Find in file" }).getByRole("textbox", { name: "Find" })
  await expect(field).toBeFocused()
  await field.fill("package")
  await field.press("End")

  await page.keyboard.press("ControlOrMeta+a")
  expect(await field.evaluate((input) => input instanceof HTMLInputElement ? [input.selectionStart, input.selectionEnd] : null))
    .toEqual([0, "package".length])
})

test("dragging across chrome selects no text", async ({ page }) => {
  await page.goto("/view?path=code%2Fmain.go")
  await expect(page.getByRole("textbox", { name: /source$/ }).locator('[data-line="1"]')).toBeVisible()
  await clearSelection(page)
  const bar = page.locator(".status-bar")
  const box = await bar.boundingBox()
  if (!box) throw new Error("status bar has no box")
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("")
})
