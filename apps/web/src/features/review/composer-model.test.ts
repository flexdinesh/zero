import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { readComposerCapture, type ComposerCapture } from "../../lib/desktop-bridge.ts"
import { canWalk, capturePlan, composerKey, pickLabel, pickOrigin, sentFacts, targetLabel } from "./composer-model.ts"

// The pick behind testdata/feedback/visual/draft-page.json: the button at
// CSS 605,320 210×48 of a 1440×900 viewport at 2×, scrolled 1320, dark.
const picked = {
  project: "/home/user/markdown",
  png: "iVBORw0KGgo=",
  page: {
    url: "http://admin:hunter2@localhost:5173/settings?tab=billing&session=8f2c1e9a7b#plan", title: "Settings · Acme",
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, scroll: { x: 0, y: 1320 }, colorScheme: "dark",
  },
  rect: { x: 605, y: 320, width: 210, height: 48 },
  kind: "element",
  element: {
    tag: "button", box: { x: 605, y: 320, width: 210, height: 48 },
    selector: "main form > button[data-testid=\"save\"]", role: "button", name: "Save changes", text: "Save changes",
    path: "main › form.settings › div.actions › button.btn.btn-primary", classes: "btn btn-primary",
    attributes: [{ name: "type", value: "submit" }, { name: "data-testid", value: "save" }],
    styles: [
      { name: "color", value: "rgb(255, 255, 255)" }, { name: "background-color", value: "rgb(50, 93, 200)" },
      { name: "font-size", value: "14px" }, { name: "padding", value: "8px 16px" },
    ],
    component: "SettingsForm › Card › Button", source: "src/settings/SettingsForm.tsx:42", nearby: "Cancel",
  },
  canWalkUp: true,
  canWalkDown: false,
}

function capture(change: Record<string, unknown> = {}): ComposerCapture {
  const read = readComposerCapture({ ...picked, ...change })
  assert.ok(read)
  return read
}

test("the composer names an element by its role and name, and a region by its size", () => {
  assert.equal(pickLabel(capture()), "button \"Save changes\"")
  assert.equal(pickOrigin(capture()), "SettingsForm › Card › Button · src/settings/SettingsForm.tsx:42")
  const region = capture({ kind: "region", rect: { x: 40, y: 60, width: 260, height: 80 } })
  assert.equal(pickLabel(region), "Region 260 × 80")
  assert.equal(pickLabel(capture({ kind: "region", element: null })), "Region 210 × 48")
  assert.equal(pickOrigin(capture({ kind: "region", element: null })), "")
  assert.equal(pickOrigin(capture({ element: { tag: "p", box: picked.rect, source: "src/a.tsx:3" } })), "src/a.tsx:3")
})

test("only an element walks, and only where the page says there is one", () => {
  assert.equal(canWalk(capture(), "parent"), true)
  assert.equal(canWalk(capture(), "child"), false)
  assert.equal(canWalk(capture({ canWalkDown: true }), "child"), true)
  assert.equal(canWalk(capture({ kind: "region", canWalkUp: true, canWalkDown: true }), "parent"), false)
  assert.equal(canWalk(capture({ kind: "region", canWalkUp: true, canWalkDown: true }), "child"), false)
})

test("What's sent lists every fact the comment carries, as the page gave it", () => {
  assert.deepEqual(sentFacts(capture()), [
    { label: "Screenshot", values: ["The selection and 48 px around it"] },
    { label: "Page", values: [picked.page.url] },
    { label: "Title", values: ["Settings · Acme"] },
    { label: "Viewport", values: ["1440 × 900 at 2×, dark"] },
    { label: "Rectangle", values: ["605, 320 · 210 × 48"] },
    { label: "Element", values: ["button \"Save changes\""] },
    { label: "Selector", values: ["main form > button[data-testid=\"save\"]"] },
    { label: "Path", values: ["main › form.settings › div.actions › button.btn.btn-primary"] },
    { label: "Component", values: ["SettingsForm › Card › Button"] },
    { label: "Source", values: ["src/settings/SettingsForm.tsx:42"] },
    { label: "Classes", values: ["btn btn-primary"] },
    { label: "Attributes", values: ["type=submit", "data-testid=save"] },
    { label: "Styles", values: ["color: rgb(255, 255, 255)", "background-color: rgb(50, 93, 200)", "font-size: 14px", "padding: 8px 16px"] },
    { label: "Nearby text", values: ["Cancel"] },
  ])
  // A region with no element carries the page and the rectangle only.
  const region = capture({ kind: "region", element: null, page: { ...picked.page, title: "", colorScheme: "light" } })
  assert.deepEqual(sentFacts(region).map((fact) => fact.label), ["Screenshot", "Page", "Viewport", "Rectangle"])
  assert.deepEqual(sentFacts(region)[2]?.values, ["1440 × 900 at 2×, light"])
  const selected = capture({ element: { tag: "p", box: picked.rect, selectedText: "Billing email" } })
  assert.deepEqual(sentFacts(selected).slice(5), [{ label: "Element", values: ["p"] }, { label: "Selected text", values: ["Billing email"] }])
})

test("a pick becomes the visual target the server stores (draft-page.json)", async () => {
  const text = await readFile(new URL("../../../../../testdata/feedback/visual/draft-page.json", import.meta.url), "utf8")
  const draft: unknown = JSON.parse(text)
  assert.ok(typeof draft === "object" && draft !== null && "visual" in draft && typeof draft.visual === "object" && draft.visual !== null)
  const plan = capturePlan(capture(), { width: 2880, height: 1800 })
  assert.ok(plan)
  // The frame keeps the button plus 48 CSS px: 612×288 at 1114,544.
  assert.deepEqual(plan.clip, { x: 1114, y: 544, width: 612, height: 288 })
  assert.deepEqual(plan.image, { width: 612, height: 288 })
  assert.deepEqual({ attachment: "at-7hq2mx4kpa", rect: plan.rect, page: plan.page, element: plan.element }, draft.visual)
})

test("a region sends its rectangle, and the element at its center when the page named one", () => {
  const region = capture({ kind: "region", rect: { x: 0, y: 860, width: 60, height: 40 }, element: null })
  const plan = capturePlan(region, { width: 2880, height: 1800 })
  // The margin stops at the frame's edges.
  assert.deepEqual(plan?.clip, { x: 0, y: 1624, width: 216, height: 176 })
  assert.deepEqual(plan?.rect, { x: 0, y: 96, width: 120, height: 80 })
  assert.equal(plan?.element, undefined)
  assert.equal(plan?.page?.colorScheme, "dark")
  // An element without a selector still goes.
  const bare = capturePlan(capture({ element: { tag: "div", box: picked.rect } }), { width: 2880, height: 1800 })
  assert.deepEqual(bare?.element, { tag: "div", box: { x: 96, y: 96, width: 420, height: 96 } })
  // A selection outside the frame plans nothing.
  assert.equal(capturePlan(capture({ kind: "region", rect: { x: 2000, y: 0, width: 10, height: 10 }, element: null }), { width: 2880, height: 1800 }), null)
})

test("comments go to the folder and its branch", () => {
  assert.equal(targetLabel("/home/user/acme-web", "feature/billing"), "acme-web · feature/billing")
  assert.equal(targetLabel("/home/user/acme-web/", ""), "acme-web")
})

test("Escape closes, Ctrl or Cmd+Enter sends, Alt+arrows walk", () => {
  const press = (key: string, modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean } = {}) =>
    composerKey({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers })
  assert.deepEqual(press("Escape"), { kind: "close" })
  assert.deepEqual(press("Enter", { ctrlKey: true }), { kind: "send" })
  assert.deepEqual(press("Enter", { metaKey: true }), { kind: "send" })
  assert.deepEqual(press("ArrowUp", { altKey: true }), { kind: "walk", direction: "parent" })
  assert.deepEqual(press("ArrowDown", { altKey: true }), { kind: "walk", direction: "child" })
  for (const none of [press("Enter"), press("ArrowUp"), press("a"), press("Enter", { ctrlKey: true, isComposing: true }), press("ArrowUp", { altKey: true, shiftKey: true })]) {
    assert.equal(none, null)
  }
})
