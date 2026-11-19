import assert from "node:assert/strict"
import test from "node:test"

import type { ScreenHitElement, ScreenHits } from "../../lib/desktop-bridge.ts"
import { boxOf, hintOf, hitAt, hitLabel, meaningfulOf, parentOf, pickAt } from "./hit-map.ts"

// A 64 × 32 page in 8 px cells (8 × 4), parents first:
//   0 body         0,0 64×32
//   1 nav (flex)   0,0 64×16, a gap at x 24..32 between its items
//   2 button       0,0 24×16, meaningful
//   3 span         4,4 16×8, the button's label
//   4 a            32,0 32×16, meaningful
//   5 ul menu      8,8 32×24, over the canvas, its overflow cut at y 24
//   6 li item      8,16 32×8, meaningful (menuitem)
//   7 canvas       40,16 24×16, meaningful
//   8 div wrapper  40,16 24×16, the canvas's box again, inside it
const element = (parent: number, tag: string, box: ScreenHitElement["box"], extra: Partial<ScreenHitElement> = {}): ScreenHitElement =>
  ({ parent, tag, box, meaningful: false, ...extra })
const hits: ScreenHits = {
  step: 8, columns: 8, rows: 4,
  elements: [
    element(-1, "body", { x: 0, y: 0, width: 64, height: 32 }),
    element(0, "nav", { x: 0, y: 0, width: 64, height: 16 }),
    element(1, "button", { x: 0, y: 0, width: 24, height: 16 }, { meaningful: true, role: "button", name: "Save changes", selector: "#save" }),
    element(2, "span", { x: 4, y: 4, width: 16, height: 8 }, { text: "Save changes", selector: "#save > span" }),
    element(1, "a", { x: 32, y: 0, width: 32, height: 16 }, { meaningful: true, role: "link", text: "Docs" }),
    element(0, "ul", { x: 8, y: 8, width: 32, height: 16 }, { role: "list" }),
    element(5, "li", { x: 8, y: 16, width: 32, height: 8 }, { meaningful: true, role: "menuitem", name: "Delete project", selector: "[data-testid=\"delete\"]" }),
    element(0, "div", { x: 40, y: 16, width: 24, height: 16 }),
    element(7, "canvas", { x: 40, y: 16, width: 24, height: 16 }, { meaningful: true, selector: "canvas" }),
  ],
  // Topmost at each cell's center (4, 12, 20, … ; 4, 12, 20, 28).
  grid: [
    3, 3, 2, 1, 4, 4, 4, 4,
    3, 3, 2, 1, 4, 4, 4, 4,
    0, 6, 6, 6, 6, 8, 8, 8,
    0, 0, 0, 0, 0, 8, 8, 8,
  ],
}

test("hitAt answers the topmost element at a point, or its ancestor holding the point", () => {
  assert.equal(hitAt(hits, { x: 10, y: 8 }), 3)
  // The cell's topmost is the span, but the point is outside it: its button.
  assert.equal(hitAt(hits, { x: 2, y: 2 }), 2)
  // The menu item over the canvas region, where the menu covered it.
  assert.equal(hitAt(hits, { x: 20, y: 20 }), 6)
  assert.equal(hitAt(hits, { x: 50, y: 28 }), 8)
  assert.equal(hitAt(hits, { x: 100, y: 100 }), null)
  assert.equal(hitAt(hits, { x: Number.NaN, y: 0 }), null)
})

test("hitAt falls back to the smallest element holding a point its cell missed", () => {
  const empty: ScreenHits = { ...hits, grid: hits.grid.map(() => -1) }
  assert.equal(hitAt(empty, { x: 10, y: 8 }), 3)
  assert.equal(hitAt(empty, { x: 28, y: 4 }), 1)
})

test("a click means the nearest meaningful element; a gap selects its container", () => {
  // The label inside the button selects the button.
  assert.equal(pickAt(hits, { x: 10, y: 8 }), 2)
  assert.equal(pickAt(hits, { x: 20, y: 20 }), 6)
  // The gap between the nav's items: no meaningful ancestor, so the nav.
  assert.equal(pickAt(hits, { x: 28, y: 4 }), 1)
  assert.equal(meaningfulOf(hits, 0), 0)
  assert.equal(pickAt(hits, { x: 100, y: 100 }), null)
})

test("parentOf walks outward to a box that differs", () => {
  assert.equal(parentOf(hits, 3), 2)
  assert.equal(parentOf(hits, 2), 1)
  // The wrapper shows the canvas's box again: skipped.
  assert.equal(parentOf(hits, 8), 0)
  assert.equal(parentOf(hits, 0), null)
  assert.deepEqual(boxOf(hits, 6), { x: 8, y: 16, width: 32, height: 8 })
})

test("hintOf needs the page's tag and selector; labels read role and name", () => {
  assert.deepEqual(hintOf(hits, 6), {
    selector: "[data-testid=\"delete\"]", tag: "li", role: "menuitem", name: "Delete project", box: { x: 8, y: 16, width: 32, height: 8 },
  })
  assert.equal(hintOf(hits, 1), null)
  assert.equal(hintOf(hits, 99), null)
  assert.equal(hitLabel(hits.elements[6]), "menuitem \"Delete project\"")
  assert.equal(hitLabel(hits.elements[4]), "link \"Docs\"")
  assert.equal(hitLabel(hits.elements[7]), "div")
  assert.equal(hitLabel({ parent: -1, meaningful: false }), "element")
})
