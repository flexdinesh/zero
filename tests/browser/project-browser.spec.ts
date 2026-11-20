import { existsSync } from "node:fs"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { browserDesktop, type FakeBrowserState } from "./desktop-fake.ts"
import { gitFixtureRoot } from "./git-fixture.ts"
import { gitApiOrigin } from "./ports.ts"

// The Browser (decision 0184): the desktop app draws a project's page, the
// guest, over the rectangle the Browser tab's stage reports. Here a stand-in
// bridge plays the app: it records what the tab asks and answers the state
// a test sets.

test.skip(() => !existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")

const project = encodeURIComponent(gitFixtureRoot)

interface Frame {
  x: number
  y: number
  width: number
  height: number
}

// setState sets the guest's state and announces it, as the app does.
async function setState(page: Page, state: FakeBrowserState | null) {
  await page.evaluate(({ state, project }) => {
    if (window.__browser) window.__browser.state = state
    window.dispatchEvent(new CustomEvent("zero:browser", { detail: project }))
  }, { state, project: gitFixtureRoot })
}

async function calls(page: Page, kind?: string): Promise<unknown[][]> {
  const all = await page.evaluate(() => window.__browser?.calls ?? [])
  return kind ? all.filter((call) => call[0] === kind) : all
}

// lastFrame is where the page last told the app to show the guest: a
// frame, null for hidden, or "none" before it said anything.
async function lastFrame(page: Page): Promise<unknown> {
  const last = (await calls(page, "frame")).at(-1)
  return last ? last[2] : "none"
}

// stageFrame is the stage's box as whole CSS pixels of the viewport.
async function stageFrame(page: Page): Promise<Frame> {
  const box = await page.locator(".browser-stage").boundingBox()
  if (!box) throw new Error("the stage has no box")
  const x = Math.round(box.x)
  const y = Math.round(box.y)
  return { x, y, width: Math.round(box.x + box.width) - x, height: Math.round(box.y + box.height) - y }
}

async function expectGuestOnStage(page: Page) {
  await expect.poll(async () => [await lastFrame(page)]).toEqual([await stageFrame(page)])
}

const views = (page: Page) => page.getByRole("navigation", { name: "Views" })
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open documents" })
const address = (page: Page) => page.getByRole("combobox", { name: "Page address" })
const stage = (page: Page) => page.locator(".browser-stage")
const shown: FakeBrowserState = {
  url: "http://localhost:5173/settings", title: "Settings", loading: false, canGoBack: true, canGoForward: false, failure: null,
}

// openPage opens the Browser tab on a page the guest shows.
async function openPage(page: Page, state: FakeBrowserState = shown) {
  await browserDesktop(page)
  await page.goto(`${gitApiOrigin}/view?project=${project}&browser=1`)
  await expect(address(page)).toBeVisible()
  await setState(page, state)
  await expect(stage(page)).toHaveAttribute("data-view", "page")
  await expectGuestOnStage(page)
}

test("the Browser shows only in the desktop app with experimental features on", async ({ page }) => {
  // A browser: no activity, and a Browser link opens no tab.
  await page.goto(`${gitApiOrigin}/view?project=${project}&browser=1`)
  await expect(views(page).getByRole("button", { name: /^Explorer/ })).toBeVisible()
  await expect(views(page).getByRole("button", { name: /^Browser/ })).toHaveCount(0)
  await expect(address(page)).toHaveCount(0)
  await expect(tabs(page).getByRole("tab", { name: "Browser" })).toHaveCount(0)

  // The desktop app with experimental features off: the same.
  const off = await page.context().newPage()
  await browserDesktop(off, false)
  await off.goto(`${gitApiOrigin}/view?project=${project}&browser=1`)
  await expect(views(off).getByRole("button", { name: /^Explorer/ })).toBeVisible()
  await expect(views(off).getByRole("button", { name: /^Browser/ })).toHaveCount(0)
  await expect(address(off)).toHaveCount(0)
  expect(await calls(off)).toEqual([])
})

test("the Browser activity opens the tab, an address opens a page, and the stage says where it shows", async ({ page }) => {
  await browserDesktop(page)
  await page.goto(`${gitApiOrigin}/?project=${project}`)
  await views(page).getByRole("button", { name: /^Browser/ }).click()

  await expect(page).toHaveURL(/browser=1/)
  await expect(tabs(page).getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true")
  const pane = page.locator(".browser-view")
  await expect(pane.getByRole("heading", { name: "Pages" })).toBeVisible()
  await expect(pane.getByText("Pages of your app that you open show here.")).toBeVisible()
  const main = page.getByRole("main")
  await expect(main.getByRole("heading", { name: "Open a page of your app" })).toBeVisible()
  await expect(main.getByRole("button", { name: "Back" })).toHaveAttribute("aria-disabled", "true")
  // Without a page the guest shows nowhere.
  await expect.poll(() => lastFrame(page)).toBeNull()

  await address(page).fill("localhost:5173/settings")
  await expect(main.getByRole("option", { name: "Open http://localhost:5173/settings" })).toBeVisible()
  await page.keyboard.press("Enter")
  await expect.poll(() => calls(page, "open")).toEqual([["open", gitFixtureRoot, "http://localhost:5173/settings"]])

  await setState(page, { ...shown, title: "", loading: true })
  await expect(main.getByRole("button", { name: "Stop loading" })).toBeVisible()
  await setState(page, shown)
  await expect(main.getByRole("button", { name: "Reload" })).toBeVisible()
  const tab = tabs(page).getByRole("tab", { name: "localhost:5173" })
  await expect(tab).toHaveAttribute("aria-selected", "true")
  await expect(tab).toHaveAttribute("title", /Settings · localhost:5173\/settings/)
  await expect(address(page)).toHaveValue("http://localhost:5173/settings")
  await expect(stage(page)).toHaveAttribute("data-view", "page")
  await expect(stage(page).locator("*")).toHaveCount(0)

  // A click on the address selects all of it, so typing replaces it.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await address(page).click()
  await page.keyboard.type("localhost:3000")
  await expect(address(page)).toHaveValue("localhost:3000")
  await address(page).press("Escape")
  await expect(address(page)).toHaveValue("http://localhost:5173/settings")

  // The guest shows over the stage, and follows it when the window resizes.
  await expectGuestOnStage(page)
  const before = await stageFrame(page)
  await page.setViewportSize({ width: 1000, height: 620 })
  await expect.poll(() => stageFrame(page)).not.toEqual(before)
  await expectGuestOnStage(page)

  // The activity lists the page, marked as the one showing; choosing it
  // opens it again.
  const pages = pane.getByRole("listbox", { name: "Pages" }).getByRole("option")
  await expect(pages).toHaveCount(1)
  await expect(pages.first()).toHaveAttribute("aria-selected", "true")
  await expect(pages.first()).toHaveAttribute("title", "http://localhost:5173/settings")
  await pages.first().click()
  await expect.poll(async () => (await calls(page, "open")).length).toBe(2)
})

test("another tab hides the guest, and coming back shows it where the stage is", async ({ page }) => {
  await openPage(page)

  await page.keyboard.press("ControlOrMeta+Shift+g")
  const changes = page.getByRole("region", { name: "Source Control" }).getByRole("listbox", { name: "Uncommitted changes" })
  await changes.getByRole("option", { name: /^README\.md, / }).click()
  await expect(page).toHaveURL(/review=working/)
  await expect(stage(page)).toHaveCount(0)
  await expect.poll(() => lastFrame(page)).toBeNull()

  await tabs(page).getByRole("tab", { name: "localhost:5173" }).click()
  await expect(page).toHaveURL(/browser=1/)
  await expect(address(page)).toHaveValue("http://localhost:5173/settings")
  await expectGuestOnStage(page)
  // Moving between tabs neither reloads nor closes the page.
  expect(await calls(page, "open")).toEqual([])
  expect(await calls(page, "action")).toEqual([])
})

test("an overlay swaps the guest for its snapshot, and closing it shows the guest again", async ({ page }) => {
  await openPage(page)
  expect(await calls(page, "snapshot")).toEqual([])

  // The command palette: the snapshot is asked for before the guest hides.
  await page.keyboard.press("ControlOrMeta+Shift+P")
  const palette = page.getByRole("dialog", { name: "Command palette" })
  await expect(palette).toBeVisible()
  await expect.poll(() => lastFrame(page)).toBeNull()
  const cover = stage(page).locator("img.browser-stage-cover")
  await expect(cover).toHaveAttribute("src", /^data:image\/png;base64,/)
  await expect(cover).toHaveAttribute("alt", "")
  const kinds = (await calls(page)).map((call) => call[0]).filter((kind) => kind !== "open" && kind !== "action")
  expect(kinds.slice(-2)).toEqual(["snapshot", "frame"])

  await page.keyboard.press("Escape")
  await expect(palette).toBeHidden()
  await expectGuestOnStage(page)
  await expect(cover).toHaveCount(0)

  // The address field's list drops over the stage too.
  await address(page).fill("localhost:5173/")
  await expect(page.getByRole("main").getByRole("listbox", { name: "Pages" })).toBeVisible()
  await expect.poll(() => lastFrame(page)).toBeNull()
  await expect(cover).toBeVisible()
  await address(page).press("Escape")
  await expect(address(page)).toHaveValue("http://localhost:5173/settings")
  await expectGuestOnStage(page)
  await expect(cover).toHaveCount(0)

  // An app with no frame to give still hides the guest under the overlay.
  await page.evaluate(() => { if (window.__browser) window.__browser.snapshot = null })
  await page.keyboard.press("ControlOrMeta+p")
  await expect(page.getByRole("dialog").first()).toBeVisible()
  await expect.poll(() => lastFrame(page)).toBeNull()
  await expect(cover).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expectGuestOnStage(page)
})

test("back, forward, reload, and stop follow the guest's state", async ({ page }) => {
  await openPage(page)
  const main = page.getByRole("main")
  const back = main.getByRole("button", { name: "Back" })
  const forward = main.getByRole("button", { name: "Forward" })
  await expect(back).not.toHaveAttribute("aria-disabled", "true")
  await expect(forward).toHaveAttribute("aria-disabled", "true")

  await back.click()
  await main.getByRole("button", { name: "Reload" }).click()
  await setState(page, { ...shown, canGoBack: false, canGoForward: true, loading: true })
  await expect(back).toHaveAttribute("aria-disabled", "true")
  await expect(main.getByRole("progressbar", { name: "Loading page" })).toBeAttached()
  // Loading draws nothing over the stage.
  await expect(stage(page).locator("*")).toHaveCount(0)
  await main.getByRole("button", { name: "Stop loading" }).click()
  await forward.click()
  await expect.poll(() => calls(page, "action")).toEqual([
    ["action", gitFixtureRoot, "back"], ["action", gitFixtureRoot, "reload"], ["action", gitFixtureRoot, "stop"], ["action", gitFixtureRoot, "forward"],
  ])
})

test("failures take the stage and say what to try, a refused page stays, and closing the tab closes the page", async ({ page }) => {
  await openPage(page, { ...shown, url: "http://localhost:5173/" })
  const main = page.getByRole("main")

  await setState(page, { ...shown, url: "http://localhost:5173/", failure: { kind: "load", url: "http://localhost:5173/", description: "Could not connect: Connection refused" } })
  const alert = stage(page).getByRole("alert")
  await expect(alert).toContainText("Could not load localhost:5173/")
  await expect(alert).toContainText("Is its dev server running?")
  // Zero draws the failure where the page was, so the guest hides.
  await expect.poll(() => lastFrame(page)).toBeNull()
  await alert.getByRole("button", { name: "Try again" }).click()
  await expect.poll(async () => (await calls(page, "open")).at(-1)).toEqual(["open", gitFixtureRoot, "http://localhost:5173/"])

  await setState(page, { ...shown, failure: { kind: "certificate", url: "https://localhost:8443/", description: "Unacceptable TLS certificate" } })
  await expect(alert).toContainText("localhost:8443 has a certificate Zero does not trust")

  await setState(page, { ...shown, failure: { kind: "crashed", url: "http://localhost:5173/", description: "" } })
  await expect(alert).toContainText("The page stopped")
  await alert.getByRole("button", { name: "Reload" }).click()
  await expect.poll(async () => (await calls(page, "action")).at(-1)).toEqual(["action", gitFixtureRoot, "reload"])

  // A refused navigation is a notice above the stage; the page stays.
  await setState(page, { ...shown, failure: { kind: "refused", url: "ftp://example.com/file", description: "" } })
  const notice = main.locator(".browser-notice")
  await expect(notice).toContainText("The page tried to open ftp://example.com/file")
  await expect(stage(page)).toHaveAttribute("data-view", "page")
  await expectGuestOnStage(page)
  await notice.getByRole("button", { name: "Dismiss" }).click()
  await expect(notice).toHaveCount(0)
  await expectGuestOnStage(page)

  // An address that is not one says so; Escape puts back what the field showed.
  await address(page).fill("not a page")
  await expect(main.getByText("Enter an http or https address, like localhost:5173.")).toBeVisible()
  await address(page).press("Escape")
  await expect(address(page)).toHaveValue("http://localhost:5173/settings")

  await tabs(page).getByRole("button", { name: /^Close Browser: / }).click()
  await expect.poll(async () => (await calls(page, "action")).at(-1)).toEqual(["action", gitFixtureRoot, "close"])
  await expect.poll(() => lastFrame(page)).toBeNull()
})

test("Open Location takes the address field, from the app's menu and from the keyboard", async ({ page }) => {
  await openPage(page)
  await page.keyboard.press("ControlOrMeta+Shift+g")
  const changes = page.getByRole("region", { name: "Source Control" }).getByRole("listbox", { name: "Uncommitted changes" })
  await changes.getByRole("option", { name: /^README\.md, / }).click()
  await expect(page).toHaveURL(/review=working/)

  // The app's Browser menu, whose accelerator works while the guest has the keyboard.
  await page.evaluate((project) => {
    window.dispatchEvent(new CustomEvent("zero:browser-command", { detail: { project, command: "location" } }))
  }, gitFixtureRoot)
  await expect(page).toHaveURL(/browser=1/)
  await expect(address(page)).toBeFocused()
  await expect.poll(() => address(page).evaluate((field) => field instanceof HTMLInputElement && field.selectionEnd === field.value.length && field.selectionStart === 0)).toBe(true)

  // The same keys in Zero's page.
  await tabs(page).getByRole("tab", { name: /^README\.md|^Uncommitted|Changes/ }).first().click()
  await expect(page).toHaveURL(/review=working/)
  await page.keyboard.press("ControlOrMeta+l")
  await expect(page).toHaveURL(/browser=1/)
  await expect(address(page)).toBeFocused()

  // The palette offers it as a command.
  await page.keyboard.press("ControlOrMeta+Shift+P")
  const palette = page.getByRole("dialog", { name: "Command palette" })
  await palette.getByRole("combobox", { name: "Command" }).fill("Open Location")
  await expect(palette.getByRole("option", { name: /^Browser: Open Location…/ })).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(palette).toBeHidden()
  await expect(address(page)).toBeFocused()
})

test("narrow windows keep the address usable", async ({ page }) => {
  await browserDesktop(page)
  await page.setViewportSize({ width: 560, height: 700 })
  await page.goto(`${gitApiOrigin}/view?project=${project}&browser=1`)
  await setState(page, shown)
  await expect(address(page)).toHaveValue("http://localhost:5173/settings")
  const field = await address(page).boundingBox()
  expect(field?.width ?? 0).toBeGreaterThan(160)
  const overflow = await page.getByRole("main").evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
