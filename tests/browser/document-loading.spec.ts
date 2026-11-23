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

// Decision 0192: the shell paints the workspace before any page or tree.
test("a deep link shows the workspace before its page arrives", async ({ page }, info) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let requested = false
  await page.route((url) => url.pathname === "/api/page" && url.searchParams.get("path") === "guides/code-blocks.md", async (route) => {
    requested = true
    await held
    await route.continue()
  })
  try {
    await page.goto("/view?path=guides%2Fcode-blocks.md", { waitUntil: "commit" })
    // The development server's first module load can take seconds.
    await expect.poll(() => requested, { timeout: 15_000 }).toBe(true)
    await expect(page.getByRole("complementary", { name: "Files" })).toBeVisible()
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "true")
    await expect(page.locator(".workspace-skeleton")).toHaveCSS("opacity", "1")
    await page.screenshot({ path: info.outputPath("first-load-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: info.outputPath("first-load-phone.png") })
  } finally {
    release()
  }
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false")
  await expect(page.getByRole("tab", { name: "code-blocks.md" })).toHaveAttribute("aria-selected", "true")
})

test("the file tree loads apart from the document", async ({ page }, info) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route((url) => url.pathname === "/api/tree", async (route) => {
    await held
    await route.continue()
  })
  const files = page.getByRole("complementary", { name: "Files" })
  try {
    await page.goto("/view?path=guides%2Fgetting-started.md")
    await expect(page.getByRole("tab", { name: "getting-started.md" })).toHaveAttribute("aria-selected", "true")
    await expect(page.locator("main")).toContainText("Getting started")
    await expect(files.getByRole("status")).toHaveAttribute("aria-busy", "true")
    await expect(files.getByRole("treeitem")).toHaveCount(0)
    await page.screenshot({ path: info.outputPath("tree-loading.png") })
  } finally {
    release()
  }
  await expect(files.getByRole("treeitem", { name: "getting-started.md", exact: true })).toBeVisible()
  await expect(files.getByRole("status")).toHaveCount(0)
})

// Decision 0193: the route reads the tree beside the page, and a quick tree
// mounts with the workspace, so a small project never shows its skeleton.
test("the tree starts with the page and a small project shows no skeleton", async ({ page }) => {
  await page.addInitScript(() => {
    const seen = () => {
      if (document.querySelector(".file-explorer .ui-skeleton-rows")) document.documentElement.dataset.explorerSkeleton = "shown"
    }
    new MutationObserver(seen).observe(document, { childList: true, subtree: true })
  })
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let treeRequested = false
  let pageRequested = false
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/tree") treeRequested = true
  })
  await page.route((url) => url.pathname === "/api/page" && url.searchParams.get("path") === "guides/getting-started.md", async (route) => {
    pageRequested = true
    await held
    await route.continue()
  })
  const files = page.getByRole("complementary", { name: "Files" })
  try {
    await page.goto("/view?path=guides%2Fgetting-started.md", { waitUntil: "commit" })
    // The development server's first module load can take seconds.
    await expect.poll(() => pageRequested, { timeout: 15_000 }).toBe(true)
    await expect.poll(() => treeRequested).toBe(true)
    // The page is held, so the workspace has not mounted.
    await expect(page.locator(".file-explorer")).toHaveCount(0)
  } finally {
    release()
  }
  await expect(files.getByRole("treeitem", { name: "getting-started.md", exact: true })).toBeVisible()
  await expect(page.getByRole("tab", { name: "getting-started.md" })).toHaveAttribute("aria-selected", "true")
  expect(await page.evaluate(() => document.documentElement.dataset.explorerSkeleton ?? "")).toBe("")
})
