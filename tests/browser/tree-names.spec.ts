import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect, type Locator, type Page } from "@playwright/test"

import { test } from "./live-test.ts"

// Tree names read whole when they fit, else truncate once at the end; a
// compact folder chain reads as one a/b/c string (decision 0166).

const longName = "a-component-file-name-long-enough-to-overflow-any-sidebar.tsx"
const chain = "content/blog/post"

function write(root: string, file: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), "export {}\n")
}

function content(row: Locator) {
  return row.locator('[data-item-section="content"]')
}

// expectName checks a row's name is one plain string, laid out on one line
// with a trailing ellipsis, and whether it overflows.
async function expectName(row: Locator, text: string, overflows: boolean) {
  const name = content(row)
  await expect(name).toHaveText(text)
  await expect(row.locator("[data-truncate-container]")).toHaveCount(0)
  await expect(name).toHaveCSS("white-space", "nowrap")
  await expect(name).toHaveCSS("text-overflow", "ellipsis")
  expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(overflows)
}

async function seed(page: Page, live: { root: string; origin: string }) {
  write(live.root, `src/${longName}`)
  write(live.root, "src/data.ts")
  write(live.root, `${chain}/index.mdoc`)
  await page.goto(`${live.origin}/?project=${encodeURIComponent(live.root)}`)
  // Keys reach the workspace once its page loads (decision 0192).
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible()
}

test("Explorer names truncate once at the end", async ({ page, live }) => {
  await seed(page, live)
  const tree = page.getByRole("complementary", { name: "Files" })
  await tree.getByRole("treeitem", { name: "src", exact: true }).click()
  await expectName(tree.getByRole("treeitem", { name: "data.ts", exact: true }), "data.ts", false)
  await expectName(tree.getByRole("treeitem", { name: longName, exact: true }), longName, true)
  await expectName(tree.getByRole("treeitem", { name: chain.split("/").join(" / "), exact: true }), chain, false)
})

test("Source Control Files tree names truncate once at the end", async ({ page, live }) => {
  await seed(page, live)
  await page.keyboard.press("ControlOrMeta+Shift+g")
  const uncommitted = page.getByRole("region", { name: "Source Control" }).getByRole("region", { name: "Uncommitted", exact: true })
  await uncommitted.getByRole("button", { name: "View as Tree" }).click()
  await expectName(uncommitted.getByRole("treeitem", { name: "data.ts", exact: true }), "data.ts", false)
  await expectName(uncommitted.getByRole("treeitem", { name: longName, exact: true }), longName, true)
  await expectName(uncommitted.getByRole("treeitem", { name: chain.split("/").join(" / "), exact: true }), chain, false)
})
