import type { FeedbackVisual } from "@zero/contracts"
import { AppWindowIcon, ArrowUpRightIcon, CheckIcon, ClipboardCopyIcon, ImageOffIcon, Maximize2Icon, XIcon } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { Button } from "../../components/ui/button.tsx"
import { DialogShell } from "../../components/ui/dialog-shell.tsx"
import { IconButton } from "../../components/ui/icon-button.tsx"
import { SegmentedControl, SegmentedItem } from "../../components/ui/segmented-control.tsx"
import { ViewHeader } from "../../components/ui/view-header.tsx"
import { copyImage, cropPNG } from "./screen-image.ts"
import { copyMargin, expand, fraction, thumbnail, type Fraction } from "./visual-geometry.ts"
import { attachmentURL, canOpenPage, elementLabel, pageAddress, pageWhere, visualPlace } from "./visual-model.ts"

// Visual targets in the Feedback view (decision 0176): a row's crop
// thumbnail, and a thread's screenshot with its rectangle drawn, zoomable,
// with Copy crop and Open URL.

interface VisualProps {
  project: string
  feedbackId: string
  visual: FeedbackVisual
}

// thumbAspect is the row thumbnail's box, width over height (feedback.css).
const thumbAspect = 3 / 2
const thumbMargin = 16

function placed(at: Fraction) {
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

// Shot is the screenshot with the rectangle drawn and the element's box
// dashed; its size comes from its container.
function Shot({ imageRef, onFailed, src, visual }: ShotProps) {
  const size = { width: visual.attachment.width, height: visual.attachment.height }
  const box = visual.element?.box
  return (
    <span className="visual-shot" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
      <img ref={imageRef} className="visual-image" src={src} alt="" draggable={false} onError={onFailed} />
      {box && <span className="visual-element-box" style={placed(fraction(box, size))} aria-hidden="true" />}
      <span className="visual-mark" style={placed(fraction(visual.rect, size))} aria-hidden="true" />
    </span>
  )
}

// VisualTarget leads a visual thread's conversation: the screenshot, the
// page and element it names, and its actions.
export function VisualTarget({ feedbackId, number, project, visual }: VisualProps & { number: number }) {
  const image = useRef<HTMLImageElement>(null)
  const [failed, setFailed] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle")
  useEffect(() => {
    if (copy === "idle") return
    const timer = window.setTimeout(() => setCopy("idle"), 1600)
    return () => window.clearTimeout(timer)
  }, [copy])
  const src = attachmentURL(project, feedbackId, visual.attachment.id)
  const { page, element } = visual
  const shown = visual.available && !failed
  const where = page ? pageWhere(page) : ""

  const copyCrop = () => {
    const shot = image.current
    if (!shot) return
    const area = expand(visual.rect, copyMargin, { width: visual.attachment.width, height: visual.attachment.height })
    copyImage(cropPNG(shot, area)).then(() => setCopy("copied"), () => setCopy("failed"))
  }

  return (
    <div className="visual-target">
      {shown
        ? <Button variant="plain" size="inline" className="visual-frame" aria-label={`Zoom the screenshot of thread ${number}`} onClick={() => setZoomed(true)}>
          <Shot src={src} visual={visual} imageRef={image} onFailed={() => setFailed(true)} />
        </Button>
        : <p className="visual-frame visual-missing">
          <ImageOffIcon aria-hidden="true" />
          {failed ? "The screenshot couldn't be read." : "The screenshot was removed to stay within the storage budget. The thread stays."}
        </p>}
      {page && (
        <p className="visual-line">
          <AppWindowIcon className="visual-line-icon" aria-hidden="true" />
          <span className="visual-url" title={page.url}>{pageAddress(page.url)}</span>
          {where && <span className="visual-where">{where}</span>}
        </p>
      )}
      {element && (
        <p className="visual-line visual-element" title={element.selector}>
          <span className="visual-element-name">{elementLabel(element)}</span>
          <span className="visual-where">{element.selector}</span>
        </p>
      )}
      {(shown || (page && canOpenPage(page))) && (
        <div className="visual-actions">
          {shown && <>
            <Button size="sm" variant="outline" onClick={() => setZoomed(true)}><Maximize2Icon aria-hidden="true" />Zoom</Button>
            <Button size="sm" variant="outline" data-status={copy} onClick={copyCrop}>
              {copy === "copied" ? <CheckIcon aria-hidden="true" /> : copy === "failed" ? <XIcon aria-hidden="true" /> : <ClipboardCopyIcon aria-hidden="true" />}
              {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy crop"}
            </Button>
            <span className="visually-hidden" role="status">{copy === "copied" ? "Crop copied" : copy === "failed" ? "Copy failed" : ""}</span>
          </>}
          {page && canOpenPage(page) && (
            <Button size="sm" variant="outline" onClick={() => window.open(page.url, "_blank", "noopener,noreferrer")}>
              Open URL<ArrowUpRightIcon aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      {zoomed && shown && <VisualZoom src={src} visual={visual} title={`Thread ${number} · ${visualPlace(visual)}`} onClose={() => setZoomed(false)} />}
    </div>
  )
}

type Scale = "fit" | "actual"

// VisualZoom shows the screenshot large: fitted to the window, or at the
// size the page was seen (image pixels over the device scale factor),
// scrolled to the rectangle.
function VisualZoom({ onClose, src, title, visual }: { src: string; visual: FeedbackVisual; title: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<Scale>("fit")
  useLayoutEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  useEffect(() => {
    const area = scroller.current
    if (scale !== "actual" || !area) return
    const target = area.querySelector(".visual-mark")
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "center", inline: "center" })
  }, [scale])
  const dsf = visual.page?.viewport.deviceScaleFactor ?? 1
  const size = { width: visual.attachment.width / dsf, height: visual.attachment.height / dsf }
  const { width, height } = visual.attachment
  return (
    <DialogShell ref={dialog} variant="viewer" className="visual-zoom" aria-label={`Screenshot: ${title}`}
      onClose={onClose}
      onClick={(event) => { if (event.target === dialog.current) dialog.current.close() }}>
      <ViewHeader variant="dialog" title={title} titleClassName="visual-zoom-title" actions={<>
        <SegmentedControl size="sm" aria-label="Zoom">
          <SegmentedItem pressed={scale === "fit"} onClick={() => setScale("fit")}>Fit</SegmentedItem>
          <SegmentedItem pressed={scale === "actual"} onClick={() => setScale("actual")}>Actual size</SegmentedItem>
        </SegmentedControl>
        <IconButton label="Close" icon={<XIcon aria-hidden="true" />} onClick={() => dialog.current?.close()} />
      </>} />
      <div ref={scroller} className="visual-zoom-stage" data-scale={scale} tabIndex={0} aria-label={`Screenshot, ${width} by ${height} pixels`}>
        <div className="visual-zoom-frame"
          style={scale === "fit"
            ? { width: `min(100cqw, calc(100cqh * ${width} / ${height}))` }
            : { width: `${size.width}px`, height: `${size.height}px` }}>
          <Shot src={src} visual={visual} />
        </div>
      </div>
    </DialogShell>
  )
}
