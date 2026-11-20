import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { test } from "./live-test.ts"

import { composerDesktop } from "./desktop-fake.ts"
import { gitFixtureRoot } from "./git-fixture.ts"

// The composer (decision 0184): the page at /composer, which the desktop
// app shows in its own small web view beside a pick on the Browser's page.
// Here a stand-in bridge plays the app: it answers the pick that waits and
// records what the page asks. Each test serves its own copy of the git
// fixture, so its repository's feedback starts empty.
test.skip(() => !existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
test.use({ seed: gitFixtureRoot, viewport: { width: 360, height: 480 } })

// The frame the app captured: the contract fixture's screenshot, 612 × 288,
// as a 612 × 288 viewport at 1×.
const frame = readFileSync(path.join(import.meta.dirname, "../../testdata/api/default/feedback-attachment.png")).toString("base64")

interface Live {
  root: string
  origin: string
}

const box = { x: 96, y: 96, width: 210, height: 48 }

function pick(live: Live, change: Record<string, unknown> = {}) {
  return {
    project: live.root,
    png: frame,
    page: {
      url: "http://localhost:5173/settings?tab=billing", title: "Settings",
      viewport: { width: 612, height: 288, deviceScaleFactor: 1 }, scroll: { x: 0, y: 200 }, colorScheme: "dark",
    },
    rect: box,
    kind: "element",
    element: {
      tag: "button", box, selector: "main form > button#save", role: "button", name: "Save changes", text: "Save changes",
      path: "main › form.settings › button#save", classes: "btn btn-primary",
      attributes: [{ name: "type", value: "submit" }], styles: [{ name: "color", value: "rgb(255, 255, 255)" }],
      component: "SettingsForm › Button", source: "src/app.ts:1", nearby: "Cancel",
    },
    canWalkUp: true,
    canWalkDown: false,
    ...change,
  }
}

const form = { tag: "form", box: { x: 48, y: 48, width: 400, height: 200 }, selector: "main form", name: "Settings", path: "main › form.settings" }

// openComposer loads the composer's page with a pick waiting. The server
// serves the app's shell at / and /view only, so where it has no /composer
// the shell answers there, as the app's page does on every route.
async function openComposer(page: Page, live: Live, capture: unknown, experimental = true) {
  await page.route(`${live.origin}/composer`, async (route) => {
    const served = await route.fetch()
    await route.fulfill({ response: served.ok() ? served : await route.fetch({ url: `${live.origin}/` }) })
  })
  await composerDesktop(page, capture, experimental)
  await page.goto(`${live.origin}/composer`)
}

async function calls(page: Page, kind?: string): Promise<unknown[][]> {
  const all = await page.evaluate(() => window.__composer?.calls ?? [])
  return kind ? all.filter((call) => call[0] === kind) : all
}

// announce sets the pick that waits and says so, as the app does.
async function announce(page: Page, capture: unknown) {
  await page.evaluate((capture) => {
    if (window.__composer) window.__composer.capture = capture
    window.dispatchEvent(new CustomEvent("zero:composer"))
  }, capture)
}

interface Stored {
  branch: string
  threads: { number: number; visual?: { rect: unknown; page?: Record<string, unknown>; element?: Record<string, unknown> }; messages: { body: string }[] }[]
}

async function stored(request: APIRequestContext, live: Live): Promise<Stored> {
  const response = await request.get(`${live.origin}/api/feedback?project=${encodeURIComponent(live.root)}`)
  expect(response.ok()).toBe(true)
  return response.json()
}

// posts counts the page's writes: attachments uploaded and threads posted.
function posts(page: Page): { attachments: number; threads: number } {
  const count = { attachments: 0, threads: 0 }
  page.on("request", (sent) => {
    if (sent.method() !== "POST") return
    const { pathname } = new URL(sent.url())
    if (pathname === "/api/feedback-attachments") count.attachments++
    if (pathname === "/api/feedback-threads") count.threads++
  })
  return count
}

const composer = (page: Page) => page.locator(".composer")
const field = (page: Page) => page.getByRole("textbox", { name: /^Comment on / })

test("the composer shows the pick, what it sends, and where the comment goes, and nothing of the workspace", async ({ page, request, live }) => {
  const asked: string[] = []
  page.on("request", (sent) => {
    const { pathname } = new URL(sent.url())
    if (pathname.startsWith("/api/")) asked.push(pathname)
  })
  await openComposer(page, live, pick(live))

  await expect(page.getByRole("region", { name: "Comment on button \"Save changes\"" })).toBeVisible()
  await expect(composer(page).locator(".composer-pick-label")).toHaveText("button \"Save changes\"")
  await expect(composer(page).locator(".composer-origin")).toHaveText("SettingsForm › Button · src/app.ts:1")
  await expect(field(page)).toBeFocused()
  await expect(field(page)).toHaveValue("")
  const { branch } = await stored(request, live)
  expect(branch).not.toBe("")
  await expect(composer(page).locator(".composer-target")).toHaveText(`Comments go to repository · ${branch}`)
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toBeDisabled()

  // The walk buttons say which way the pick can go.
  const walk = page.getByRole("group", { name: "Change the selection" })
  await expect(walk.getByRole("button", { name: "Select parent" })).not.toHaveAttribute("aria-disabled", "true")
  await expect(walk.getByRole("button", { name: "Select child" })).toHaveAttribute("aria-disabled", "true")

  // What's sent: every fact, as text.
  const facts = composer(page).locator(".composer-facts")
  await expect(facts).toHaveCount(0)
  await page.getByRole("button", { name: "What's sent" }).click()
  const fact = (label: string) => facts.locator(".composer-fact").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd")
  await expect(fact("Page")).toHaveText("http://localhost:5173/settings?tab=billing")
  await expect(fact("Viewport")).toHaveText("612 × 288 at 1×, dark")
  await expect(fact("Rectangle")).toHaveText("96, 96 · 210 × 48")
  await expect(fact("Selector")).toHaveText("main form > button#save")
  await expect(fact("Path")).toHaveText("main › form.settings › button#save")
  await expect(fact("Classes")).toHaveText("btn btn-primary")
  await expect(fact("Attributes")).toHaveText("type=submit")
  await expect(fact("Styles")).toHaveText("color: rgb(255, 255, 255)")
  await expect(fact("Nearby text")).toHaveText("Cancel")

  // The app sizes the web view to the composer, and hears of its growth.
  const heights = (await calls(page, "resize")).map((call) => call[1])
  const height = await composer(page).evaluate((element) => Math.ceil(element.getBoundingClientRect().height))
  expect(heights.at(-1)).toBe(height)
  expect(heights.length).toBeGreaterThan(1)

  // Only the composer: no workspace, and nothing read but the branch.
  await expect(page.getByRole("navigation", { name: "Views" })).toHaveCount(0)
  await expect(page.getByRole("tablist", { name: "Open documents" })).toHaveCount(0)
  expect([...new Set(asked)]).toEqual(["/api/feedback"])
})

test("text from the page is shown as text, and the composer fits its 360 px web view", async ({ page, live }) => {
  const hostile = "<img src=x onerror=\"document.title='owned'\"> " + "wide".repeat(60)
  await openComposer(page, live, pick(live, {
    element: { tag: "button", box, name: hostile, selector: hostile, path: hostile, component: hostile, source: hostile, nearby: hostile },
  }))
  await page.setViewportSize({ width: 360, height: 1400 })
  await expect(composer(page).locator(".composer-pick-label")).toContainText("<img src=x")
  await page.getByRole("button", { name: "What's sent" }).click()
  await expect(composer(page).locator(".composer-facts")).toContainText("<img src=x")
  await expect(composer(page).locator("img")).toHaveCount(0)
  expect(await page.title()).not.toBe("owned")
  // Long values wrap or clip; the page never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await composer(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(page.getByRole("button", { name: "Select parent" })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 })
})

test("Alt+Up and Alt+Down walk the pick and keep the comment; a region walks nowhere", async ({ page, live }) => {
  await openComposer(page, live, pick(live))
  await field(page).fill("Too close to the edge.")
  await page.evaluate(({ parent, child }) => {
    if (window.__composer) window.__composer.walks = { parent, child }
  }, {
    parent: pick(live, { rect: form.box, element: form, canWalkUp: false, canWalkDown: true }),
    child: pick(live),
  })

  await page.keyboard.press("Alt+ArrowUp")
  await expect(composer(page).locator(".composer-pick-label")).toHaveText("form \"Settings\"")
  await expect(field(page)).toHaveValue("Too close to the edge.")
  await expect(field(page)).toBeFocused()
  await expect(composer(page).locator(".composer-origin")).toHaveCount(0)
  const walk = page.getByRole("group", { name: "Change the selection" })
  await expect(walk.getByRole("button", { name: "Select parent" })).toHaveAttribute("aria-disabled", "true")
  // The top of the page: nothing more to walk to, and nothing is asked.
  await page.keyboard.press("Alt+ArrowUp")
  await walk.getByRole("button", { name: "Select child" }).click()
  await expect(composer(page).locator(".composer-pick-label")).toHaveText("button \"Save changes\"")
  await expect(field(page)).toHaveValue("Too close to the edge.")
  expect(await calls(page, "walk")).toEqual([["walk", "parent"], ["walk", "child"]])

  // A region: no walk buttons, and the keys do nothing.
  await announce(page, pick(live, { kind: "region", rect: { x: 40, y: 60, width: 260, height: 80 }, element: null, canWalkUp: false, canWalkDown: false }))
  await expect(composer(page).locator(".composer-pick-label")).toHaveText("Region 260 × 80")
  await expect(walk).toHaveCount(0)
  await page.keyboard.press("Alt+ArrowUp")
  expect((await calls(page, "walk")).length).toBe(2)
})

test("sending uploads the selection once, posts one thread with the facts, and closes the composer", async ({ page, request, live }) => {
  const count = posts(page)
  await openComposer(page, live, pick(live))
  await field(page).fill("Save overlaps the card edge.\n\nKeep it inside the padding.")
  // Twice at once posts once.
  await page.keyboard.press("ControlOrMeta+Enter")
  await page.keyboard.press("ControlOrMeta+Enter")

  await expect.poll(() => calls(page, "close")).toEqual([["close", true]])
  await expect(composer(page)).toHaveCount(0)
  expect(count).toEqual({ attachments: 1, threads: 1 })

  const { threads } = await stored(request, live)
  expect(threads).toHaveLength(1)
  const visual = threads[0]?.visual
  expect(threads[0]?.messages[0]?.body).toBe("Save overlaps the card edge.\n\nKeep it inside the padding.")
  // The screenshot is the selection and 48 CSS px around it; the rectangle
  // and the element's box are in its pixels.
  expect(visual?.rect).toEqual({ x: 48, y: 48, width: 210, height: 48 })
  expect(visual?.page).toMatchObject({
    url: "http://localhost:5173/settings?tab=billing", title: "Settings", colorScheme: "dark",
    viewport: { width: 612, height: 288, deviceScaleFactor: 1 }, scroll: { x: 0, y: 200 }, clip: { x: 48, y: 48, width: 306, height: 144 },
  })
  expect(visual?.element).toEqual({
    tag: "button", box: { x: 48, y: 48, width: 210, height: 48 }, selector: "main form > button#save", role: "button", name: "Save changes",
    text: "Save changes", path: "main › form.settings › button#save", classes: "btn btn-primary",
    attributes: [{ name: "type", value: "submit" }], styles: [{ name: "color", value: "rgb(255, 255, 255)" }],
    component: "SettingsForm › Button", source: "src/app.ts:1", nearby: "Cancel",
  })

  // The next pick starts clean.
  await announce(page, pick(live, { kind: "region", rect: { x: 0, y: 0, width: 100, height: 40 }, element: null }))
  await expect(composer(page).locator(".composer-pick-label")).toHaveText("Region 100 × 40")
  await expect(field(page)).toHaveValue("")
  await expect(field(page)).toBeFocused()
})

test("a failure stays in the composer with its message and keeps the comment", async ({ page, request, live }) => {
  await openComposer(page, live, pick(live))
  await page.route("**/api/feedback-threads", (route) => route.fulfill({
    status: 500, contentType: "application/json", body: JSON.stringify({ error: "the feedback store is read-only" }),
  }))
  await field(page).fill("Save overlaps the card edge.")
  await page.getByRole("button", { name: "Comment", exact: true }).click()

  const alert = composer(page).getByRole("alert")
  await expect(alert).toContainText("Couldn't add the comment")
  await expect(alert).toContainText("the feedback store is read-only")
  await expect(field(page)).toHaveValue("Save overlaps the card edge.")
  await expect(field(page)).toBeEnabled()
  expect(await calls(page, "close")).toEqual([])
  expect((await stored(request, live)).threads).toHaveLength(0)

  // Sending again posts it.
  await page.unroute("**/api/feedback-threads")
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await expect.poll(() => calls(page, "close")).toEqual([["close", true]])
  const { threads } = await stored(request, live)
  expect(threads.map((thread) => thread.messages[0]?.body)).toEqual(["Save overlaps the card edge."])
})

test("Escape and Cancel close without sending, and a pick that ended clears the comment", async ({ page, request, live }) => {
  const count = posts(page)
  await openComposer(page, live, pick(live))
  await field(page).fill("Never sent.")
  await page.keyboard.press("Escape")
  await expect.poll(() => calls(page, "close")).toEqual([["close", false]])

  // The app says the pick ended: the composer is the empty surface.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zero:composer")))
  await expect(composer(page)).toHaveCount(0)
  await expect(page.locator(".composer-page")).toBeVisible()
  await expect(page.locator(".composer-page *")).toHaveCount(0)

  // The next pick starts with no comment.
  await announce(page, pick(live))
  await expect(field(page)).toHaveValue("")
  await field(page).fill("Not this one either.")
  await page.getByRole("button", { name: "Cancel" }).click()
  await expect.poll(() => calls(page, "close")).toEqual([["close", false], ["close", false]])
  expect(count).toEqual({ attachments: 0, threads: 0 })
  expect((await stored(request, live)).threads).toHaveLength(0)
})

test("no pick, or experimental features off, shows the empty surface", async ({ page, live }) => {
  await openComposer(page, live, null)
  await expect(page.locator(".composer-page")).toBeVisible()
  await expect(composer(page)).toHaveCount(0)
  await expect.poll(() => calls(page, "capture")).toEqual([["capture"]])
  expect(await calls(page, "resize")).toEqual([])

  const off = await page.context().newPage()
  await openComposer(off, live, pick(live), false)
  await expect(off.locator(".composer-page")).toBeVisible()
  await expect(composer(off)).toHaveCount(0)
  expect(await calls(off)).toEqual([])
})
