import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { expect, test, type Page } from "@playwright/test"

// Every guest page in the desktop app runs guest.js before its own scripts
// (decisions 0175, 0176, 0177, 0180); the app reads it through
// window.__zeroReview. Here a stand-in page plays the developer's app, and
// capture() answers its facts and hit map in one step.

const guestScript = fileURLToPath(new URL("../../apps/desktop/internal/review/guest.js", import.meta.url))
const fixture = readFileSync(fileURLToPath(new URL("../../testdata/review/guest/index.html", import.meta.url)), "utf8")
const pageURL = "http://review.test/settings"

const html = `<!doctype html>
<html><head><title>  Settings
  · Acme </title><style>
  body { margin: 0; height: 3000px; font: 14px/20px sans-serif; }
  .abs { position: absolute; width: 120px; height: 40px; }
  li { height: 20px; }
</style></head><body>
  <main><form>
    <button class="abs" style="left: 100px; top: 200px" data-testid="save">Save <span>changes</span></button>
    <label class="abs" style="left: 300px; top: 200px; width: 190px">Password <input type="password" value="hunter2" style="width: 60px"></label>
    <textarea class="abs" style="left: 500px; top: 200px" aria-label="Notes">secret notes</textarea>
    <div class="abs" style="left: 700px; top: 200px" contenteditable="true">draft text</div>
    <input class="abs" style="left: 100px; top: 300px" autocomplete="cc-number" value="4111111111111111" placeholder="Card number">
  </form>
  <ul style="position: absolute; left: 300px; top: 300px; margin: 0; padding: 0; list-style: none">
    <li>Profile</li><li>Billing</li><li>Sign out</li>
  </ul>
  <iframe class="abs" style="left: 500px; top: 300px" srcdoc="<p>framed</p>"></iframe>
  <section class="abs" style="left: 700px; top: 300px"><p style="margin: 0">Card <input value="typed by user" style="width: 40px"> on file</p></section>
  </main>
</body></html>`

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface HitElement {
  parent: number
  tag?: string
  selector?: string
  role?: string
  name?: string
  text?: string
  box?: Box
  meaningful?: boolean
}

interface Hits {
  step: number
  columns: number
  rows: number
  grid: number[]
  elements: HitElement[]
}

interface Captured {
  title: string
  width: number
  height: number
  devicePixelRatio: number
  scrollX: number
  scrollY: number
  signature: string
  hits: Hits
}

async function capture(page: Page): Promise<Captured> {
  const raw = await page.evaluate(() => Reflect.get(window, "__zeroReview").capture())
  expect(typeof raw).toBe("string")
  return JSON.parse(String(raw))
}

// elementAt is the element the hit map shows at a CSS point: the topmost at
// its cell, or the nearest ancestor holding the point (the composer's rule).
function elementAt({ hits }: Captured, x: number, y: number): HitElement | null {
  if (x < 0 || y < 0 || x >= hits.columns * hits.step || y >= hits.rows * hits.step) return null
  const holds = (box: Box | undefined) => box !== undefined && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
  for (let index = hits.grid[Math.floor(y / hits.step) * hits.columns + Math.floor(x / hits.step)] ?? -1; index >= 0; index = hits.elements[index]?.parent ?? -1) {
    const element = hits.elements[index]
    if (element && holds(element.box)) return element
  }
  return null
}

function bySelector(captured: Captured, selector: string): HitElement | undefined {
  return captured.hits.elements.find((element) => element.selector === selector)
}

test.describe("a stand-in page", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 })
    await page.route("http://review.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }))
    await page.addInitScript({ path: guestScript })
    await page.goto(pageURL)
  })

  test("capture answers the page's title, viewport, pixel ratio, scroll, and a layout signature", async ({ page }) => {
    await page.evaluate(() => scrollTo(0, 120))
    const captured = await capture(page)
    expect(captured).toMatchObject({ title: "Settings · Acme", width: 1000, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 120 })
    // The signature holds while the layout does, and moves with it.
    expect(await page.evaluate(() => Reflect.get(window, "__zeroReview").signature())).toBe(captured.signature)
    await page.evaluate(() => scrollTo(0, 160))
    expect(await page.evaluate(() => Reflect.get(window, "__zeroReview").signature())).not.toBe(captured.signature)
  })

  test("the hit map covers the viewport in cells, with parents before their children", async ({ page }) => {
    const { hits } = await capture(page)
    expect(hits.columns).toBe(Math.ceil(1000 / hits.step))
    expect(hits.rows).toBe(Math.ceil(600 / hits.step))
    expect(hits.grid).toHaveLength(hits.columns * hits.rows)
    expect(hits.columns * hits.rows).toBeLessThanOrEqual(20000)
    for (const [index, element] of hits.elements.entries()) expect(element.parent).toBeLessThan(index)
    for (const cell of hits.grid) expect(cell).toBeLessThan(hits.elements.length)
  })

  test("elements carry a selector that finds them alone, their role, name, text, and visible box", async ({ page }) => {
    const captured = await capture(page)
    // The button's padding, beside its text.
    expect(elementAt(captured, 104, 204)).toMatchObject({
      selector: "[data-testid=\"save\"]",
      tag: "button",
      role: "button",
      name: "Save changes",
      text: "Save changes",
      box: { x: 100, y: 200, width: 120, height: 40 },
      meaningful: true,
    })
    const billing = elementAt(captured, 320, 330)
    expect(billing).toMatchObject({ tag: "li", role: "listitem", text: "Billing" })
    expect(await page.evaluate((selector) => document.querySelectorAll(selector).length, billing?.selector ?? "")).toBe(1)
    // A frame is one opaque element; nothing of its document shows.
    const frame = elementAt(captured, 560, 320)
    expect(frame?.tag).toBe("iframe")
    expect(frame?.text).toBeUndefined()
    expect(elementAt(captured, 1200, 10)).toBeNull()
  })

  test("the hit map never reads field values or the text of fields, editable regions, passwords, or cards", async ({ page }) => {
    const captured = await capture(page)
    const raw = JSON.stringify(captured)
    for (const secret of ["hunter2", "secret notes", "draft text", "4111111111111111", "typed by user"]) {
      expect(raw).not.toContain(secret)
    }
    const [label, password, notes, editable, card, paragraph] = [[305, 210], [420, 210], [560, 220], [760, 220], [160, 320], [710, 310]]
      .map(([x, y]) => elementAt(captured, x ?? 0, y ?? 0))
    expect(label?.tag).toBe("label")
    expect(label?.text).toBe("Password")
    expect(password).toMatchObject({ tag: "input", role: "textbox", name: "Password" })
    expect(password?.text).toBeUndefined()
    expect(notes).toMatchObject({ tag: "textarea", name: "Notes" })
    expect(notes?.text).toBeUndefined()
    expect(editable?.tag).toBe("div")
    expect(editable?.text).toBeUndefined()
    expect(card).toMatchObject({ tag: "input", name: "Card number" })
    expect(paragraph?.text).toBe("Card on file")
  })

  test("the page's own JSON and DOM methods cannot change what the script answers", async ({ page }) => {
    await page.evaluate(() => {
      JSON.stringify = () => "{\"title\":\"evil\"}"
      Document.prototype.elementFromPoint = () => document.body
      const all = Document.prototype.querySelectorAll
      Document.prototype.querySelectorAll = function () { return all.call(this, "body") }
    })
    const captured = await capture(page)
    expect(captured.title).toBe("Settings · Acme")
    expect(elementAt(captured, 104, 204)?.tag).toBe("button")
  })

  test("the page cannot replace the script's API", async ({ page }) => {
    const replaced = await page.evaluate(() => {
      try {
        Object.defineProperty(window, "__zeroReview", { value: { capture: () => "{}" } })
        return true
      } catch {
        return false
      }
    })
    expect(replaced).toBe(false)
  })
})

// The controlled guest fixture (testdata/review/guest): a transient menu,
// a gap, a clipping card, a canvas, an inner scroller, and a far button.
test.describe("the guest fixture", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.route("http://review.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture }))
    await page.addInitScript({ path: guestScript })
    await page.goto(pageURL)
  })

  test("a hovered menu is in the hit map; it closes once the window loses focus", async ({ page }) => {
    await page.getByRole("button", { name: "Project" }).hover()
    await expect(page.getByRole("menuitem", { name: "Delete project" })).toBeVisible()
    const captured = await capture(page)
    expect(elementAt(captured, 30, 100)).toMatchObject({
      selector: "[data-testid=\"menu-delete\"]", tag: "li", role: "menuitem", name: "Delete project", box: { x: 12, y: 80, width: 212, height: 32 }, meaningful: true,
    })
    // What the capture holds outlives the menu.
    await page.evaluate(() => dispatchEvent(new Event("blur")))
    await expect(page.getByRole("menuitem", { name: "Delete project" })).toBeHidden()
    expect(bySelector(captured, "[data-testid=\"menu-delete\"]")).toBeDefined()
  })

  test("a gap answers its container; a clipped dropdown and a scrolled list show only what the page showed", async ({ page }) => {
    await page.getByTestId("list").evaluate((list) => { list.scrollTop = 30 })
    const captured = await capture(page)
    // Between the two cards: the cards' row.
    expect(elementAt(captured, 270, 180)).toMatchObject({ selector: "[data-testid=\"cards\"]", role: "group", name: "Cards", meaningful: true })
    // The card cuts its dropdown at its bottom edge (280 + 100).
    expect(bySelector(captured, "[data-testid=\"clipped-dropdown\"]")?.box).toEqual({ x: 60, y: 340, width: 200, height: 40 })
    // The list scrolled by 30: its first item shows its last 10 px, cut at the list's top.
    const first = captured.hits.elements.find((element) => element.text === "Item 1")
    expect(first?.box).toMatchObject({ x: 400, y: 280, height: 10 })
    expect(elementAt(captured, 900, 200)).toMatchObject({ tag: "canvas", selector: "[data-testid=\"chart\"]", meaningful: true })
  })

  test("a scrolled page answers boxes in the viewport and its scroll", async ({ page }) => {
    await page.evaluate(() => scrollTo(0, 700))
    const captured = await capture(page)
    expect(captured.scrollY).toBe(700)
    expect(elementAt(captured, 50, 310)).toMatchObject({ selector: "[data-testid=\"far\"]", box: { x: 40, y: 300, width: 160, height: 40 } })
    // The fixed nav stays on top of what scrolled under it.
    expect(elementAt(captured, 300, 20)?.tag).toBe("nav")
  })
})
