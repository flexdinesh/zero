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
import { desktopBridge } from "../../lib/desktop-bridge.ts"
import { isSendKey, sendKeys } from "./FeedbackThreadZone.tsx"
import { cropPNG, hasImage, imageFile, imageSize, pngOf } from "./screen-image.ts"
import type { FeedbackActions } from "./use-feedback.ts"
import type { ScreenSource } from "./use-screen-comment.ts"
import {
  centeredRect, cssCenter, dragRect, fraction, nudge, nudgeStep, regionMargin, type Fraction, type Point, type Size,
} from "./visual-geometry.ts"
import { elementLabel, pageURLProblem, planVisual, type AttachMode, type ScreenHint } from "./visual-model.ts"

const mac = typeof navigator !== "undefined" && navigator.platform.includes("Mac")
const pasteKey = mac ? "⌘" : "Ctrl"

// A press that moves less than this many screen pixels is a click, not a
// drag, and keeps the rectangle drawn before it.
const dragThreshold = 4
// The page is asked for its element once the rectangle settles.
const hintDelay = 150

export interface ScreenComposerState {
  // source is what the comment is about; null waits for a paste or drop.
  source: ScreenSource | null
  // key starts a fresh composer for each open.
  key: number
}

interface ScreenCommentDialogProps {
  composer: ScreenComposerState | null
  actions: FeedbackActions
  onSource(source: ScreenSource): void
  onClose(): void
  onSent(thread: FeedbackThread): void
}

// ScreenCommentDialog is Feedback › New screen comment (decision 0176): the
// frozen image takes a rectangle, then the comment. A modal, because the
// rectangle needs the room and the keys, and nothing behind it should
// change while the image is frozen.
export function ScreenCommentDialog({ actions, composer, onClose, onSent, onSource }: ScreenCommentDialogProps) {
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
        <ScreenComposer key={composer.key} source={composer.source} actions={actions} registerDiscard={registerDiscard}
          onSource={onSource} onClose={onClose} onSent={onSent} />
      )}
    </DialogShell>
  )
}

type Hint = { rect: FeedbackRect; hint: ScreenHint | null }

interface ComposerProps {
  source: ScreenSource | null
  actions: FeedbackActions
  // registerDiscard sets what closing does: true closes, false asks first.
  registerDiscard(discard: () => boolean): void
  onSource(source: ScreenSource): void
  onClose(): void
  onSent(thread: FeedbackThread): void
}

function ScreenComposer({ actions, onClose, onSent, onSource, registerDiscard, source }: ComposerProps) {
  const [image, setImage] = useState<{ url: string; size: Size } | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [rect, setRect] = useState<FeedbackRect | null>(null)
  const [found, setFound] = useState<Hint | null>(null)
  const [url, setURL] = useState(source?.page?.url ?? "")
  const [title, setTitle] = useState(source?.page?.title ?? "")
  const [mode, setMode] = useState<AttachMode>("region")
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [asking, setAsking] = useState(false)
  const [urlTouched, setURLTouched] = useState(false)
  const keep = useRef<HTMLButtonElement>(null)
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
  const capture = source?.capture ?? null
  const lookup = useMemo(() => desktopBridge()?.screenElement ?? null, [])
  // Ask the page for its element at the rectangle's center, once it settles.
  useEffect(() => {
    if (!rect || !page || !capture || !lookup) return
    let current = true
    const center = cssCenter(rect, page.viewport.deviceScaleFactor)
    const timer = window.setTimeout(() => {
      void lookup(capture, center.x, center.y).then((element) => {
        if (current) setFound({ rect, hint: element })
      })
    }, hintDelay)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [capture, lookup, page, rect])
  const hint = found && found.rect === rect ? found.hint : null
  const looking = Boolean(rect && page && capture && lookup) && found?.rect !== rect

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
    onSource({ blob: file, page: null, capture: null })
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
                ? <Stage stageRef={stageRef} image={image} rect={rect} onRect={setRect} clip={plan?.clip ?? null}
                  elementBox={hint?.box && page ? frameBox(hint.box, page.viewport.deviceScaleFactor) : null} />
                : <div className="screen-drop"><StatusMessage>Reading the image…</StatusMessage></div>}
          {image && (
            <p className="screen-readout" id={`${ids}-readout`}>
              {rect
                ? <>Region <span className="screen-figure">{rect.width} × {rect.height}</span> px
                  {plan && (plan.clip || page) ? <> · attaching <span className="screen-figure">{plan.image.width} × {plan.image.height}</span></> : null}</>
                : "Drag across the image to mark what the comment is about. Arrow keys work too."}
            </p>
          )}
        </section>
        <div className="screen-form">
          {page && (
            <dl className="screen-facts">
              {(plan?.element || looking) && <>
                <dt>Element</dt>
                <dd>{plan?.element
                  ? <><span className="screen-element">{elementLabel(plan.element)}</span> <span className="screen-muted">(from the page)</span></>
                  : <span className="screen-muted">Asking the page…</span>}</dd>
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
          <TextArea id={`${ids}-body`} className="screen-body-field" rows={5} value={body} disabled={busy}
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

// frameBox moves an element's CSS box into frame pixels.
function frameBox(box: FeedbackRect, deviceScaleFactor: number): FeedbackRect {
  return { x: box.x * deviceScaleFactor, y: box.y * deviceScaleFactor, width: box.width * deviceScaleFactor, height: box.height * deviceScaleFactor }
}

function placed(at: Fraction) {
  return { left: `${at.left * 100}%`, top: `${at.top * 100}%`, width: `${at.width * 100}%`, height: `${at.height * 100}%` }
}

interface StageProps {
  stageRef: { current: HTMLDivElement | null }
  image: { url: string; size: Size }
  rect: FeedbackRect | null
  clip: FeedbackRect | null
  elementBox: FeedbackRect | null
  onRect(rect: FeedbackRect): void
}

// Stage is the frozen image under the pointer: a drag draws the rectangle,
// arrow keys move it, and Shift with them resizes it. What a region keeps
// shows bright; the rest, which never leaves this page, dims.
function Stage({ clip, elementBox, image, onRect, rect, stageRef }: StageProps) {
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

  const label = shown ? `Region ${shown.width} by ${shown.height} pixels at ${shown.x}, ${shown.y}` : "No region yet"
  return (
    <div className="screen-stage">
      <div ref={stageRef} className="screen-frame" tabIndex={0} role="group"
        aria-label="Screenshot. Drag to mark a region, or press an arrow key to start one; arrows move it and Shift with arrows resizes it."
        aria-roledescription="region picker"
        style={{ aspectRatio: `${size.width} / ${size.height}`, width: `min(100cqw, calc(100cqh * ${size.width} / ${size.height}))` }}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          start.current = { point: pointAt(event), x: event.clientX, y: event.clientY }
        }}
        onPointerMove={(event) => {
          if (!start.current || !moved(event)) return
          setDrawing(dragRect(start.current.point, pointAt(event), size))
        }}
        onPointerUp={(event) => {
          if (start.current && moved(event)) {
            const next = dragRect(start.current.point, pointAt(event), size)
            if (next) onRect(next)
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
        {elementBox && !drawing && <div className="screen-element-box" style={placed(fraction(elementBox, size))} aria-hidden="true" />}
        {shown && <div className="screen-mark" style={placed(fraction(shown, size))} aria-hidden="true" />}
        <span className="visually-hidden" role="status">{drawing ? "" : label}</span>
      </div>
    </div>
  )
}
