import type { FeedbackRect } from "@zero/contracts"

// Pure geometry of visual feedback targets (decision 0176). Three spaces:
// CSS pixels of the captured page's viewport; frame pixels of the captured
// PNG, CSS × deviceScaleFactor; and image pixels of the uploaded image,
// frame minus the clip's origin. Every rectangle a draft sends is in whole
// image pixels, at least 1 × 1, wholly inside the image.

export interface Size {
  width: number
  height: number
}

// regionMargin is the margin a region attachment keeps around the
// rectangle, in CSS pixels (decision 0176, U2).
export const regionMargin = 48

// copyMargin is Copy crop's margin in image pixels, as `zero feedback
// attachment --crop` defaults to.
export const copyMargin = 24

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

// clipToBounds keeps the part of rect inside bounds, rounded outward to
// whole pixels; null when nothing of it is inside.
export function clipToBounds(rect: FeedbackRect, bounds: Size): FeedbackRect | null {
  const left = clamp(Math.floor(rect.x), 0, bounds.width)
  const top = clamp(Math.floor(rect.y), 0, bounds.height)
  const right = clamp(Math.ceil(rect.x + rect.width), 0, bounds.width)
  const bottom = clamp(Math.ceil(rect.y + rect.height), 0, bounds.height)
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// expand grows rect by margin on every side, kept inside bounds.
export function expand(rect: FeedbackRect, margin: number, bounds: Size): FeedbackRect {
  return clipToBounds({ x: rect.x - margin, y: rect.y - margin, width: rect.width + 2 * margin, height: rect.height + 2 * margin }, bounds) ?? rect
}

// frameSize is a viewport's frame: round(width × dsf) by round(height × dsf).
export function frameSize(viewport: Size & { deviceScaleFactor: number }): Size {
  return { width: Math.round(viewport.width * viewport.deviceScaleFactor), height: Math.round(viewport.height * viewport.deviceScaleFactor) }
}

// regionClip is the part of the frame a region attachment keeps: the
// rectangle (frame pixels) plus the margin in CSS pixels at the device
// scale factor, clamped to the frame.
export function regionClip(rect: FeedbackRect, deviceScaleFactor: number, frame: Size, margin = regionMargin): FeedbackRect {
  return expand(rect, Math.round(margin * deviceScaleFactor), frame)
}

// toImage moves a frame rectangle into the image a clip keeps (the whole
// frame without one).
export function toImage(rect: FeedbackRect, clip: FeedbackRect | null): FeedbackRect {
  return clip ? { ...rect, x: rect.x - clip.x, y: rect.y - clip.y } : rect
}

// imageToCSS maps an image rectangle to CSS pixels of the viewport: frame
// position = image position + clip origin; CSS = frame ÷ dsf.
export function imageToCSS(rect: FeedbackRect, clip: FeedbackRect | null, deviceScaleFactor: number): FeedbackRect {
  const frame = clip ? { ...rect, x: rect.x + clip.x, y: rect.y + clip.y } : rect
  return {
    x: frame.x / deviceScaleFactor,
    y: frame.y / deviceScaleFactor,
    width: frame.width / deviceScaleFactor,
    height: frame.height / deviceScaleFactor,
  }
}

// cssToImage maps a CSS rectangle of the viewport (an element's box) into
// the image: frame = CSS × dsf, minus the clip origin, rounded outward and
// clipped to the image; null when it falls outside.
export function cssToImage(box: FeedbackRect, clip: FeedbackRect | null, deviceScaleFactor: number, image: Size): FeedbackRect | null {
  const frame = {
    x: box.x * deviceScaleFactor,
    y: box.y * deviceScaleFactor,
    width: box.width * deviceScaleFactor,
    height: box.height * deviceScaleFactor,
  }
  // Rounding happens once, after moving into the image.
  return clipToBounds(clip ? { ...frame, x: frame.x - clip.x, y: frame.y - clip.y } : frame, image)
}

// Fraction is a rectangle as fractions of an image, for CSS percentages.
export interface Fraction {
  left: number
  top: number
  width: number
  height: number
}

// fraction places rect on an image as fractions of its size.
export function fraction(rect: FeedbackRect, image: Size): Fraction {
  if (image.width < 1 || image.height < 1) return { left: 0, top: 0, width: 0, height: 0 }
  const left = clamp(rect.x / image.width, 0, 1)
  const top = clamp(rect.y / image.height, 0, 1)
  return {
    left,
    top,
    width: clamp(rect.width / image.width, 0, 1 - left),
    height: clamp(rect.height / image.height, 0, 1 - top),
  }
}

// Thumbnail is how an image shows inside a fixed thumbnail box: its size
// and offset as percentages of the box.
export interface Thumbnail {
  width: number
  height: number
  left: number
  top: number
}

// thumbnail frames rect plus margin in a box of aspect (width ÷ height):
// the view keeps the box's aspect, holds the rectangle when the image
// allows, centers on it, and stays inside the image.
export function thumbnail(rect: FeedbackRect, image: Size, aspect: number, margin: number): Thumbnail {
  let width = rect.width + 2 * margin
  let height = rect.height + 2 * margin
  if (width / height < aspect) width = height * aspect
  else height = width / aspect
  if (width > image.width) {
    width = image.width
    height = width / aspect
  }
  if (height > image.height) {
    height = image.height
    width = height * aspect
  }
  const x = clamp(rect.x + rect.width / 2 - width / 2, 0, Math.max(0, image.width - width))
  const y = clamp(rect.y + rect.height / 2 - height / 2, 0, Math.max(0, image.height - height))
  return { width: (image.width / width) * 100, height: (image.height / height) * 100, left: (0 - x / width) * 100, top: (0 - y / height) * 100 }
}
