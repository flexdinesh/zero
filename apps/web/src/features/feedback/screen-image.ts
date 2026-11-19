import type { FeedbackRect } from "@zero/contracts"
import type { Size } from "./visual-geometry.ts"

// Browser image work for visual feedback (decision 0176): decoding a pasted
// or captured image, cropping and encoding PNG in a canvas, and copying an
// image to the clipboard. Pixels never leave the page except as the PNG a
// thread uploads.

// imageSize decodes blob's size; it rejects what the browser cannot decode.
export async function imageSize(blob: Blob): Promise<Size> {
  const bitmap = await createImageBitmap(blob)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The browser couldn't encode the image.")), "image/png")
  })
}

// cropPNG encodes rect of an image (the whole image without one) as PNG.
export async function cropPNG(source: Blob | HTMLImageElement, rect: FeedbackRect | null): Promise<Blob> {
  if (source instanceof HTMLImageElement) await source.decode()
  const bitmap = await createImageBitmap(source)
  try {
    const area = rect ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height }
    const canvas = document.createElement("canvas")
    canvas.width = area.width
    canvas.height = area.height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("The browser couldn't draw the image.")
    context.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height)
    return await encode(canvas)
  } finally {
    bitmap.close()
  }
}

// pngOf is blob as PNG: itself when it is one, else re-encoded.
export async function pngOf(blob: Blob): Promise<Blob> {
  return blob.type === "image/png" ? blob : cropPNG(blob, null)
}

// decodeBase64PNG reads the desktop app's base64 frame as a PNG blob.
export function decodeBase64PNG(base64: string): Blob | null {
  try {
    return new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], { type: "image/png" })
  } catch {
    return null
  }
}

// imageFile is the first image among files or clipboard items, or null.
export function imageFile(transfer: DataTransfer | null): File | null {
  if (!transfer) return null
  for (const file of Array.from(transfer.files)) if (file.type.startsWith("image/")) return file
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}

// hasImage reports a drag that carries an image file, before it drops.
export function hasImage(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && Array.from(transfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/")))
}

// copyImage writes png to the clipboard. It must start inside the click
// that asks for it, so the image arrives as a promise.
export function copyImage(png: Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return Promise.reject(new Error("clipboard unavailable"))
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
}
