import { existsSync } from "node:fs"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { gitFixtureRoot } from "./git-fixture.ts"
import { gitApiOrigin } from "./ports.ts"

// Find in file (decision 0172): Ctrl/Cmd+F opens a bar under the document
// toolbar that paints every match in the shown view and steps through them.

const project = encodeURIComponent(gitFixtureRoot)
const hasGit = existsSync(path.join(gitFixtureRoot, ".git"))

function bar(page: Page) {
  return page.getByRole("search", { name: "Find in file" })
}

function findField(page: Page) {
  return bar(page).getByRole("textbox", { name: "Find" })
}

function count(page: Page) {
  return bar(page).getByRole("status")
}

// highlighted counts the ranges in each find highlight.
function highlighted(page: Page) {
  return page.evaluate(() => ({
    matches: CSS.highlights.get("zero-find-match")?.size ?? 0,
    current: CSS.highlights.get("zero-find-current")?.size ?? 0,
  }))
}

test("Ctrl/Cmd+F finds text in Source, steps to matches off screen, and wraps", async ({ page }) => {
  test.skip(!hasGit, "git is not installed")
  await page.goto(`${gitApiOrigin}/view?project=${project}&path=large.txt`)
  const source = page.getByRole("textbox", { name: /source$/ })
  await expect(source.locator('[data-line="1"]')).toBeVisible()
  await source.click()

  await page.keyboard.press("ControlOrMeta+f")
  await expect(findField(page)).toBeFocused()
  await findField(page).fill("dog, step 35")
  // Line 36 holds step 35; lines 351-360 hold steps 350-359.
  await expect(count(page)).toHaveText("1 of 11")
  await expect.poll(() => highlighted(page)).toEqual({ matches: 10, current: 1 })
  await expect(page.locator(".find-ruler-tick").first()).toBeAttached()

  await findField(page).press("Enter")
  await expect(count(page)).toHaveText("2 of 11")
  await expect(source.locator('[data-line="351"]')).toBeInViewport()

  await findField(page).press("Shift+Enter")
  await findField(page).press("Shift+Enter")
  await expect(count(page)).toHaveText("11 of 11")
  await expect(source.locator('[data-line="360"]')).toBeInViewport()
  await page.keyboard.press("F3")
  await expect(count(page)).toHaveText("1 of 11")

  await findField(page).press("Escape")
  await expect(bar(page)).toHaveCount(0)
  await expect(source).toBeFocused()
  await expect.poll(() => highlighted(page)).toEqual({ matches: 0, current: 0 })

  // Reopening keeps the last query, selected for typing over.
  await page.keyboard.press("ControlOrMeta+f")
  await expect(findField(page)).toHaveValue("dog, step 35")
  await expect(count(page)).toHaveText("1 of 11")
})

test("a one-line text selection seeds the query; options and invalid expressions show in the count", async ({ page }) => {
  await page.goto("/view?path=code%2Fmain.go")
  const source = page.getByRole("textbox", { name: "Go source" })
  await expect(source.locator('[data-line="2"]')).toBeVisible()
  await source.locator('[data-line="2"] .source-document-line-content').evaluate((content) => {
    const range = document.createRange()
    range.selectNodeContents(content)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await source.focus()
  await page.keyboard.press("ControlOrMeta+f")
  await expect(findField(page)).toHaveValue("package main")
  // Case-insensitive: line 1's "Package main" matches too.
  await expect(count(page)).toHaveText("1 of 2")

  await findField(page).fill("main")
  await expect(count(page)).toHaveText("1 of 3")
  await findField(page).fill("Main")
  await findField(page).press("Alt+c")
  await expect(bar(page).getByRole("button", { name: "Match Case" })).toHaveAttribute("aria-pressed", "true")
  await expect(count(page)).toHaveText("No results")
  await findField(page).press("Alt+c")

  await findField(page).press("Alt+r")
  await findField(page).fill("(")
  await expect(findField(page)).toHaveAttribute("aria-invalid", "true")
  await expect(count(page)).toHaveText("Invalid regular expression.")
  await findField(page).fill("ma.n")
  await expect(count(page)).toHaveText("1 of 3")
})

test("Find in Selection keeps matches within the selected lines", async ({ page }) => {
  await page.goto("/view?path=code%2Fmain.go#L6-L8")
  const source = page.getByRole("textbox", { name: "Go source" })
  await expect(source.locator('[data-line="6"]')).toHaveClass(/selected/)
  await source.focus()
  await page.keyboard.press("ControlOrMeta+f")
  await findField(page).fill("main")
  await expect(count(page)).toHaveText("1 of 3")
  await findField(page).press("Alt+l")
  await expect(bar(page).getByRole("button", { name: "Find in Selection" })).toHaveAttribute("aria-pressed", "true")
  await expect(count(page)).toHaveText("1 of 1")

  await source.press("Escape")
  await expect(page).not.toHaveURL(/#/)
  await expect(bar(page).getByRole("button", { name: "Find in Selection" })).toHaveAttribute("aria-disabled", "true")
  await expect(count(page)).toHaveText("1 of 3")
})

test("find reads Markdown Preview's rendered text and Format's formatted text", async ({ page }) => {
  await page.goto("/view?path=README.md")
  const preview = page.getByRole("button", { name: "Preview", exact: true })
  await preview.click()
  await expect(page.locator("article h1")).toHaveText("zero test library")
  await page.keyboard.press("ControlOrMeta+f")
  // Rendered text reads without the Markdown's link syntax.
  await findField(page).fill("Getting started")
  await expect(count(page)).toHaveText("1 of 1")
  await findField(page).fill("](")
  await expect(count(page)).toHaveText("No results")

  // Changing the view keeps find open and searches the new text.
  await page.getByRole("button", { name: "Source", exact: true }).click()
  await expect(count(page)).toHaveText("1 of 4")

  // Another tab closes find.
  await page.goto("/view?path=config%2Fsettings.json")
  await page.getByRole("button", { name: "Format", exact: true }).click()
  await expect(page.getByRole("textbox", { name: /formatted$/ })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+f")
  await findField(page).fill("\"")
  await expect(count(page)).toHaveText(/^1 of \d+$/)
})

test("find in a review reads every diff, skips collapsed gaps, and opens a closed file", async ({ page }) => {
  test.skip(!hasGit, "git is not installed")
  await page.goto(`${gitApiOrigin}/view?project=${project}&review=working`)
  const main = page.getByRole("main")
  const large = main.getByRole("region", { name: "large.txt", exact: true })
  const toggle = large.getByRole("button", { name: /large\.txt/ }).first()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")

  await main.focus()
  await page.keyboard.press("ControlOrMeta+f")
  // Line 11 (step 10) sits in a collapsed gap between hunks.
  await findField(page).fill("Line 10:")
  await expect(count(page)).toHaveText("No results")
  // Step 380 changed: its deleted and added rows both match.
  await findField(page).fill("step 380.")
  await expect(count(page)).toHaveText("1 of 2")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(large.locator('[data-additions] [data-line="381"]')).toBeInViewport()
  await expect.poll(() => highlighted(page)).toEqual({ matches: 1, current: 1 })
  await findField(page).press("Enter")
  await expect(count(page)).toHaveText("2 of 2")
})

test("phones open find from the document toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/view?path=code%2Fmain.go")
  await expect(page.getByRole("textbox", { name: "Go source" })).toBeVisible()
  await page.getByRole("button", { name: "Find", exact: true }).click()
  await expect(findField(page)).toBeFocused()
  await findField(page).fill("fmt")
  await expect(count(page)).toHaveText("1 of 2")
  await bar(page).getByRole("button", { name: "Close" }).click()
  await expect(bar(page)).toHaveCount(0)
})
