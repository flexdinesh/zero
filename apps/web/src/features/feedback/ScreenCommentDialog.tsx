import type { FeedbackRect, FeedbackThread } from "@zero/contracts"
import { ImageIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from "react"

import { Button } from "../../components/ui/button.tsx"
import { DialogShell } from "../../components/ui/dialog-shell.tsx"
import { IconButton } from "../../components/ui/icon-button.tsx"
import { Kbd } from "../../components/ui/kbd.tsx"
import { Notice, StatusMessage } from "../../components/ui/notice.tsx"
import { SegmentedControl, SegmentedItem } from "../../components/ui/segmented-control.tsx"
import { TextArea, TextField } from "../../components/ui/text-field.tsx"
import { ViewHeader } from "../../components/ui/view-header.tsx"
import type { ScreenHits } from "../../lib/desktop-bridge.ts"
import { CommentTarget, type CommentTargetProps } from "./CommentTarget.tsx"
import { isSendKey, sendKeys } from "./FeedbackThreadZone.tsx"
import { boxOf, hintOf, hitLabel, parentOf, pickAt } from "./hit-map.ts"
import { cropPNG, hasImage, imageFile, imageSize, pngOf } from "./screen-image.ts"
import type { FeedbackActions } from "./use-feedback.ts"
import { pastedSource, type ScreenSource } from "./use-screen-comment.ts"
import {
  centeredRect, cssCenter, cssToImage, dragRect, fraction, nudge, nudgeStep, regionMargin, type Fraction, type Point, type Size,
} from "./visual-geometry.ts"
import { elementLabel, pageURLProblem, planVisual, type AttachMode, type ScreenHint } from "./visual-model.ts"

const mac = typeof navigator !== "undefined" && navigator.platform.includes("Mac")
const pasteKey = mac ? "⌘" : "Ctrl"
const altKey = mac ? "⌥" : "Alt"

// A press that moves less than this many screen pixels is a click, not a
// drag: with a hit map it selects the element under it (decision 0180).
const dragThreshold = 4

// Selection is what the comment points at, in frame pixels: an element of
// the hit map (its visible box), or a free region. trail holds the
// elements Alt+Up walked out of, for Alt+Down to walk back.
interface Selection {
  rect: FeedbackRect
  element: number | null
  trail: readonly number[]
}

// selectElement selects a hit map element by its visible box, or null when
// it showed nothing inside the image.
function selectElement(hits: ScreenHits, index: number, dsf: number, image: Size, trail: readonly number[] = []): Selection | null {
  const box = boxOf(hits, index)
  const rect = box ? cssToImage(box, null, dsf, image) : null
  return rect ? { rect, element: index, trail } : null
}

export interface ScreenComposerState {
  // source is what the comment is about; null waits for a paste or drop.
  source: ScreenSource | null
  // key starts a fresh composer for each open.
  key: number
}

interface ScreenCommentDialogProps {
  composer: ScreenComposerState | null
  // target is the project the comment joins, shown beside Send.
  target: CommentTargetProps
  actions: FeedbackActions
  onSource(source: ScreenSource): void
  onClose(): void
  onSent(thread: FeedbackThread): void
}

// ScreenCommentDialog is Feedback › New screen comment (decision 0176): the
// frozen image takes a rectangle, then the comment. A modal, because the
// rectangle needs the room and the keys, and nothing behind it should
// change while the image is frozen.
export function ScreenCommentDialog({ actions, composer, onClose, onSent, onSource, target }: ScreenCommentDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const discard = useRef<() => boolean>(() => true)
  const registerDiscard = useCallback((next: () => boolean) => { discard.current = next }, [])
  const open = composer !== null
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  return (
    <DialogShell ref={dialog} variant="viewer" className="screen-dialog" aria-labelledby="screen-dialog-title"
      onCancel={(event) => {
        // Escape asks before dropping a written comment.
        event.preventDefault()
        if (discard.current()) onClose()
      }}
      onClose={() => { if (open) onClose() }}>
      {composer && (
        <ScreenComposer key={composer.key} source={composer.source} target={target} actions={actions} registerDiscard={registerDiscard}
          onSource={onSource} onClose={onClose} onSent={onSent} />
      )}
    </DialogShell>
  )
}

interface ComposerProps {
  source: ScreenSource | null
  target: CommentTargetProps
  actions: FeedbackActions
  // registerDiscard sets what closing does: true closes, false asks first.
  registerDiscard(discard: () => boolean): void
  onSource(source: ScreenSource): void
  onClose(): void
  onSent(thread: FeedbackThread): void
}

function ScreenComposer({ actions, onClose, onSent, onSource, registerDiscard, source, target }: ComposerProps) {
  const [image, setImage] = useState<{ url: string; size: Size } | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [url, setURL] = useState(source?.page?.url ?? "")
  const [title, setTitle] = useState(source?.page?.title ?? "")
  const [mode, setMode] = useState<AttachMode>("region")
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [asking, setAsking] = useState(false)
  const [urlTouched, setURLTouched] = useState(false)
  const keep = useRef<HTMLButtonElement>(null)
  const bodyField = useRef<HTMLTextAreaElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const ids = useId()

  useEffect(() => {
    if (!source) return
    let current = true
    const objectURL = URL.createObjectURL(source.blob)
    imageSize(source.blob).then((size) => {
      if (current) setImage({ url: objectURL, size })
    }, () => {
      if (current) setUnreadable(true)
    })
    return () => {
      current = false
      URL.revokeObjectURL(objectURL)
    }
  }, [source])

  // Focus starts where the work starts: the image, or the drop target.
  useEffect(() => {
    if (image) stageRef.current?.focus({ preventScroll: true })
    else if (!source) dropRef.current?.focus({ preventScroll: true })
  }, [image, source])

  const page = source?.page ?? null
  // The hit map answers for the captured page only: a paste has none.
  const hits = page ? source?.hits ?? null : null
  const dsf = page?.viewport.deviceScaleFactor ?? 1
  const rect = selection?.rect ?? null
  // The element the comment names: the one selected, or for a region the
  // one a click at its center would select (decision 0176).
  const hint = useMemo<ScreenHint | null>(() => {
    if (!hits || !selection) return null
    const index = selection.element ?? pickAt(hits, cssCenter(selection.rect, dsf))
    return index === null ? null : hintOf(hits, index)
  }, [dsf, hits, selection])

  const toCSS = (point: Point): Point => ({ x: point.x / dsf, y: point.y / dsf })
  const pick = (point: Point) => {
    if (!hits || !image) return
    const index = pickAt(hits, toCSS(point))
    const next = index === null ? null : selectElement(hits, index, dsf, image.size)
    if (next) setSelection(next)
  }
  const hover = (point: Point | null) => {
    setHovered(hits && point ? pickAt(hits, toCSS(point)) : null)
  }
  // walk moves an element selection out to its parent, or back in.
  const walk = (outward: boolean): boolean => {
    const element = selection?.element ?? null
    if (!hits || !image || !selection || element === null) return false
    const { trail } = selection
    let next: Selection | null = null
    if (outward) {
      const parent = parentOf(hits, element)
      if (parent !== null) next = selectElement(hits, parent, dsf, image.size, [...trail, element])
    } else {
      const child = trail.at(-1)
      if (child !== undefined) next = selectElement(hits, child, dsf, image.size, trail.slice(0, -1))
    }
    if (next) setSelection(next)
    return true
  }
  const clear = () => {
    setSelection(null)
    stageRef.current?.focus({ preventScroll: true })
  }
  const selectedIndex = selection?.element ?? null
  const selectedLabel = hits && selectedIndex !== null ? hitLabel(hits.elements[selectedIndex]) : ""
  const hoverLabel = hits && hovered !== null && hovered !== selection?.element ? hitLabel(hits.elements[hovered]) : ""
  const hoverBox = hits && hovered !== null && hovered !== selection?.element ? boxOf(hits, hovered) : null

  const edited = useMemo(() => page ? { ...page, url, title } : null, [page, title, url])
  const plan = useMemo(() => rect && image ? planVisual(rect, image.size, edited, mode, hint) : null, [edited, hint, image, mode, rect])
  const urlProblem = page ? pageURLProblem(url) : ""
  const ready = Boolean(plan && body.trim() && !urlProblem && !busy)

  const discard = useCallback(() => {
    if (busy) return false
    if (!body.trim()) return true
    setAsking(true)
    return false
  }, [body, busy])
  useEffect(() => registerDiscard(discard), [discard, registerDiscard])
  useEffect(() => {
    if (asking) keep.current?.focus()
  }, [asking])

  const send = () => {
    if (!source || !plan || !ready) {
      if (urlProblem) setURLTouched(true)
      return
    }
    setBusy(true)
    setError("")
    const png = plan.clip ? cropPNG(source.blob, plan.clip) : pngOf(source.blob)
    png.then((encoded) => actions.startVisual(encoded, {
      rect: plan.rect,
      ...(plan.page ? { page: plan.page } : {}),
      ...(plan.element ? { element: plan.element } : {}),
    }, body.trim())).then(onSent, (failure: unknown) => {
      setError(failure instanceof Error ? failure.message : "Couldn't add the comment.")
      setBusy(false)
    })
  }

  const takeTransfer = (transfer: DataTransfer | null) => {
    const file = imageFile(transfer)
    if (!file) return false
    onSource(pastedSource(file))
    return true
  }

  return (
    <div className="screen-composer"
      onPaste={(event) => {
        // Only the waiting composer takes a pasted image; fields keep text.
        if (!source && takeTransfer(event.clipboardData)) event.preventDefault()
      }}
      onDragOver={(event: DragEvent) => {
        if (!source && hasImage(event.dataTransfer)) event.preventDefault()
      }}
      onDrop={(event: DragEvent) => {
        if (!source && takeTransfer(event.dataTransfer)) event.preventDefault()
      }}>
      <ViewHeader variant="dialog" className="screen-header" title="New screen comment" titleId="screen-dialog-title"
        actions={<IconButton label="Close" icon={<XIcon aria-hidden="true" />} onClick={() => { if (discard()) onClose() }} />} />
      <div className="screen-body">
        <section className="screen-stage-pane" aria-label="Screenshot">
          {!source
            ? <div ref={dropRef} className="screen-drop" tabIndex={0} role="group" aria-label="Paste a screenshot or drop an image">
              <ImageIcon className="screen-drop-icon" aria-hidden="true" />
              <p className="screen-drop-title">Paste a screenshot or drop an image</p>
              <p className="screen-drop-hint"><Kbd>{pasteKey}</Kbd><Kbd>V</Kbd> pastes from the clipboard</p>
            </div>
            : unreadable
              ? <div className="screen-drop"><StatusMessage tone="error" role="alert">This image can't be read. Paste a PNG, JPEG, or WebP image.</StatusMessage></div>
              : image
                ? <Stage stageRef={stageRef} image={image} rect={rect} selected={selectedLabel} clip={plan?.clip ?? null} picking={hits !== null}
                  onRect={(next) => setSelection({ rect: next, element: null, trail: [] })} onPick={pick} onHover={hover}
                  onClear={() => {
                    if (!selection) return false
                    clear()
                    return true
                  }}
                  onWalk={walk}
                  onDrawn={() => bodyField.current?.focus({ preventScroll: true })}
                  hoverBox={hoverBox ? cssToImage(hoverBox, null, dsf, image.size) : null}
                  elementBox={selection?.element === null && hint?.box ? cssToImage(hint.box, null, dsf, image.size) : null} />
                : <div className="screen-drop"><StatusMessage>Reading the image…</StatusMessage></div>}
          {image && (
            <div className="screen-stage-foot">
              {source?.drift && (
                <Notice tone="warning" layout="bar" className="screen-drift">
                  The page moved while it was captured. Outlines may not match the image.
                </Notice>
              )}
              <div className="screen-readout" id={`${ids}-readout`}>
                <p className="screen-readout-text">
                  {rect
                    ? <>
                      {selectedLabel ? <span className="screen-element">{selectedLabel}</span> : "Region"}
                      {" "}<span className="screen-figure">{rect.width} × {rect.height}</span> px
                      {plan && (plan.clip || page) ? <> · attaching <span className="screen-figure">{plan.image.width} × {plan.image.height}</span></> : null}
                    </>
                    : hoverLabel
                      ? <><span className="screen-element">{hoverLabel}</span> · click to select it, or drag a region</>
                      : hits
                        ? "Click an element or drag a region to mark what the comment is about. Arrow keys draw a region too."
                        : "Drag across the image to mark what the comment is about. Arrow keys work too."}
                </p>
                {rect && (
                  <span className="screen-readout-actions">
                    {selectedIndex !== null && hits && parentOf(hits, selectedIndex) !== null && (
                      <span className="screen-readout-keys"><Kbd>{altKey}</Kbd><Kbd>↑</Kbd> parent</span>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={clear}>Clear</Button>
                  </span>
                )}
              </div>
            </div>
          )}
        </section>
        <div className="screen-form">
          {page && (
            <dl className="screen-facts">
              {plan?.element && <>
                <dt>Element</dt>
                <dd><span className="screen-element">{elementLabel(plan.element)}</span> <span className="screen-muted">(from the page)</span></dd>
              </>}
              <dt><label htmlFor={`${ids}-url`}>URL</label></dt>
              <dd>
                <TextField id={`${ids}-url`} value={url} spellCheck={false} disabled={busy} invalid={urlTouched && Boolean(urlProblem)}
                  aria-describedby={urlTouched && urlProblem ? `${ids}-url-problem` : undefined}
                  onChange={(event) => setURL(event.target.value)} onBlur={() => setURLTouched(true)} />
                {urlTouched && urlProblem && <span className="screen-problem" id={`${ids}-url-problem`}>{urlProblem}</span>}
              </dd>
              <dt><label htmlFor={`${ids}-title`}>Title</label></dt>
              <dd><TextField id={`${ids}-title`} value={title} disabled={busy} placeholder="Untitled page" onChange={(event) => setTitle(event.target.value)} /></dd>
              <dt id={`${ids}-attach`}>Attach</dt>
              <dd>
                <SegmentedControl size="sm" aria-labelledby={`${ids}-attach`} className="screen-attach">
                  <SegmentedItem pressed={mode === "region"} disabled={busy} onClick={() => setMode("region")}>Region + margin</SegmentedItem>
                  <SegmentedItem pressed={mode === "full"} disabled={busy} onClick={() => setMode("full")}>Full view</SegmentedItem>
                </SegmentedControl>
                <span className="screen-muted screen-attach-note">
                  {mode === "region" ? `The region and ${regionMargin} px around it; the rest stays here.` : "The whole view as captured."}
                </span>
              </dd>
            </dl>
          )}
          {!page && source && <p className="screen-muted screen-source">A pasted image is attached whole.</p>}
          <label className="screen-label" htmlFor={`${ids}-body`}>Comment</label>
          <TextArea ref={bodyField} id={`${ids}-body`} className="screen-body-field" rows={5} value={body} disabled={busy}
            placeholder="What should change here?" aria-keyshortcuts="Control+Enter Meta+Enter"
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (isSendKey(event)) {
                event.preventDefault()
                send()
              }
            }} />
          <span className="feedback-hint">Markdown · {sendKeys} to send</span>
          {error && <StatusMessage tone="error" role="alert" className="screen-error">{error}</StatusMessage>}
          {asking
            ? <Notice tone="warning" layout="bar" role="group" aria-label="Discard this comment?" className="screen-confirm">
              <span>Discard this comment?</span>
              <span className="screen-actions">
                <Button size="sm" variant="destructive" onClick={onClose}>Discard</Button>
                <Button ref={keep} size="sm" variant="outline" onClick={() => setAsking(false)}>Keep editing</Button>
              </span>
            </Notice>
            : <div className="screen-actions screen-footer">
              <CommentTarget {...target} />
              <Button variant="ghost" disabled={busy} onClick={() => { if (discard()) onClose() }}>Cancel</Button>
              <Button disabled={!ready} title={!rect ? "Mark a region first" : !body.trim() ? "Write a comment first" : undefined} onClick={send}>
                {busy ? "Sending…" : "Send"}
              </Button>
            </div>}
        </div>
      </div>
    </div>
  )
}

function placed(at: Fraction) {
  return { left: `${at.left * 100}%`, top: `${at.top * 100}%`, width: `${at.width * 100}%`, height: `${at.height * 100}%` }
}

interface StageProps {
  stageRef: { current: HTMLDivElement | null }
  image: { url: string; size: Size }
  rect: FeedbackRect | null
  // selected names the selected element, "" for a region.
  selected: string
  clip: FeedbackRect | null
  // elementBox is a region's element hint; hoverBox the element a click
  // would select. Both in image pixels.
  elementBox: FeedbackRect | null
  hoverBox: FeedbackRect | null
  // picking says a click selects an element: the capture has a hit map.
  picking: boolean
  onRect(rect: FeedbackRect): void
  onPick(point: Point): void
  onHover(point: Point | null): void
  // onClear clears the selection, reporting whether there was one.
  onClear(): boolean
  // onWalk moves an element selection outward or back, reporting whether
  // there was one to move.
  onWalk(outward: boolean): boolean
  // onDrawn follows a rectangle drawn with the pointer: the comment is next.
  onDrawn(): void
}

// Stage is the frozen image under the pointer (decision 0180). With a hit
// map, hovering outlines the element a click selects, a click selects it,
// and Alt with Up and Down walks to its parent and back. A drag draws a free
// rectangle anywhere, gaps and canvases included; arrow keys draw and move
// one, and Shift with them resizes it. Escape clears the selection before
// it closes anything. What a region keeps shows bright; the rest, which
// never leaves this page, dims. A drawn rectangle moves focus to the
// comment; clicks and keys keep it on the image.
function Stage({ clip, elementBox, hoverBox, image, onClear, onDrawn, onHover, onPick, onRect, onWalk, picking, rect, selected, stageRef }: StageProps) {
  const [drawing, setDrawing] = useState<FeedbackRect | null>(null)
  const start = useRef<{ point: Point; x: number; y: number } | null>(null)
  const { size } = image
  const shown = drawing ?? rect

  const pointAt = (event: PointerEvent): Point => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: ((event.clientX - box.left) / box.width) * size.width, y: ((event.clientY - box.top) / box.height) * size.height }
  }
  const moved = (event: PointerEvent) => start.current !== null
    && (Math.abs(event.clientX - start.current.x) >= dragThreshold || Math.abs(event.clientY - start.current.y) >= dragThreshold)

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // The selection goes first; the dialog's Escape waits for the next.
      if (onClear()) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      if (onWalk(event.key === "ArrowUp")) {
        event.preventDefault()
        return
      }
    }
    const step = nudgeStep(size)
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const move = moves[event.key]
    if (move) {
      event.preventDefault()
      onRect(rect ? nudge(rect, move[0], move[1], event.shiftKey, size) : centeredRect(size))
    } else if ((event.key === "Enter" || event.key === " ") && !rect) {
      event.preventDefault()
      onRect(centeredRect(size))
    }
  }

  const label = shown
    ? `${drawing || !selected ? "Region" : `Selected ${selected},`} ${shown.width} by ${shown.height} pixels at ${shown.x}, ${shown.y}`
    : "Nothing selected yet"
  return (
    <div className="screen-stage">
      <div ref={stageRef} className="screen-frame" tabIndex={0} role="group"
        aria-label={picking
          ? "Screenshot. Click an element to select it, or drag to mark a region; arrow keys draw and move a region, Shift with arrows resizes it, Alt with Up selects the parent element, and Escape clears the selection."
          : "Screenshot. Drag to mark a region, or press an arrow key to start one; arrows move it and Shift with arrows resizes it."}
        aria-roledescription="region picker"
        data-picking={picking || undefined}
        style={{ aspectRatio: `${size.width} / ${size.height}`, width: `min(100cqw, calc(100cqh * ${size.width} / ${size.height}))` }}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          start.current = { point: pointAt(event), x: event.clientX, y: event.clientY }
          onHover(null)
        }}
        onPointerMove={(event) => {
          if (!start.current) {
            if (event.pointerType !== "touch") onHover(pointAt(event))
            return
          }
          if (!moved(event)) return
          setDrawing(dragRect(start.current.point, pointAt(event), size))
        }}
        onPointerLeave={() => {
          if (!start.current) onHover(null)
        }}
        onPointerUp={(event) => {
          const pressed = start.current
          if (pressed && moved(event)) {
            const next = dragRect(pressed.point, pointAt(event), size)
            if (next) {
              onRect(next)
              onDrawn()
            }
          } else if (pressed) {
            onPick(pressed.point)
          }
          start.current = null
          setDrawing(null)
        }}
        onPointerCancel={() => {
          start.current = null
          setDrawing(null)
        }}>
        <img className="screen-image" src={image.url} alt="" draggable={false} />
        {clip && !drawing && <div className="screen-keep" style={placed(fraction(clip, size))} aria-hidden="true" />}
        {shown && <div className="screen-mark" style={placed(fraction(shown, size))} aria-hidden="true" />}
        {elementBox && !drawing && <div className="screen-element-box" style={placed(fraction(elementBox, size))} aria-hidden="true" />}
        {hoverBox && !drawing && <div className="screen-hover-box" style={placed(fraction(hoverBox, size))} aria-hidden="true" />}
        <span className="visually-hidden" role="status">{drawing ? "" : label}</span>
      </div>
    </div>
  )
}
