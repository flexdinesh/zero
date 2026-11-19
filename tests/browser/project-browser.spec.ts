import { existsSync } from "node:fs"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { gitFixtureRoot } from "./git-fixture.ts"
import { gitApiOrigin } from "./ports.ts"

// The desktop app's local window steers each project's guest window from
// its Browser tab (decision 0181). Here a stand-in bridge plays the app: it
// records what the tab asks and answers the state a test sets.

test.skip(() => !existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")

const project = encodeURIComponent(gitFixtureRoot)

interface FakeState {
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  failure: { kind: string; url: string; description: string } | null
}

declare global {
  interface Window {
    __browserCalls?: unknown[][]
    __browserState?: FakeState | null
    zeroDesktop?: unknown
  }
}

async function fakeDesktop(page: Page) {
  await page.addInitScript(() => {
    window.__browserCalls = []
    window.__browserState = null
    window.zeroDesktop = {
      version: 2,
      openReview(...args: unknown[]) { window.__browserCalls?.push(["open", ...args]); return Promise.resolve() },
      browserState() { return Promise.resolve(window.__browserState ?? null) },
      browserAction(...args: unknown[]) { window.__browserCalls?.push(["action", ...args]); return Promise.resolve() },
    }
  })
}

// setState sets the guest window's state and announces it, as the app does.
async function setState(page: Page, state: FakeState | null) {
  await page.evaluate(({ state, project }) => {
    window.__browserState = state
    window.dispatchEvent(new CustomEvent("zero:browser", { detail: project }))
  }, { state, project: gitFixtureRoot })
}

async function calls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => window.__browserCalls ?? [])
}

const tabs = (page: Page) => page.getByRole("tablist", { name: "Open documents" })
const address = (page: Page) => page.getByRole("combobox", { name: "Page address" })
const shown: FakeState = { url: "http://localhost:5173/settings", loading: false, canGoBack: true, canGoForward: false, failure: null }

async function openBrowserFromPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+P")
  const palette = page.getByRole("dialog", { name: "Command palette" })
  await palette.getByRole("combobox", { name: "Command" }).fill("Review URL")
  await expect(palette.getByRole("option", { name: /^Review: Review URL…/ })).toBeVisible()
  await page.keyboard.press("Enter")
}

test("the Browser tab opens a page, names it, steers it, and says where comments go", async ({ page }) => {
  await fakeDesktop(page)
  await page.goto(`${gitApiOrigin}/?project=${project}`)
  await openBrowserFromPalette(page)

  await expect(page).toHaveURL(/browser=1/)
  await expect(tabs(page).getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true")
  await expect(address(page)).toBeFocused()
  const main = page.getByRole("main")
  await expect(main.getByText("Comments go to")).toBeVisible()
  await expect(main.locator(".project-browser-target")).toContainText(path.basename(gitFixtureRoot))
  await expect(main.locator(".project-browser-target")).toContainText("feature")
  await expect(main.getByRole("button", { name: "Back" })).toHaveAttribute("aria-disabled", "true")

  await address(page).fill("localhost:5173/settings")
  await expect(main.getByRole("option", { name: "Open http://localhost:5173/settings" })).toBeVisible()
  await page.keyboard.press("Enter")
  await expect.poll(() => calls(page)).toEqual([["open", gitFixtureRoot, "http://localhost:5173/settings"]])

  await setState(page, { ...shown, loading: true })
  await expect(main.getByRole("button", { name: "Stop loading" })).toBeVisible()
  await expect(main.getByText("Loading localhost:5173/settings…")).toBeVisible()

  await setState(page, shown)
  await expect(tabs(page).getByRole("tab", { name: "localhost:5173" })).toBeVisible()
  await expect(address(page)).toHaveValue("http://localhost:5173/settings")
  await expect(main.getByText("Showing localhost:5173/settings in its page window.")).toBeVisible()
  await main.getByRole("button", { name: "Back" }).click()
  await main.getByRole("button", { name: "Show Page" }).click()
  await main.getByRole("button", { name: /Comment on Screen/ }).click()
  await expect.poll(async () => (await calls(page)).slice(1)).toEqual([
    ["action", gitFixtureRoot, "back"], ["action", gitFixtureRoot, "show"], ["action", gitFixtureRoot, "comment"],
  ])
  // The page is remembered for the project.
  await expect(main.getByRole("listbox", { name: "Pages" }).getByRole("option")).toHaveCount(1)
})

test("switching to a diff and back keeps the page and its state", async ({ page }) => {
  await fakeDesktop(page)
  await page.goto(`${gitApiOrigin}/?project=${project}`)
  await openBrowserFromPalette(page)
  await address(page).fill("https://example.com/")
  await page.keyboard.press("Enter")
  await setState(page, { ...shown, url: "https://example.com/" })
  await expect(tabs(page).getByRole("tab", { name: "example.com" })).toBeVisible()

  await page.keyboard.press("ControlOrMeta+Shift+g")
  const changes = page.getByRole("region", { name: "Source Control" }).getByRole("listbox", { name: "Uncommitted changes" })
  await changes.getByRole("option", { name: /^README\.md, / }).click()
  await expect(page).toHaveURL(/review=working/)
  await expect(page.getByRole("main").locator(".project-browser")).toHaveCount(0)

  await tabs(page).getByRole("tab", { name: "example.com" }).click()
  await expect(page).toHaveURL(/browser=1/)
  await expect(address(page)).toHaveValue("https://example.com/")
  await expect(page.getByRole("main").getByText("Showing example.com/ in its page window.")).toBeVisible()
  // Moving between tabs leaves the page window alone.
  expect(await calls(page)).toEqual([["open", gitFixtureRoot, "https://example.com/"]])
})

test("failures say what to try, a closed window reopens, and closing the tab closes the window", async ({ page }) => {
  await fakeDesktop(page)
  await page.goto(`${gitApiOrigin}/?project=${project}`)
  await openBrowserFromPalette(page)
  await address(page).fill("localhost:5173")
  await page.keyboard.press("Enter")
  const main = page.getByRole("main")

  await setState(page, { ...shown, url: "http://localhost:5173/", failure: { kind: "load", url: "http://localhost:5173/", description: "Could not connect: Connection refused" } })
  const alert = main.getByRole("alert")
  await expect(alert).toContainText("Could not load localhost:5173/")
  await expect(alert).toContainText("Is its dev server running?")
  await alert.getByRole("button", { name: "Try again" }).click()
  await expect.poll(async () => (await calls(page)).at(-1)).toEqual(["open", gitFixtureRoot, "http://localhost:5173/"])

  await setState(page, { ...shown, failure: { kind: "certificate", url: "https://localhost:8443/", description: "Unacceptable TLS certificate" } })
  await expect(alert).toContainText("localhost:8443 has a certificate Zero does not trust")

  await setState(page, null)
  await expect(main.getByText("The page window is closed.")).toBeVisible()
  await main.getByRole("button", { name: "Reopen localhost:5173/" }).click()
  await expect.poll(async () => (await calls(page)).at(-1)).toEqual(["open", gitFixtureRoot, "http://localhost:5173/"])

  // Escape puts back what the field showed; an address that is not one says so.
  await address(page).fill("not a page")
  await expect(main.getByText("Enter an http or https address, like localhost:5173.")).toBeVisible()
  await address(page).press("Escape")
  await expect(address(page)).toHaveValue("http://localhost:5173/")

  await tabs(page).getByRole("button", { name: "Close Browser: localhost:5173/" }).click()
  await expect.poll(async () => (await calls(page)).at(-1)).toEqual(["action", gitFixtureRoot, "close"])
})

test("narrow windows keep the address usable", async ({ page }) => {
  await fakeDesktop(page)
  await page.setViewportSize({ width: 560, height: 700 })
  await page.goto(`${gitApiOrigin}/view?project=${project}&browser=1`)
  await setState(page, shown)
  const field = await address(page).boundingBox()
  expect(field?.width ?? 0).toBeGreaterThan(160)
  const overflow = await page.getByRole("main").evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test("without the desktop app the browser offers nothing to open", async ({ page }) => {
  await page.goto(`${gitApiOrigin}/view?project=${project}&browser=1`)
  await expect(page.getByRole("main").getByText(/opens pages of your app in Zero's desktop app/)).toBeVisible()
  await expect(address(page)).toHaveCount(0)
})
