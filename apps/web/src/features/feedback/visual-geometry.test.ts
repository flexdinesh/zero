import assert from "node:assert/strict"
import test from "node:test"

import {
  centeredRect, clipToBounds, contains, cssCenter, cssToImage, dragRect, expand, fraction, frameSize, imageToCSS, nudge, nudgeStep, regionClip,
  thumbnail, toImage,
} from "./visual-geometry.ts"

// testdata/feedback/visual/README.md: 1440×900 CSS px at 2× is a
// 2880×1800 frame; the kept clip is 1114,544 612×288; the button is image
// 96,96 420×96, CSS 605,320 210×48, document 605,1640 after 1320 px.
const viewport = { width: 1440, height: 900, deviceScaleFactor: 2 }
const clip = { x: 1114, y: 544, width: 612, height: 288 }
const buttonFrame = { x: 1210, y: 640, width: 420, height: 96 }
const buttonImage = { x: 96, y: 96, width: 420, height: 96 }
const buttonCSS = { x: 605, y: 320, width: 210, height: 48 }

test("the README's worked example maps between frame, image, CSS, and document pixels", () => {
  const frame = frameSize(viewport)
  assert.deepEqual(frame, { width: 2880, height: 1800 })
  assert.deepEqual(regionClip(buttonFrame, 2, frame), clip)
  assert.deepEqual(toImage(buttonFrame, clip), buttonImage)
  assert.deepEqual(imageToCSS(buttonImage, clip, 2), buttonCSS)
  const css = imageToCSS(buttonImage, clip, 2)
  assert.deepEqual({ x: css.x + 0, y: css.y + 1320 }, { x: 605, y: 1640 })
  assert.deepEqual(cssToImage(buttonCSS, clip, 2, { width: 612, height: 288 }), buttonImage)
  assert.deepEqual(cssCenter(buttonFrame, 2), { x: 710, y: 344 })
  // Without a clip the image is the frame.
  assert.deepEqual(toImage(buttonFrame, null), buttonFrame)
  assert.deepEqual(cssToImage(buttonCSS, null, 2, frame), buttonFrame)
})

test("frames round fractional scales", () => {
  assert.deepEqual(frameSize({ width: 1001, height: 667, deviceScaleFactor: 1.25 }), { width: 1251, height: 834 })
})

test("drags normalize either corner first and round outward inside the image", () => {
  const image = { width: 100, height: 50 }
  assert.deepEqual(dragRect({ x: 80.4, y: 40.2 }, { x: 10.6, y: 5.5 }, image), { x: 10, y: 5, width: 71, height: 36 })
  assert.deepEqual(dragRect({ x: -20, y: -5 }, { x: 150, y: 70 }, image), { x: 0, y: 0, width: 100, height: 50 })
  // A zero-area drag inside one pixel still covers it once rounded outward.
  assert.deepEqual(dragRect({ x: 3.2, y: 3.2 }, { x: 3.4, y: 3.9 }, image), { x: 3, y: 3, width: 1, height: 1 })
  assert.equal(dragRect({ x: 3, y: 3 }, { x: 3, y: 9 }, image), null)
  assert.equal(dragRect({ x: 120, y: 3 }, { x: 140, y: 9 }, image), null)
})

test("rectangles clip, expand, and contain points within bounds", () => {
  assert.equal(clipToBounds({ x: 10, y: 10, width: 5, height: 5 }, { width: 10, height: 10 }), null)
  assert.deepEqual(expand({ x: 2, y: 2, width: 4, height: 4 }, 3, { width: 8, height: 20 }), { x: 0, y: 0, width: 8, height: 9 })
  assert.equal(contains(buttonImage, { x: 96, y: 192 }), true)
  assert.equal(contains(buttonImage, { x: 95, y: 100 }), false)
})

test("the keyboard moves and resizes the rectangle inside the image", () => {
  const image = { width: 400, height: 200 }
  const start = centeredRect(image)
  assert.deepEqual(start, { x: 150, y: 75, width: 100, height: 50 })
  assert.equal(nudgeStep(image), 4)
  assert.equal(nudgeStep({ width: 20, height: 10 }), 1)
  assert.deepEqual(nudge(start, 4, -4, false, image), { x: 154, y: 71, width: 100, height: 50 })
  assert.deepEqual(nudge(start, 1000, 1000, false, image), { x: 300, y: 150, width: 100, height: 50 })
  assert.deepEqual(nudge(start, -1000, 8, true, image), { x: 150, y: 75, width: 1, height: 58 })
  assert.deepEqual(nudge(start, 1000, 0, true, image), { x: 150, y: 75, width: 250, height: 50 })
})

test("fractions place rectangles for CSS percentages", () => {
  assert.deepEqual(fraction({ x: 50, y: 25, width: 100, height: 50 }, { width: 200, height: 100 }), { left: 0.25, top: 0.25, width: 0.5, height: 0.5 })
  assert.deepEqual(fraction({ x: 150, y: 0, width: 100, height: 200 }, { width: 200, height: 100 }), { left: 0.75, top: 0, width: 0.25, height: 1 })
  assert.deepEqual(fraction(buttonImage, { width: 0, height: 0 }), { left: 0, top: 0, width: 0, height: 0 })
})

test("thumbnails keep their box's aspect, center on the rectangle, and stay inside the image", () => {
  // 3:2 box around a 420×96 button with a 24 px margin: 468 wide, 312 tall.
  const view = thumbnail(buttonImage, { width: 612, height: 288 }, 1.5, 24)
  // Taller than the image: the view is the image's height, 432 wide.
  assert.ok(Math.abs(view.height - 100) < 1e-9)
  assert.ok(Math.abs(view.width - (612 / 432) * 100) < 1e-9)
  assert.ok(Math.abs(view.top) < 1e-9)
  // Centered on the button (306 - 216 = 90), within the image.
  assert.ok(Math.abs(view.left - (-90 / 432) * 100) < 1e-9)
  const corner = thumbnail({ x: 0, y: 0, width: 10, height: 10 }, { width: 1000, height: 1000 }, 1, 5)
  assert.deepEqual(corner, { width: 5000, height: 5000, left: 0, top: 0 })
})
