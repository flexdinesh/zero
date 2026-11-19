import type { FeedbackVisual } from "@zero/contracts"
import { ImageOffIcon } from "lucide-react"
import { useState } from "react"

import { fraction, thumbnail, type Fraction } from "./visual-geometry.ts"
import { attachmentURL } from "./visual-model.ts"

// Visual targets (decisions 0176, 0182): a Feedback row's crop thumbnail,
// and the screenshot with its rectangle marked, which the screen tab shows.

interface VisualProps {
  project: string
  feedbackId: string
  visual: FeedbackVisual
}

// thumbAspect is the row thumbnail's box, width over height (visual.css).
const thumbAspect = 3 / 2
const thumbMargin = 16

export function placed(at: Fraction) {
  return { left: `${at.left * 100}%`, top: `${at.top * 100}%`, width: `${at.width * 100}%`, height: `${at.height * 100}%` }
}

// VisualThumb is a row's crop of the rectangle, or a placeholder once the
// screenshot is gone.
export function VisualThumb({ feedbackId, project, visual }: VisualProps) {
  const [failed, setFailed] = useState(false)
  if (!visual.available || failed) {
    return <span className="visual-thumb" data-missing aria-hidden="true"><ImageOffIcon /></span>
  }
  const { width, height } = visual.attachment
  const view = thumbnail(visual.rect, { width, height }, thumbAspect, thumbMargin)
  return (
    <span className="visual-thumb" aria-hidden="true">
      <img src={attachmentURL(project, feedbackId, visual.attachment.id)} alt="" loading="lazy" decoding="async" draggable={false}
        style={{ width: `${view.width}%`, height: `${view.height}%`, left: `${view.left}%`, top: `${view.top}%` }}
        onError={() => setFailed(true)} />
    </span>
  )
}

interface ShotProps {
  src: string
  visual: FeedbackVisual
  imageRef?: { current: HTMLImageElement | null }
  onFailed?(): void
}

// VisualShot is the screenshot with the rest dimmed around the rectangle
// and the element's box dashed over it; its size comes from its container.
export function VisualShot({ imageRef, onFailed, src, visual }: ShotProps) {
  const size = { width: visual.attachment.width, height: visual.attachment.height }
  const box = visual.element?.box
  return (
    <span className="visual-shot" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
      <img ref={imageRef} className="visual-image" src={src} alt="" draggable={false} onError={onFailed} />
      <span className="visual-mark" style={placed(fraction(visual.rect, size))} aria-hidden="true" />
      {box && <span className="visual-element-box" style={placed(fraction(box, size))} aria-hidden="true" />}
    </span>
  )
}
