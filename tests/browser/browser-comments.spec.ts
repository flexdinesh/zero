import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { test } from "./live-test.ts"

import { browserDesktop, type FakeBrowserState } from "./desktop-fake.ts"
import { gitFixtureRoot } from "./git-fixture.ts"

// Comments on the Browser's page (decision 0184): the tab's Comment and
// pins toggles, the pins the page tells the app to draw, and the Browser
// view's list of the page's threads. A stand-in bridge plays the app. Each
// test serves its own copy of the git fixture, so its feedback starts
// empty.
test.skip(() => !existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
test.use({ seed: gitFixtureRoot })

// The contract fixture's screenshot: 612 × 288.
const screenshot = readFileSync(path.join(import.meta.dirname, "../../testdata/api/default/feedback-attachment.png"))

interface Live {
  root: string
  origin: string
}

interface Comment {
  body: string
  url: string
  // selector names the element; without one the comment is on a region.
  selector?: string
  resolved?: boolean
}

async function feedbackId(request: APIRequestContext, live: Live): Promise<string> {
  const response = await request.get(`${live.origin}/api/feedback?project=${encodeURIComponent(live.root)}`)
  expect(response.ok()).toBe(true)
  const { id }: { id: string } = await response.json()
  return id
}

// comment posts a visual thread as the composer does: the rectangle
// 96,96 420×96 of a 612 × 288 viewport at 1×, scrolled down 200.
async function comment(request: APIRequestContext, live: Live, { body, resolved, selector, url }: Comment): Promise<number> {
  const upload = await request.post(`${live.origin}/api/feedback-attachments?project=${encodeURIComponent(live.root)}`, {
    data: screenshot, headers: { "Content-Type": "image/png", Origin: live.origin },
  })
  expect(upload.ok()).toBe(true)
  const { id: attachment }: { id: string } = await upload.json()
  const rect = { x: 96, y: 96, width: 420, height: 96 }
  const created = await request.post(`${live.origin}/api/feedback-threads`, {
    data: {
      project: live.root, body,
      visual: {
        attachment, rect,
        page: { url, title: "Settings", viewport: { width: 612, height: 288, deviceScaleFactor: 1 }, scroll: { x: 0, y: 200 }, clip: { x: 0, y: 0, width: 612, height: 288 } },
        ...(selector ? { element: { tag: "button", selector, role: "button", name: "Save changes", box: rect, ...facts } } : {}),
      },
    },
    headers: { Origin: live.origin },
  })
  expect(created.ok()).toBe(true)
  const { number }: { number: number } = await created.json()
  if (resolved) {
    const closed = await request.post(`${live.origin}/api/feedback-messages`, {
      data: { project: live.root, id: await feedbackId(request, live), thread: number, body: "Moved it.", status: "resolved", author: "agent" },
      headers: { Origin: live.origin },
    })
    expect(closed.ok()).toBe(true)
  }
  return number
}

// What else the page said of each picked element.
const facts = {
  path: "main › form.settings › button", classes: "btn btn-primary", component: "SettingsForm › Button", source: "src/app.ts:1",
  styles: ["color", "background-color", "font-size", "padding", "margin", "border-radius"].map((name) => ({ name, value: "<b>0</b>" })),
}

const shown: FakeBrowserState = {
  url: "http://localhost:5173/settings", title: "Settings", loading: false, canGoBack: false, canGoForward: false, failure: null,
}

// setState sets the guest's state and announces it, as the app does.
async function setState(page: Page, live: Live, state: FakeBrowserState | null) {
  await page.evaluate(({ state, project }) => {
    if (window.__browser) window.__browser.state = state
    window.dispatchEvent(new CustomEvent("zero:browser", { detail: project }))
  }, { state, project: live.root })
}

async function calls(page: Page, kind: string): Promise<unknown[][]> {
  const all = await page.evaluate(() => window.__browser?.calls ?? [])
  return all.filter((call) => call[0] === kind)
}

// lastPins is what the page last told the app to draw: [pins, visible].
async function lastPins(page: Page): Promise<unknown> {
  const last = (await calls(page, "pins")).at(-1)
  return last ? [last[2], last[3]] : "none"
}

// openBrowser opens the Browser activity and its tab on the page a guest
// shows.
async function openBrowser(page: Page, live: Live, state: FakeBrowserState | null = shown, comments = true) {
  await browserDesktop(page, true, comments)
  await page.goto(`${live.origin}/?project=${encodeURIComponent(live.root)}`)
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Browser/ }).click()
  await expect(page.getByRole("combobox", { name: "Page address" })).toBeVisible()
  if (state) {
    await setState(page, live, state)
    await expect(page.locator(".browser-stage")).toHaveAttribute("data-view", "page")
  }
}

const pane = (page: Page) => page.locator(".browser-view")
const toolbar = (page: Page) => page.getByRole("main")
const commentToggle = (page: Page) => toolbar(page).getByRole("button", { name: "Comment", exact: true })
const pinsToggle = (page: Page) => toolbar(page).getByRole("button", { name: "Show comment pins" })
const hint = (page: Page) => toolbar(page).getByText("Click an element or drag a region · Esc to finish")
const onThisPage = (page: Page) => pane(page).getByRole("listbox", { name: /^On this page/ }).getByRole("option")
const pin = { x: 516, y: 296 }

test("Comment turns comment mode on and off, and Escape ends it", async ({ page, live }) => {
  await openBrowser(page, live, null)
  // Nothing to comment on yet.
  await expect(commentToggle(page)).toHaveAttribute("aria-disabled", "true")
  await expect(commentToggle(page)).toHaveAttribute("title", "Open a page first")
  await commentToggle(page).click({ force: true })
  expect(await calls(page, "action")).toEqual([])

  await setState(page, live, shown)
  await expect(commentToggle(page)).not.toHaveAttribute("aria-disabled", "true")
  await expect(commentToggle(page)).toHaveAttribute("aria-pressed", "false")
  await expect(commentToggle(page)).toHaveAttribute("title", /^Comment on the page \((Ctrl\+Shift\+C|⇧⌘C)\)$/)
  await expect(hint(page)).toHaveCount(0)
  await commentToggle(page).click()
  await expect.poll(() => calls(page, "action")).toEqual([["action", live.root, "comment"]])

  // The app says the mode is on: the toggle is pressed and the row says
  // what to do.
  await setState(page, live, { ...shown, commenting: true })
  await expect(commentToggle(page)).toHaveAttribute("aria-pressed", "true")
  await expect(commentToggle(page)).toHaveAttribute("title", /^Stop commenting \(/)
  await expect(hint(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect.poll(() => calls(page, "action")).toEqual([["action", live.root, "comment"], ["action", live.root, "endComment"]])
  await commentToggle(page).click()
  await expect.poll(async () => (await calls(page, "action")).at(-1)).toEqual(["action", live.root, "endComment"])
  expect(await calls(page, "action")).toHaveLength(3)

  await setState(page, live, shown)
  await expect(commentToggle(page)).toHaveAttribute("aria-pressed", "false")
  await expect(hint(page)).toHaveCount(0)
  // Escape outside the mode asks nothing.
  await page.keyboard.press("Escape")
  expect(await calls(page, "action")).toHaveLength(3)

  // A page that failed takes no comments.
  await setState(page, live, { ...shown, failure: { kind: "load", url: shown.url, description: "Could not connect: Connection refused" } })
  await expect(commentToggle(page)).toHaveAttribute("aria-disabled", "true")
  await expect(commentToggle(page)).toHaveAttribute("title", "The page did not load")
})

test("an app without in-page comments shows no Comment, pins, or list", async ({ page, live, request }) => {
  await comment(request, live, { body: "Save overlaps the card edge.", url: shown.url, selector: "#save" })
  await openBrowser(page, live, shown, false)
  await expect(toolbar(page).getByRole("button", { name: "Reload" })).toBeVisible()
  await expect(commentToggle(page)).toHaveCount(0)
  await expect(pinsToggle(page)).toHaveCount(0)
  await expect(pane(page).getByRole("heading", { name: "Pages" })).toBeVisible()
  await expect(pane(page).getByRole("heading", { name: /^On this page/ })).toHaveCount(0)
  await expect(pane(page).getByText(/^Comments go to/)).toHaveCount(0)
})

test("the page's threads become its pins and its list, and both follow the address", async ({ page, live, request }) => {
  const save = await comment(request, live, { body: "Save overlaps the card edge.\n\nKeep it inside.", url: "http://localhost:5173/settings?tab=billing", selector: "#save" })
  const done = await comment(request, live, { body: "The footer is cut off.", url: shown.url, resolved: true })
  const other = await comment(request, live, { body: "The total is wrong.", url: "http://localhost:5173/billing", selector: "#total" })
  const region = await comment(request, live, { body: "Too much space here.", url: shown.url })
  const id = await feedbackId(request, live)
  await openBrowser(page, live)

  // Open threads first, then the resolved one; the other page's is left out.
  await expect.poll(() => lastPins(page)).toEqual([[
    { thread: save, resolved: false, selector: "#save", ...pin },
    { thread: region, resolved: false, ...pin },
    { thread: done, resolved: true, ...pin },
  ], true])
  await expect(pane(page).getByRole("heading", { name: "On this page" })).toContainText("2 open")
  await expect(onThisPage(page)).toHaveCount(3)
  await expect(onThisPage(page).nth(0)).toHaveAccessibleName(
    `Thread ${save}, open: button "Save changes", Save overlaps the card edge., at http://localhost:5173/settings?tab=billing`)
  await expect(onThisPage(page).nth(0).locator(".browser-comment-address")).toHaveText("http://localhost:5173/settings?tab=billing")
  await expect(onThisPage(page).nth(1)).toHaveAccessibleName(`Thread ${region}, open: Region, Too much space here.`)
  await expect(onThisPage(page).nth(1).locator(".browser-comment-address")).toHaveCount(0)
  await expect(onThisPage(page).nth(2)).toHaveAccessibleName(`Thread ${done}, resolved: Region, The footer is cut off.`)
  const { branch }: { branch: string } = await (await request.get(`${live.origin}/api/feedback?project=${encodeURIComponent(live.root)}`)).json()
  await expect(pane(page).locator(".browser-view-foot")).toContainText(`repository`)
  await expect(pane(page).locator(".browser-view-foot")).toContainText(branch)

  // The same page under the query the thread was written on: no address.
  await setState(page, live, { ...shown, url: "http://localhost:5173/settings?tab=billing" })
  await expect(onThisPage(page).nth(0).locator(".browser-comment-address")).toHaveCount(0)
  await expect(onThisPage(page).nth(1).locator(".browser-comment-address")).toHaveText("http://localhost:5173/settings")

  // Another page: its own threads.
  await setState(page, live, { ...shown, url: "http://localhost:5173/billing" })
  await expect.poll(() => lastPins(page)).toEqual([[{ thread: other, resolved: false, selector: "#total", ...pin }], true])
  await expect(onThisPage(page)).toHaveCount(1)
  await expect(onThisPage(page)).toHaveAccessibleName(`Thread ${other}, open: button "Save changes", The total is wrong.`)

  // A page with no comments says how to make the first.
  await setState(page, live, { ...shown, url: "http://localhost:5173/" })
  await expect.poll(() => lastPins(page)).toEqual([[], true])
  await expect(onThisPage(page)).toHaveCount(0)
  await expect(pane(page).getByText(/^To comment on this page, choose Comment in the toolbar or press (Ctrl\+Shift\+C|⇧⌘C), then click what you mean\.$/)).toBeVisible()

  // A row opens its thread's screen tab.
  await setState(page, live, shown)
  await onThisPage(page).nth(1).click()
  await expect(page.locator(`[data-tab="screen:${id}:${region}"]`)).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("main").getByRole("region", { name: "Screenshot" })).toBeVisible()

  // An element's thread says what the page said of it, as text.
  await onThisPage(page).nth(0).click()
  await expect(page.locator(`[data-tab="screen:${id}:${save}"]`)).toHaveAttribute("aria-selected", "true")
  const details = page.getByRole("main").locator(".screen-tab-facts")
  await expect(details).toContainText("main › form.settings › button")
  await expect(details).toContainText("SettingsForm › Button")
  await expect(details).toContainText("src/app.ts:1")
  await expect(details).toContainText("btn btn-primary")
  await expect(details.locator(".screen-tab-fact span", { hasText: "<b>0</b>" })).toHaveCount(4)
  await expect(details.locator("b")).toHaveCount(0)
  await details.getByRole("button", { name: "2 more" }).click()
  await expect(details.locator(".screen-tab-fact span", { hasText: "<b>0</b>" })).toHaveCount(6)
  await expect(details.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true")
})

test("the pins toggle hides and shows pins, and each project remembers it", async ({ page, live, request }) => {
  const save = await comment(request, live, { body: "Save overlaps the card edge.", url: shown.url, selector: "#save" })
  const pins = [{ thread: save, resolved: false, selector: "#save", ...pin }]
  await openBrowser(page, live)
  await expect.poll(() => lastPins(page)).toEqual([pins, true])
  await expect(pinsToggle(page)).toHaveAttribute("aria-pressed", "true")
  await expect(pinsToggle(page)).toHaveAttribute("title", "Hide comment pins")

  await pinsToggle(page).click()
  await expect(pinsToggle(page)).toHaveAttribute("aria-pressed", "false")
  await expect(pinsToggle(page)).toHaveAttribute("title", "Show comment pins")
  await expect.poll(() => lastPins(page)).toEqual([pins, false])
  // The list stays.
  await expect(onThisPage(page)).toHaveCount(1)

  // Remembered when the window opens again.
  await page.reload()
  await expect(page.getByRole("combobox", { name: "Page address" })).toBeVisible()
  await setState(page, live, shown)
  await expect(pinsToggle(page)).toHaveAttribute("aria-pressed", "false")
  await expect.poll(() => lastPins(page)).toEqual([pins, false])
  await pinsToggle(page).click()
  await expect.poll(() => lastPins(page)).toEqual([pins, true])
})

test("a sent comment refreshes the list and the pins, and a pin opens its thread", async ({ page, live, request }) => {
  const save = await comment(request, live, { body: "Save overlaps the card edge.", url: shown.url, selector: "#save" })
  const id = await feedbackId(request, live)
  await openBrowser(page, live)
  await expect(onThisPage(page)).toHaveCount(1)
  const sent = (await calls(page, "pins")).length

  // The composer posted a comment; the app says so.
  const next = await comment(request, live, { body: "The label wraps.", url: shown.url, selector: "#label" })
  await page.evaluate((project) => window.dispatchEvent(new CustomEvent("zero:browser-commented", { detail: project })), live.root)
  await expect(onThisPage(page)).toHaveCount(2)
  await expect.poll(() => lastPins(page)).toEqual([[
    { thread: save, resolved: false, selector: "#save", ...pin },
    { thread: next, resolved: false, selector: "#label", ...pin },
  ], true])
  expect((await calls(page, "pins")).length).toBeGreaterThan(sent)

  // Another project's events are not this window's.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zero:browser-pin", { detail: { project: "/elsewhere", thread: 1 } })))
  await page.evaluate(({ project, thread }) => window.dispatchEvent(new CustomEvent("zero:browser-pin", { detail: { project, thread } })), { project: live.root, thread: next })
  await expect(page.locator(`[data-tab="screen:${id}:${next}"]`)).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(`[data-tab="screen:${id}:1"]`)).toHaveCount(next === 1 ? 1 : 0)
  await expect(page.getByRole("main").getByText("The label wraps.")).toBeVisible()
})
