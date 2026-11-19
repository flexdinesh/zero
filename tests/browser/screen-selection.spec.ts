import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { expect, type BrowserContext, type Page } from "@playwright/test"
import { isFeedback } from "../../packages/contracts/src/index.ts"

import { gitFixtureRoot } from "./git-fixture.ts"
import { test } from "./live-test.ts"

// Selecting on a frozen capture (decision 0180). The guest fixture runs
// guest.js in a page of its own, as a review window would; its capture()
// and a screenshot of the same moment stand in for the desktop app's
// capture, which a stand-in bridge hands the workspace's composer.
test.skip(() => !existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
test.use({ seed: gitFixtureRoot })

const guestScript = fileURLToPath(new URL("../../apps/desktop/internal/review/guest.js", import.meta.url))
const fixture = readFileSync(fileURLToPath(new URL("../../testdata/review/guest/index.html", import.meta.url)), "utf8")
const guestURL = "http://review.test/settings"
const viewport = { width: 1280, height: 800 }

// guestCapture loads the fixture, lets prepare set its state, and captures
// its facts, hit map, and frame together, as Comment on Screen does.
async function guestCapture(context: BrowserContext, project: string, prepare: (guest: Page) => Promise<void>, drift = false) {
  const guest = await context.newPage()
  await guest.setViewportSize(viewport)
  await guest.route("http://review.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture }))
  await guest.addInitScript({ path: guestScript })
  await guest.goto(guestURL)
  await prepare(guest)
  const facts = JSON.parse(String(await guest.evaluate(() => Reflect.get(window, "__zeroReview").capture())))
  const png = await guest.screenshot()
  await guest.close()
  return {
    id: "0123456789ab",
    project,
    png: png.toString("base64"),
    page: { url: guestURL, title: facts.title, viewport: { ...viewport, deviceScaleFactor: 1 }, scroll: { x: facts.scrollX, y: facts.scrollY } },
    hits: facts.hits,
    drift,
  }
}

// openComposer hands capture to the workspace through a stand-in desktop
// bridge, which gives it out once, and waits for the composer.
async function openComposer(page: Page, origin: string, root: string, capture: unknown) {
  await page.addInitScript((pending: unknown) => {
    let waiting = pending
    Reflect.set(window, "zeroDesktop", {
      version: 2,
      screenCapture() {
        const taken = waiting
        waiting = null
        return Promise.resolve(taken)
      },
    })
  }, capture)
  await page.goto(`${origin}/view?project=${encodeURIComponent(root)}`)
  const dialog = page.getByRole("dialog", { name: "New screen comment" })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(".screen-image")).toBeVisible()
  return dialog
}

// at maps a CSS point of the captured viewport to the screen.
async function at(page: Page, x: number, y: number) {
  const box = await page.locator(".screen-frame").boundingBox()
  if (!box) throw new Error("the frozen frame is not shown")
  return { x: box.x + (x / viewport.width) * box.width, y: box.y + (y / viewport.height) * box.height }
}

async function click(page: Page, x: number, y: number) {
  const point = await at(page, x, y)
  await page.mouse.click(point.x, point.y)
}

test("a click selects the element under it, Alt+Up walks out, and Escape clears before it closes", async ({ page, context, live }) => {
  const capture = await guestCapture(context, live.root, async (guest) => {
    await guest.getByRole("button", { name: "Project" }).hover()
    await expect(guest.getByRole("menuitem", { name: "Delete project" })).toBeVisible()
  })
  const dialog = await openComposer(page, live.origin, live.root, capture)
  const readout = dialog.locator(".screen-readout")
  await expect(readout).toContainText("Click an element or drag a region")

  // Hovering outlines what a click would select: the menu the page showed.
  const item = await at(page, 30, 100)
  await page.mouse.move(item.x, item.y)
  await expect(dialog.locator(".screen-hover-box")).toBeVisible()
  await expect(readout).toContainText("menuitem \"Delete project\" · click to select it")

  await page.mouse.down()
  await page.mouse.up()
  await expect(readout).toContainText("menuitem \"Delete project\" 212 × 32 px")
  await expect(dialog.getByText("li \"Delete project\"")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Clear" })).toBeVisible()

  await page.keyboard.press("Alt+ArrowUp")
  await expect(readout).toContainText("menu \"Project\" 220 × 72 px")
  await page.keyboard.press("Alt+ArrowDown")
  await expect(readout).toContainText("menuitem \"Delete project\" 212 × 32 px")

  // A gap between two cards selects the row that holds them.
  await click(page, 270, 180)
  await expect(readout).toContainText("group \"Cards\" 700 × 120 px")

  // Escape clears the selection first; the composer stays.
  await page.keyboard.press("Escape")
  await expect(readout).toContainText("Click an element or drag a region")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Clear" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

test("a drag over a canvas marks a free region, sent with the element the page showed there", async ({ page, context, live, request }) => {
  const capture = await guestCapture(context, live.root, async () => undefined)
  const dialog = await openComposer(page, live.origin, live.root, capture)
  const readout = dialog.locator(".screen-readout")

  const from = await at(page, 820, 140)
  const to = await at(page, 1000, 260)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await expect(readout).toContainText(/^Region \d+ × \d+ px/)
  await expect(dialog.getByText("canvas", { exact: true })).toBeVisible()

  await dialog.getByRole("textbox", { name: "Comment" }).fill("The chart's line clips at the top.")
  await dialog.getByRole("button", { name: "Send" }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })

  const response = await request.get(`${live.origin}/api/feedback?project=${encodeURIComponent(live.root)}`)
  const feedback: unknown = await response.json()
  if (!isFeedback(feedback)) throw new Error("not a feedback")
  const visual = feedback.threads.at(-1)?.visual
  expect(visual?.element).toMatchObject({ tag: "canvas", selector: "[data-testid=\"chart\"]" })
  expect(visual?.page?.viewport).toEqual({ ...viewport, deviceScaleFactor: 1 })
  // The region, in the attached image's pixels: within a pixel of the drag.
  const clip = visual?.page?.clip
  const rect = visual?.rect
  expect(clip).toBeDefined()
  expect(Math.abs((rect?.x ?? 0) + (clip?.x ?? 0) - 820)).toBeLessThanOrEqual(2)
  expect(Math.abs((rect?.width ?? 0) - 180)).toBeLessThanOrEqual(2)
})

test("a scrolled capture selects in its own viewport, and a drifted one says so", async ({ page, context, live }) => {
  const capture = await guestCapture(context, live.root, async (guest) => {
    await guest.evaluate(() => scrollTo(0, 700))
  }, true)
  const dialog = await openComposer(page, live.origin, live.root, capture)
  await expect(dialog.getByText("The page moved while it was captured. Outlines may not match the image.")).toBeVisible()
  await click(page, 50, 310)
  await expect(dialog.locator(".screen-readout")).toContainText("button \"Far away\" 160 × 40 px")
  // The fixed nav stays over what scrolled under it.
  await click(page, 600, 20)
  await expect(dialog.locator(".screen-readout")).toContainText("navigation \"App\"")
})
