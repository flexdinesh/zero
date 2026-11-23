import { expect, test } from "@playwright/test"
import { endsWith, projectParam, rootParam } from "./fixture-root.ts"

test("projects remember their tabs; a link without a project asks, even with only one", async ({ page }) => {
  const tree = page.getByRole("complementary", { name: "Files" })
  const tabs = page.getByRole("tablist", { name: "Open documents" })
  await page.goto(`/view?project=${rootParam}&path=guides%2Fgetting-started.md`)
  await tree.getByRole("treeitem", { name: "README.md" }).click()
  await expect(tabs.getByRole("tab")).toHaveCount(2)

  await page.goto(`/?project=${projectParam("guides")}`)
  await expect(tabs.getByRole("tab")).toHaveText(["Welcome"])
  await tree.getByRole("treeitem", { name: "diagrams.md" }).click()
  await expect(tabs.getByRole("tab", { name: "diagrams.md" })).toHaveAttribute("aria-selected", "true")

  await page.goto(`/?project=${projectParam("guides")}`)
  await expect(page).toHaveURL(endsWith(`/view?project=${projectParam("guides")}&path=diagrams.md`))
  await expect(tabs.getByRole("tab")).toHaveText(["Welcome", "diagrams.md"])

  // A link without a project opens nothing implicitly, not even the one
  // served root (decision 0191): it asks, and the chosen project restores.
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Choose a project", level: 1 })).toBeVisible()
  await expect(page).not.toHaveURL(/project=/)
  await page.goto(`/?project=${rootParam}`)
  await expect(page).toHaveURL(endsWith(`/view?project=${rootParam}&path=README.md`))
  await expect(tabs.getByRole("tab", { name: "getting-started.md" })).toBeVisible()
  await expect(tabs.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true")
})
