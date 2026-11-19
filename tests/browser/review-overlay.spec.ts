import { fileURLToPath } from "node:url"

import { expect, test, type Page } from "@playwright/test"

// Every guest page in the desktop app runs guest.js before its own scripts
// (decisions 0175, 0176, 0177); the app reads it through
// window.__zeroReview. Here a stand-in page plays the developer's app.

const guestScript = fileURLToPath(new URL("../../apps/desktop/internal/review/guest.js", import.meta.url))
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

interface Element {
  selector: string
  tag: string
  role?: string
  name?: string
  text?: string
  box?: { x: number; y: number; width: number; height: number }
}

async function elementAt(page: Page, x: number, y: number): Promise<Element | null> {
  const raw = await page.evaluate(([px, py]) => Reflect.get(window, "__zeroReview").elementAt(px, py), [x, y])
  expect(typeof raw).toBe("string")
  return JSON.parse(String(raw))
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 })
  await page.route("http://review.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }))
  await page.addInitScript({ path: guestScript })
  await page.goto(pageURL)
})

test("facts are the page's title, viewport, pixel ratio, and scroll", async ({ page }) => {
  await page.evaluate(() => scrollTo(0, 120))
  const facts = JSON.parse(String(await page.evaluate(() => Reflect.get(window, "__zeroReview").facts())))
  expect(facts).toEqual({ title: "Settings · Acme", width: 1000, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 120 })
})

test("elementAt names the element at a point by a selector that finds it alone", async ({ page }) => {
  // The button's padding, beside its text.
  expect(await elementAt(page, 104, 204)).toEqual({
    selector: "[data-testid=\"save\"]",
    tag: "button",
    role: "button",
    name: "Save changes",
    text: "Save changes",
    box: { x: 100, y: 200, width: 120, height: 40 },
  })
  const billing = await elementAt(page, 320, 330)
  expect(billing?.tag).toBe("li")
  expect(billing?.role).toBe("listitem")
  expect(billing?.text).toBe("Billing")
  expect(await page.evaluate((selector) => document.querySelectorAll(selector).length, billing?.selector ?? "")).toBe(1)
  // Frames are opaque; points outside the viewport are nothing.
  expect(await elementAt(page, 560, 320)).toBeNull()
  expect(await elementAt(page, 1200, 10)).toBeNull()
})

test("elementAt never reads field values or the text of fields, editable regions, passwords, or cards", async ({ page }) => {
  const answers = await Promise.all([[305, 210], [420, 210], [560, 220], [760, 220], [160, 320], [710, 310]].map(([x, y]) => elementAt(page, x, y)))
  const raw = JSON.stringify(answers)
  for (const secret of ["hunter2", "secret notes", "draft text", "4111111111111111", "typed by user"]) {
    expect(raw).not.toContain(secret)
  }
  const [label, password, notes, editable, card, paragraph] = answers
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
  const facts = JSON.parse(String(await page.evaluate(() => Reflect.get(window, "__zeroReview").facts())))
  expect(facts.title).toBe("Settings · Acme")
  expect((await elementAt(page, 104, 204))?.tag).toBe("button")
})

test("the page cannot replace the script's API", async ({ page }) => {
  const replaced = await page.evaluate(() => {
    try {
      Object.defineProperty(window, "__zeroReview", { value: { facts: () => "{}" } })
      return true
    } catch {
      return false
    }
  })
  expect(replaced).toBe(false)
})
