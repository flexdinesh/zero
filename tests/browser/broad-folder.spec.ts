import { expect, type Page } from "@playwright/test"

import { test } from "./live-test.ts"

// Decision 0194: a broad folder (here the server's home) is scanned only
// once asked; until then its stream follows git state only.
test.use({ servedAsHome: true })

const prompt = /holds too many files to scan by default\./

function explorer(page: Page) {
  return page.getByRole("complementary", { name: "Files" })
}

// leases records the lease each event stream asks for, in order.
function leases(page: Page): string[] {
  const seen: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/api/events") seen.push(url.searchParams.get("lease") ?? "open")
  })
  return seen
}

test("a broad folder asks before scanning, and remembers the answer", async ({ page, live }) => {
  const streams = leases(page)
  const trees: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/api/tree") trees.push(url.searchParams.get("scan") ?? "")
  })
  await page.goto(`${live.origin}/?project=${encodeURIComponent(live.root)}`)
  const files = explorer(page)
  await expect(files.getByText(prompt)).toBeVisible()
  await expect(files.getByRole("button", { name: "Scan files" })).toBeVisible()
  await expect(files.getByRole("button", { name: "Open Project…" })).toBeVisible()
  await expect(files.getByRole("treeitem")).toHaveCount(0)
  await expect(page.locator(".status-file-count")).toHaveCount(0)
  await expect.poll(() => streams.at(-1)).toBe("watched")

  // Quick Open and Search offer the same instead of searching.
  await page.keyboard.press("ControlOrMeta+p")
  const quickOpen = page.getByRole("dialog").filter({ has: page.getByRole("combobox", { name: "Go to file" }) })
  await expect(quickOpen.getByText(prompt)).toBeVisible()
  await expect(quickOpen.getByText("Loading files…")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.keyboard.press("ControlOrMeta+Shift+f")
  const search = page.getByRole("region", { name: "Search", exact: true })
  await expect(search.getByText(prompt)).toBeVisible()
  await expect(search.getByRole("textbox", { name: "Search" })).toHaveCount(0)
  await page.keyboard.press("ControlOrMeta+Shift+e")

  await files.getByRole("button", { name: "Scan files" }).click()
  await expect(files.getByRole("treeitem", { name: "docs" })).toBeVisible()
  await expect(files.getByText(prompt)).toHaveCount(0)
  await expect(page.locator(".status-file-count")).toBeVisible()
  await expect.poll(() => streams.at(-1)).toBe("open")
  expect(trees.at(-1)).toBe("1")

  // This browser remembers: a reload scans without asking.
  await page.reload()
  await expect(explorer(page).getByRole("treeitem", { name: "docs" })).toBeVisible()
  await expect(explorer(page).getByText(prompt)).toHaveCount(0)
  expect(trees.at(-1)).toBe("1")
  expect(streams.at(-1)).toBe("open")
})
