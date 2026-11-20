import assert from "node:assert/strict"
import test from "node:test"

import { clipToBounds, cssToImage, expand, fraction, frameSize, imageToCSS, regionClip, thumbnail, toImage } from "./visual-geometry.ts"

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
  // Without a clip the image is the frame.
  assert.deepEqual(toImage(buttonFrame, null), buttonFrame)
  assert.deepEqual(cssToImage(buttonCSS, null, 2, frame), buttonFrame)
})

test("frames round fractional scales", () => {
  assert.deepEqual(frameSize({ width: 1001, height: 667, deviceScaleFactor: 1.25 }), { width: 1251, height: 834 })
})

test("rectangles clip and expand within bounds, rounded outward", () => {
  assert.equal(clipToBounds({ x: 10, y: 10, width: 5, height: 5 }, { width: 10, height: 10 }), null)
  assert.deepEqual(clipToBounds({ x: 10.6, y: 5.5, width: 69.8, height: 34.7 }, { width: 100, height: 50 }), { x: 10, y: 5, width: 71, height: 36 })
  assert.deepEqual(expand({ x: 2, y: 2, width: 4, height: 4 }, 3, { width: 8, height: 20 }), { x: 0, y: 0, width: 8, height: 9 })
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
