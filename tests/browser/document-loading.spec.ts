import { expect, test } from "@playwright/test"

test("a file tab opens before its page response arrives", async ({ page }, info) => {
  await page.goto("/view?path=guides%2Fgetting-started.md")
  await expect(page.getByRole("tab", { name: "getting-started.md" })).toHaveAttribute("aria-selected", "true")
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let requested = false
  await page.route((url) => url.pathname === "/api/page" && url.searchParams.get("path") === "guides/code-blocks.md", async (route) => {
    requested = true
    await held
    await route.continue()
  })
  try {
    await page.getByRole("complementary", { name: "Files" }).getByRole("treeitem", { name: "code-blocks.md", exact: true }).click()
    await expect.poll(() => requested).toBe(true)
    await expect(page.getByRole("tab", { name: "code-blocks.md" })).toHaveAttribute("aria-selected", "true")
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "true")
    await expect(page.locator("main")).toContainText("Loading file…")
    await expect(page.locator("main")).not.toContainText("Getting started")
    await page.screenshot({ path: info.outputPath("loading-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole("tab", { name: "code-blocks.md" })).toBeInViewport()
    await page.screenshot({ path: info.outputPath("loading-phone.png") })
  } finally {
    release()
  }
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false")
  await expect(page.locator("main")).not.toContainText("Loading file…")
  await expect(page.getByRole("tab", { name: "code-blocks.md" })).toHaveAttribute("aria-selected", "true")
})

test("a failed file stays in its tab and can retry", async ({ page }) => {
  await page.goto("/view?path=guides%2Fgetting-started.md")
  await expect(page.getByRole("tab", { name: "getting-started.md" })).toHaveAttribute("aria-selected", "true")
  await page.route((url) => url.pathname === "/api/page" && url.searchParams.get("path") === "guides/code-blocks.md", (route) => route.abort(), { times: 1 })
  await page.getByRole("complementary", { name: "Files" }).getByRole("treeitem", { name: "code-blocks.md", exact: true }).click()
  await expect(page.getByRole("tab", { name: "code-blocks.md" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("alert")).toContainText("Could not load files.")
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false")
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "code-blocks.md" })).toHaveAttribute("aria-selected", "true")
})

test("closing a loading file keeps its late response from reopening it", async ({ page }) => {
  await page.goto("/view?path=guides%2Fgetting-started.md")
  await expect(page.getByRole("tab", { name: "getting-started.md" })).toHaveAttribute("aria-selected", "true")
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route((url) => url.pathname === "/api/page" && url.searchParams.get("path") === "guides/code-blocks.md", async (route) => {
    await held
    await route.continue()
  })
  try {
    await page.getByRole("complementary", { name: "Files" }).getByRole("treeitem", { name: "code-blocks.md", exact: true }).click()
    await page.getByRole("button", { name: "Close guides/code-blocks.md", exact: true }).click()
    await expect(page.getByRole("tab", { name: "getting-started.md" })).toHaveAttribute("aria-selected", "true")
  } finally {
    release()
  }
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false")
  await expect(page.getByRole("tab", { name: "code-blocks.md" })).toHaveCount(0)
})
