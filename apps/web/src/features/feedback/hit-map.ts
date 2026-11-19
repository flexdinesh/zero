import type { FeedbackRect } from "@zero/contracts"

import type { ScreenHitElement, ScreenHits } from "../../lib/desktop-bridge.ts"
import type { Point } from "./visual-geometry.ts"
import type { ScreenHint } from "./visual-model.ts"

// The hit map is what a capture recorded of the page with its frame
// (decision 0180): which element was topmost where, and each element's
// visible box. The composer selects against it, never against the live page,
// which may have closed a menu or scrolled since. Points and boxes are CSS
// pixels of the captured viewport.

function holds(box: FeedbackRect | undefined, point: Point): box is FeedbackRect {
  return box !== undefined && point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height
}

function area(box: FeedbackRect): number {
  return box.width * box.height
}

// hitAt is the element the page showed at point: the topmost element at the
// nearest grid cell, or the nearest of its ancestors whose box holds the
// point; failing that, the smallest element whose box holds it. null outside
// every element.
export function hitAt(hits: ScreenHits, point: Point): number | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  const column = Math.min(hits.columns - 1, Math.max(0, Math.floor(point.x / hits.step)))
  const row = Math.min(hits.rows - 1, Math.max(0, Math.floor(point.y / hits.step)))
  const cell = hits.grid[row * hits.columns + column] ?? -1
  for (let index = cell; index >= 0; index = hits.elements[index]?.parent ?? -1) {
    if (holds(hits.elements[index]?.box, point)) return index
  }
  let best: number | null = null
  let bestArea = Infinity
  for (const [index, element] of hits.elements.entries()) {
    if (holds(element.box, point) && area(element.box) < bestArea) {
      best = index
      bestArea = area(element.box)
    }
  }
  return best
}

// meaningfulOf is the element a click at index means: the nearest of it and
// its ancestors that is meaningful (a role, replaced content, a test id, an
// id, a click handler, or a tab stop) and showed something; the element
// itself when none is.
export function meaningfulOf(hits: ScreenHits, index: number): number {
  for (let at = index; at >= 0; at = hits.elements[at]?.parent ?? -1) {
    const element = hits.elements[at]
    if (element?.meaningful && element.box) return at
  }
  return index
}

// pickAt is the element a click at point selects, or null.
export function pickAt(hits: ScreenHits, point: Point): number | null {
  const hit = hitAt(hits, point)
  return hit === null ? null : meaningfulOf(hits, hit)
}

function sameBox(a: FeedbackRect, b: FeedbackRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

// parentOf is the nearest ancestor of index that shows a different box, so
// each step outward changes what is selected; null at the top.
export function parentOf(hits: ScreenHits, index: number): number | null {
  const box = hits.elements[index]?.box
  for (let at = hits.elements[index]?.parent ?? -1; at >= 0; at = hits.elements[at]?.parent ?? -1) {
    const outer = hits.elements[at]?.box
    if (outer && (!box || !sameBox(box, outer))) return at
  }
  return null
}

// boxOf is the box index showed, or null.
export function boxOf(hits: ScreenHits, index: number): FeedbackRect | null {
  return hits.elements[index]?.box ?? null
}

// hintOf is index's metadata as an element hint, or null when the page did
// not describe it: a hint needs a tag and a selector (decision 0176).
export function hintOf(hits: ScreenHits, index: number): ScreenHint | null {
  const element = hits.elements[index]
  if (!element?.tag || !element.selector) return null
  const hint: ScreenHint = { selector: element.selector, tag: element.tag }
  if (element.role) hint.role = element.role
  if (element.name) hint.name = element.name
  if (element.text) hint.text = element.text
  if (element.box) hint.box = element.box
  return hint
}

// hitLabel names an element for the readout: its role or tag and its name
// or text, as the page described it.
export function hitLabel(element: ScreenHitElement | undefined): string {
  if (!element) return ""
  const kind = element.role || element.tag || "element"
  const name = element.name || element.text
  return name ? `${kind} "${name}"` : kind
}
