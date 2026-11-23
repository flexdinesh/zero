import { expect, test, type Page } from "@playwright/test"

import { identitiesDesktop } from "./desktop-fake.ts"
import { endsWith, fixtureRoot, projectParam, rootParam } from "./fixture-root.ts"

const at = (...segments: string[]) => [fixtureRoot, ...segments].join("/")

// The mounted workspace can still be reading projects when URL assertions end.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }) })

// The fixture root has no repositories; present some of its folders as
// discovered projects, so a link without a project has a choice. identities
// gives a folder's repository identity (decision 0188).
async function mockProjects(page: Page, identities: Record<string, string> = {}) {
  await page.route("**/api/projects", async (route) => {
    const response = await route.fetch()
    const json: unknown = await response.json()
    if (typeof json !== "object" || json === null || !("projects" in json) || !Array.isArray(json.projects)) {
      throw new Error("unexpected projects payload")
    }
    const repo = (path: string) => ({
      id: path, name: path.split("/").at(-1), path, kind: "repo", group: "", root: fixtureRoot, branch: "main",
      repository: path.split("/").at(-1), identity: identities[path.split("/").at(-1) ?? ""] ?? "", available: true,
    })
    await route.fulfill({ response, json: { ...json, projects: [json.projects[0], repo(at("guides")), repo(at("reference"))] } })
  })
}

// rememberedProjects lists the last project of each session in workspace
// memory.
function rememberedProjects(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const memory: unknown = JSON.parse(localStorage.getItem("zero-workspaces-v2") ?? "{}")
    if (typeof memory !== "object" || memory === null || !("last" in memory)) return []
    const last = memory.last
    if (typeof last !== "object" || last === null) return []
    return Object.values(last).filter((project): project is string => typeof project === "string")
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
  // The workspace remembers a project once its page loads, after the URL
  // settles; leaving earlier would record nothing.
  await expect.poll(() => rememberedProjects(page)).toContain(at("reference"))

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

// A link that names a repository identity finds its checkout on this server,
// whatever path another computer gave it (decision 0188).
const site = "github.com/me/guides"

test("a repo link opens its one checkout and drops repo from the URL", async ({ page }) => {
  await mockProjects(page, { guides: site })
  await page.goto(`/?repo=${encodeURIComponent(site)}`)
  await expect(page).toHaveURL(endsWith(`/view?project=${projectParam("guides")}&welcome=1`))
})

test("a repo link keeps its target when another computer's path is not served here", async ({ page }) => {
  await mockProjects(page, { guides: site })
  await page.goto(`/view?project=${encodeURIComponent("/home/someone/guides")}&repo=${encodeURIComponent(site)}&path=getting-started.md`)
  await expect(page).toHaveURL(endsWith(`/view?project=${projectParam("guides")}&path=getting-started.md`))
})

test("a repo link with several checkouts asks among them, and the pick keeps the target", async ({ page }) => {
  await mockProjects(page, { guides: site, reference: site })
  await page.goto(`/view?repo=${encodeURIComponent(site)}&path=getting-started.md`)
  await expect(chooser(page).getByRole("heading", { name: "Choose a checkout", level: 1 })).toBeVisible()
  await expect(chooser(page)).toContainText(`2 checkouts of ${site}.`)
  await expect(chooser(page).getByRole("button", { name: /^(markdown|guides|reference)/ })).toHaveText([
    new RegExp(`guides.*${site}`), new RegExp(`reference.*${site}`),
  ])
  await chooser(page).getByRole("button", { name: "Show all projects" }).click()
  await expect(chooser(page).getByRole("heading", { name: "Choose a project", level: 1 })).toBeVisible()
  await expect(chooser(page).getByRole("button", { name: /^(markdown|guides|reference)/ })).toHaveCount(3)
  await chooser(page).getByRole("button", { name: /^guides/ }).click()
  await expect(page).toHaveURL(endsWith(`/view?project=${projectParam("guides")}&path=getting-started.md`))
})

test("a repo link with no checkout here says so and lists every project", async ({ page }) => {
  await mockProjects(page, { guides: site })
  await page.goto(`/?repo=${encodeURIComponent("github.com/none/here")}`)
  await expect(chooser(page).getByRole("heading", { name: "Choose a project", level: 1 })).toBeVisible()
  await expect(chooser(page)).toContainText("No checkout of github.com/none/here on this server. Serving 1 folder.")
  await expect(chooser(page).getByRole("button", { name: /^(markdown|guides|reference)/ })).toHaveCount(3)
})

test("with no checkout here, the desktop app offers other open connections' checkouts", async ({ page }) => {
  await mockProjects(page)
  await identitiesDesktop(page, [{ connection: "r-0123456789ab", label: "devbox", project: "/home/dev/guides" }])
  await page.goto(`/?repo=${encodeURIComponent(site)}`)
  await expect(chooser(page)).toContainText(`No checkout of ${site} on this server.`)
  await chooser(page).getByRole("button", { name: "Open in devbox" }).click()
  await expect.poll(() => page.evaluate(() => window.__identities?.calls)).toEqual([
    ["find", site], ["open", "r-0123456789ab", "/home/dev/guides"],
  ])
})

// Decision 0193: / asks at once, before projects are listed.
test("the choice paints before projects are listed", async ({ page }) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let requested = false
  await page.route("**/api/projects", async (route) => {
    requested = true
    await held
    await route.continue()
  })
  try {
    await page.goto("/")
    await expect(chooser(page).getByRole("heading", { name: "Choose a project", level: 1 })).toBeVisible()
    await expect.poll(() => requested).toBe(true)
    await expect(page.locator(".workspace-skeleton")).toHaveCount(0)
    await expect(chooser(page).getByRole("button", { name: /^markdown/ })).toHaveCount(0)
  } finally {
    release()
  }
  await expect(chooser(page).getByRole("button", { name: /^markdown/ })).toBeVisible()
  await expect(chooser(page)).toContainText("Serving 1 folder.")
})

// Serving no folder, the choice says so and offers to open one where the
// server can (decision 0193).
test("serving no folder, the choice says so", async ({ page }) => {
  for (const manageRoots of [true, false]) {
    await page.unrouteAll({ behavior: "wait" })
    await page.route("**/api/projects", async (route) => {
      const response = await route.fetch()
      const json: unknown = await response.json()
      if (typeof json !== "object" || json === null) throw new Error("unexpected projects payload")
      await route.fulfill({ response, json: { ...json, roots: [], projects: [], manageRoots } })
    })
    await page.goto("/")
    await expect(chooser(page).getByText("No folder is open.")).toBeVisible()
    await expect(chooser(page).getByRole("textbox", { name: "Filter projects" })).toHaveCount(0)
    await expect(chooser(page).getByRole("button", { name: "Open folder…" })).toHaveCount(manageRoots ? 1 : 0)
  }
})
