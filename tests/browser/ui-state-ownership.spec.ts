import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect } from "@playwright/test"
import { isProjectsResponse } from "../../packages/contracts/src/index.ts"

import { fixtureRoot, projectParam, rootParam } from "./fixture-root.ts"
import { featureSubject, gitFixtureRoot } from "./git-fixture.ts"
import { test } from "./live-test.ts"
import { apiOrigin, gitApiOrigin } from "./ports.ts"

test("search retains its active match and focus behavior through navigation and sidebar hiding", async ({ page, live }) => {
  writeFileSync(path.join(live.root, "a.md"), "# First\n\nownership-marker first\n\nownership-marker second\n")
  writeFileSync(path.join(live.root, "z.md"), "# Last\n\nownership-marker last\n")
  await page.goto(`${live.origin}/?project=${encodeURIComponent(live.root)}`)
  await page.keyboard.press("ControlOrMeta+Shift+f")
  const input = page.getByRole("textbox", { name: "Search", exact: true })
  const results = page.getByRole("tree", { name: "Search results" })
  const first = results.getByRole("treeitem").filter({ hasText: "ownership-marker first" })
  const second = results.getByRole("treeitem").filter({ hasText: "ownership-marker second" })
  const last = results.getByRole("treeitem").filter({ hasText: "ownership-marker last" })
  await expect(input).toBeFocused()
  await input.fill("ownership-marker")
  await first.dblclick()
  await expect(page).toHaveURL(/path=a\.md#L3$/)
  await expect(page.getByRole("main")).toBeFocused()
  await page.keyboard.press("F4")
  await expect(page).toHaveURL(/path=a\.md#L5$/)
  await expect(second).toHaveAttribute("aria-selected", "true")

  await page.keyboard.press("ControlOrMeta+b")
  await expect(input).toBeHidden()
  await page.keyboard.press("F4")
  await expect(page).toHaveURL(/path=z\.md#L3$/)
  await page.keyboard.press("ControlOrMeta+Shift+f")
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("ownership-marker")
  await expect(last).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Shift+F4")
  await expect(page).toHaveURL(/path=a\.md#L5$/)

  await page.keyboard.press("ControlOrMeta+Shift+e")
  await page.getByRole("treeitem", { name: "long.md", exact: true }).click()
  await expect(page).toHaveURL(/path=long\.md$/)
  await page.keyboard.press("ControlOrMeta+Shift+f")
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("ownership-marker")
  await expect(second).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("F4")
  await expect(page).toHaveURL(/path=z\.md#L3$/)
})

test("revealing Search from the activity bar refreshes edits made while it was hidden", async ({ page, live }) => {
  const file = path.join(live.root, "search-refresh.md")
  writeFileSync(file, "# Search fixture\n\nsidebar-refresh before\n")
  await page.goto(`${live.origin}/?project=${encodeURIComponent(live.root)}`)
  await page.keyboard.press("ControlOrMeta+Shift+f")
  const input = page.getByRole("textbox", { name: "Search", exact: true })
  await input.fill("sidebar-refresh")
  const results = page.getByRole("tree", { name: "Search results" })
  await expect(results.getByRole("treeitem", { name: "Line 3: sidebar-refresh before", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Explorer", exact: true }).click()
  await expect(input).toBeHidden()

  const changed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/changes" && response.ok())
  writeFileSync(file, "# Search fixture\n\nsidebar-refresh after\n")
  await changed
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Search", exact: true }).click()
  await expect(input).toHaveValue("sidebar-refresh")
  await expect(results.getByRole("treeitem", { name: "Line 3: sidebar-refresh after", exact: true })).toBeVisible()
})

test("switching projects clears transient search and ignores a late previous-project response", async ({ page }) => {
  const guides = path.join(fixtureRoot, "guides")
  await page.route("**/api/projects", async (route) => {
    const response = await route.fetch()
    const payload: unknown = await response.json()
    if (!isProjectsResponse(payload)) throw new Error("unexpected projects response")
    await route.fulfill({ response, json: { ...payload, projects: [...payload.projects, {
      id: guides, name: "guides", path: guides, kind: "folder", group: "", root: fixtureRoot,
      branch: "", repository: "", available: true,
    }] } })
  })
  let hold = false
  let held = false
  let release = () => {}
  let completed = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  const released = new Promise<void>((resolve) => { completed = resolve })
  await page.route("**/api/search-documents?*", async (route) => {
    if (!hold || new URL(route.request().url()).searchParams.get("project") !== fixtureRoot) return route.continue()
    const response = await route.fetch()
    held = true
    await pending
    try {
      await route.fulfill({ response })
    } finally {
      completed()
    }
  })
  try {
    await page.goto(`${apiOrigin}/?project=${rootParam}`)
    await page.keyboard.press("ControlOrMeta+Shift+f")
    const input = page.getByRole("textbox", { name: "Search", exact: true })
    const results = page.getByRole("tree", { name: "Search results" })
    await input.fill("luminous-orchid")
    await expect(results.getByRole("treeitem").filter({ hasText: "phrase **luminous-orchid**" })).toBeVisible()
    hold = true
    await page.getByRole("region", { name: "Search", exact: true }).getByRole("button", { name: "Refresh", exact: true }).click()
    await expect.poll(() => held).toBe(true)

    await page.keyboard.press("ControlOrMeta+o")
    const picker = page.getByRole("dialog", { name: /Switch project|Open folder/ })
    await picker.getByRole("combobox").fill("guides")
    await picker.getByRole("option", { name: /^guides/ }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe(guides)
    await page.keyboard.press("ControlOrMeta+Shift+f")
    await expect(input).toBeFocused()
    await expect(input).toHaveValue("")
    await expect(results).toHaveCount(0)
    await input.fill("exercise GitHub")
    const match = results.getByRole("treeitem").filter({ hasText: "exercise GitHub" })
    await expect(match).toBeVisible()
    release()
    await released
    await expect(input).toHaveValue("exercise GitHub")
    await expect(match).toBeVisible()
    await expect(results.getByRole("treeitem").filter({ hasText: "search.md" })).toHaveCount(0)
    await page.keyboard.press("F4")
    await expect(page).toHaveURL(new RegExp(`project=${projectParam("guides")}&path=getting-started\\.md#L3$`))
  } finally {
    release()
  }
})

test("an empty workspace follows the current search summary after view changes", async ({ page }) => {
  await page.goto(`${apiOrigin}/?project=${rootParam}`)
  await page.getByRole("button", { name: "Close Welcome" }).click()
  await page.keyboard.press("ControlOrMeta+Shift+f")
  const main = page.getByRole("main")
  const input = page.getByRole("textbox", { name: "Search", exact: true })
  await expect(main.getByRole("heading", { name: "Search file contents", exact: true })).toBeVisible()
  await input.fill("luminous-orchid")
  await expect(main.getByRole("heading", { name: "Open a match", exact: true })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Shift+e")
  await expect(main.getByRole("heading", { name: "Choose a file", exact: true })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Shift+f")
  await expect(main.getByRole("heading", { name: "Open a match", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear Search Results" }).click()
  await expect(input).toHaveValue("")
  await expect(main.getByRole("heading", { name: "Search file contents", exact: true })).toBeVisible()
})

test("file-history command focus and filter draft survive view changes while layout persists", async ({ page }) => {
  test.skip(!existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
  await page.goto(`${gitApiOrigin}/view?project=${encodeURIComponent(gitFixtureRoot)}&path=clean.md`)
  await page.keyboard.press("ControlOrMeta+Shift+g")
  const scm = page.getByRole("region", { name: "Source Control", exact: true })
  const commits = scm.getByRole("region", { name: "Commits", exact: true })
  const branches = scm.getByRole("region", { name: "Branches", exact: true })
  const query = commits.getByRole("textbox", { name: "Filter commits by message, author, or hash" })
  const pathFilter = commits.getByRole("button", { name: "Remove path filter clean.md" })
  const row = commits.getByRole("option", { name: new RegExp(`^${featureSubject}, zero, `) })
  await expect(row).toBeVisible()
  await commits.getByRole("heading", { level: 3 }).getByRole("button").click()
  await page.keyboard.press("ControlOrMeta+Shift+e")
  await page.keyboard.press("F1")
  await page.keyboard.type("show file history")
  await page.keyboard.press("Enter")
  await expect(scm).toBeVisible()
  await expect(query).toBeFocused()
  await expect(pathFilter).toBeVisible()
  await query.fill("history notes")
  // Leave before the filter debounce applies, then check both draft and results.
  await page.keyboard.press("ControlOrMeta+Shift+e")
  await page.keyboard.press("ControlOrMeta+Shift+g")
  await expect(query).toHaveValue("history notes")
  await expect(pathFilter).toBeVisible()
  await expect(row).toBeVisible()
  await expect(commits.getByRole("listbox", { name: "Commits", exact: true }).getByRole("option")).toHaveCount(1)

  await commits.getByRole("button", { name: "All", exact: true }).click()
  await scm.getByRole("button", { name: "View as Tree" }).click()
  const branchesToggle = branches.getByRole("heading", { level: 3 }).getByRole("button")
  await branchesToggle.click()
  await row.click()
  await expect(page).toHaveURL(/[?&]commit=[0-9a-f]{40}#f=clean\.md$/)
  await expect(page.getByRole("main").getByRole("region", { name: "clean.md", exact: true })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+b")
  await expect(scm).toBeHidden()
  await page.keyboard.press("ControlOrMeta+Shift+g")
  await expect(query).toHaveValue("history notes")
  await expect(pathFilter).toBeVisible()
  await expect(commits.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(scm.getByRole("button", { name: "View as List" })).toBeVisible()
  await expect(branchesToggle).toHaveAttribute("aria-expanded", "false")

  await page.reload()
  await expect(query).toHaveValue("")
  await expect(pathFilter).toHaveCount(0)
  await expect(commits.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(scm.getByRole("button", { name: "View as List" })).toBeVisible()
  await expect(branchesToggle).toHaveAttribute("aria-expanded", "false")
  await expect(page).toHaveURL(/[?&]commit=[0-9a-f]{40}#f=clean\.md$/)
})
