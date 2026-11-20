import assert from "node:assert/strict"
import test from "node:test"

import { openOverlayLayer, overlayOpen } from "./overlay-layers.ts"

test("a layer is open until every layer counted in has been released", () => {
  assert.equal(overlayOpen(), false)
  const dialog = openOverlayLayer()
  const menu = openOverlayLayer()
  assert.equal(overlayOpen(), true)
  dialog()
  assert.equal(overlayOpen(), true)
  menu()
  assert.equal(overlayOpen(), false)
})

test("releasing a layer twice counts it out once", () => {
  const first = openOverlayLayer()
  const second = openOverlayLayer()
  first()
  first()
  assert.equal(overlayOpen(), true)
  second()
  assert.equal(overlayOpen(), false)
})
