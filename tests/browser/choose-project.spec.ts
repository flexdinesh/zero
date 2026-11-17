import { expect, test, type Page } from "@playwright/test"

import { endsWith, fixtureRoot, projectParam, rootParam } from "./fixture-root.ts"

const at = (...segments: string[]) => [fixtureRoot, ...segments].join("/")

// The mounted workspace can still be reading projects when URL assertions end.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }) })

// The fixture root has no repositories; present some of its folders as
// discovered projects, so a link without a project has a choice.
async function mockProjects(page: Page) {
  await page.route("**/api/projects", async (route) => {
    const response = await route.fetch()
    const json: unknown = await response.json()
    if (typeof json !== "object" || json === null || !("projects" in json) || !Array.isArray(json.projects)) {
      throw new Error("unexpected projects payload")
    }
    const repo = (path: string) => ({
      id: path, name: path.split("/").at(-1), path, kind: "repo", group: "", root: fixtureRoot, branch: "main",
      repository: path.split("/").at(-1), available: true,
    })
    await route.fulfill({ response, json: { ...json, projects: [json.projects[0], repo(at("guides")), repo(at("reference"))] } })
  })
}

const chooser = (page: Page) => page.getByRole("main")
const filter = (page: Page) => chooser(page).getByRole("textbox", { name: "Filter projects" })

// A link that names no project asks which to open while there is a choice,
// and loads none until one is picked (decision 0153).
test("a link without a project asks which to open", async ({ page }) => {
  await mockProjects(page)
  await page.goto("/")
  await expect(chooser(page).getByRole("heading", { name: "Choose a project", level: 1 })).toBeVisible()
  await expect(page).toHaveTitle("Choose a project · Zero")
  await expect(page).not.toHaveURL(/project=/)
  await expect(chooser(page)).toContainText("Serving 1 folder.")
  await expect(page.getByRole("tablist", { name: "Open documents" })).toHaveCount(0)
  await expect(chooser(page).getByRole("button", { name: /^(markdown|guides|reference)/ })).toHaveText([
    /markdown.*served folder/, /guides.*main/, /reference.*main/,
  ])
  await expect(chooser(page).getByText("Last opened")).toHaveCount(0)
  await expect(filter(page)).toBeFocused()

  // The filter narrows; with nothing to match it says so.
  await filter(page).fill("zzz")
  await expect(chooser(page).getByRole("status")).toHaveText("No projects match “zzz”.")

  // Picking a project opens it.
  await filter(page).fill("")
  await chooser(page).getByRole("button", { name: /^guides/ }).click()
  await expect(page).toHaveURL(endsWith(`/view?project=${projectParam("guides")}&welcome=1`))
})

test("the last opened project is marked, and Enter opens it", async ({ page }) => {
  await mockProjects(page)
  await page.goto(`/?project=${projectParam("reference")}`)
  await expect(page).toHaveURL(endsWith(`/view?project=${projectParam("reference")}&welcome=1`))

  await page.goto("/")
  await expect(chooser(page).getByRole("heading", { name: "Choose a project" })).toBeVisible()
  // The mark stays in place: the list keeps the server's order.
  await expect(chooser(page).getByRole("button", { name: /^(markdown|guides|reference)/ })).toHaveText([
    /markdown/, /guides/, /reference.*Last opened/,
  ])
  await filter(page).press("Enter")
  await expect(page).toHaveURL(endsWith(`/view?project=${projectParam("reference")}&welcome=1`))

  // With a filter, Enter opens the first match instead.
  await page.goto("/")
  await filter(page).fill("gui")
  await filter(page).press("Enter")
  await expect(page).toHaveURL(endsWith(`/view?project=${projectParam("guides")}&welcome=1`))
})

test("a link that names its project skips the choice", async ({ page }) => {
  await mockProjects(page)
  await page.goto(`/?project=${rootParam}`)
  await expect(page).toHaveURL(endsWith(`/view?project=${rootParam}&welcome=1`))
  await expect(page.getByRole("heading", { name: "Choose a project" })).toHaveCount(0)
})
