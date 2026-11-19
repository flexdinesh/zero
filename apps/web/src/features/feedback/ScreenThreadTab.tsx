import type { FeedbackStatus, FeedbackThread, FeedbackVisual } from "@zero/contracts"
import { AppWindowIcon, ArrowUpRightIcon, CheckIcon, ClipboardCopyIcon, ImageOffIcon, XIcon } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { Button } from "../../components/ui/button.tsx"
import { StatusMessage } from "../../components/ui/notice.tsx"
import { SegmentedControl, SegmentedItem } from "../../components/ui/segmented-control.tsx"
import { shortHash } from "../../lib/commit-hash.ts"
import { commitAge, commitDate } from "../source-control/compare.ts"
import { threadRoute, threadTitle, type ThreadRoute } from "./feedback-model.ts"
import { FeedbackThreadZone } from "./FeedbackThreadZone.tsx"
import { copyImage, cropPNG } from "./screen-image.ts"
import type { FeedbackActions, FeedbackSession } from "./use-feedback.ts"
import { VisualShot } from "./VisualTarget.tsx"
import { copyMargin, expand } from "./visual-geometry.ts"
import { attachmentURL, elementLabel, isVisualThread, pageAddress, pageOpener, pageWhere, visualPlace } from "./visual-model.ts"

interface ScreenThreadTabProps {
  project: string
  feedbackId: string
  number: number
  // session reads the feedback holding the thread.
  session: FeedbackSession
  navigate(href: string): void
  // reviewPage opens a page in the project's review window through its
  // Browser tab, which remembers it (decisions 0181, 0183); null outside
  // the desktop app's local window.
  reviewPage: ((url: string) => void) | null
  // onPin keeps the preview tab open once the reviewer writes in it.
  onPin(): void
  onClose(): void
  onOpenThread(route: ThreadRoute): void
}

// ScreenThreadTab is a visual thread's own tab (decision 0182): the
// screenshot as it was captured with the region marked, beside the page it
// came from and the conversation. It reads the stored screenshot, so the
// evidence stays as it was however the page changes since.
export function ScreenThreadTab({ feedbackId, navigate, number, onClose, onOpenThread, onPin, project, reviewPage, session }: ScreenThreadTabProps) {
  const { feedback, load } = session
  const thread = feedback?.id === feedbackId ? feedback.threads.find((entry) => entry.number === number) ?? null : null
  if (load.kind === "missing") {
    return <Gone message="This feedback was deleted." onClose={onClose} />
  }
  if (!thread && load.kind === "error") {
    return (
      <div className="error" role="alert">
        <p>{load.message}</p>
        <Button variant="outline" onClick={session.retry}>Try again</Button>
      </div>
    )
  }
  if (!feedback || feedback.id !== feedbackId) return <StatusMessage className="document-loading">Loading the thread…</StatusMessage>
  if (!thread) return <Gone message={`Thread ${number} was deleted.`} onClose={onClose} />
  if (!isVisualThread(thread)) {
    const route = threadRoute(project, thread)
    return (
      <div className="empty">
        <p>Thread {number} is on code, not a screenshot.</p>
        {route && <Button variant="outline" onClick={() => onOpenThread(route)}>Open where it was written</Button>}
      </div>
    )
  }
  return <ScreenThread key={`${feedbackId}:${number}`} project={project} feedbackId={feedbackId} thread={thread} visual={thread.visual}
    actions={session.actions} navigate={navigate} reviewPage={reviewPage} onPin={onPin} />
}

function Gone({ message, onClose }: { message: string; onClose(): void }) {
  return (
    <div className="empty">
      <p>{message}</p>
      <Button variant="outline" onClick={onClose}>Close tab</Button>
    </div>
  )
}

// Age is a time as long ago as it reads now.
function Age({ time }: { time: string }) {
  const now = useMemo(() => time ? Date.now() : 0, [time])
  return <time dateTime={time} title={commitDate(time)}>{commitAge(time, now).long}</time>
}

type Scale = "fit" | "actual"

interface ThreadProps {
  project: string
  feedbackId: string
  thread: FeedbackThread
  visual: FeedbackVisual
  actions: FeedbackActions
  navigate(href: string): void
  reviewPage: ((url: string) => void) | null
  onPin(): void
}

function ScreenThread({ actions, feedbackId, navigate, onPin, project, reviewPage, thread, visual }: ThreadProps) {
  const image = useRef<HTMLImageElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const [scale, setScale] = useState<Scale>("fit")
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle")
  const pin = useRef(onPin)
  useLayoutEffect(() => { pin.current = onPin })
  useEffect(() => {
    if (copy === "idle") return
    const timer = window.setTimeout(() => setCopy("idle"), 1600)
    return () => window.clearTimeout(timer)
  }, [copy])
  // Actual size centers the region, which may sit outside the pane.
  useEffect(() => {
    const area = canvas.current
    if (scale !== "actual" || !area) return
    const mark = area.querySelector(".visual-mark")
    if (mark instanceof HTMLElement) mark.scrollIntoView({ block: "center", inline: "center" })
  }, [scale])
  // Writing in the tab keeps it: replies and status changes pin it.
  const zoneActions = useMemo(() => ({
    reply: (number: number, body: string, status?: FeedbackStatus) => actions.reply(number, body, status).then((updated) => {
      pin.current()
      return updated
    }),
    removeThread: (number: number) => actions.removeThread(number),
  }), [actions])

  const { attachment, element, head, page, rect } = visual
  const src = attachmentURL(project, feedbackId, attachment.id)
  const shown = visual.available && !failed
  const dsf = page?.viewport.deviceScaleFactor ?? 1
  const place = visualPlace(visual)
  const opener = useMemo(() => page ? pageOpener(page, reviewPage !== null) : null, [page, reviewPage])
  const where = page ? pageWhere(page) : ""

  const copyCrop = () => {
    const shot = image.current
    if (!shot) return
    const area = expand(rect, copyMargin, { width: attachment.width, height: attachment.height })
    copyImage(cropPNG(shot, area)).then(() => setCopy("copied"), () => setCopy("failed"))
  }
  const openPage = () => {
    if (!page) return
    if (opener === "review" && reviewPage) reviewPage(page.url)
    else window.open(page.url, "_blank", "noopener,noreferrer")
  }

  return (
    <div className="screen-tab">
      <div className="screen-tab-layout">
        <section className="screen-tab-stage" aria-label="Screenshot">
          <div className="screen-tab-bar">
            {shown && (
              <SegmentedControl size="sm" aria-label="Zoom">
                <SegmentedItem pressed={scale === "fit"} onClick={() => setScale("fit")}>Fit</SegmentedItem>
                <SegmentedItem pressed={scale === "actual"} onClick={() => setScale("actual")}>Actual size</SegmentedItem>
              </SegmentedControl>
            )}
            <span className="screen-tab-readout">
              Region <span className="screen-figure">{rect.width} × {rect.height}</span> of <span className="screen-figure">{attachment.width} × {attachment.height}</span> px
            </span>
          </div>
          {shown
            ? <div ref={canvas} className="screen-tab-canvas" data-scale={scale} tabIndex={0}
              aria-label={`Screenshot of ${place}, ${attachment.width} by ${attachment.height} pixels, region ${rect.width} by ${rect.height} at ${rect.x}, ${rect.y} marked`}>
              <div className="screen-tab-frame"
                style={scale === "fit"
                  ? { width: `min(100cqw, calc(100cqh * ${attachment.width} / ${attachment.height}))` }
                  : { width: `${attachment.width / dsf}px`, height: `${attachment.height / dsf}px` }}>
                <VisualShot src={src} visual={visual} imageRef={image} onFailed={() => setFailed(true)} />
              </div>
            </div>
            : <p className="screen-tab-missing">
              <ImageOffIcon aria-hidden="true" />
              {failed ? "The screenshot couldn't be read." : "The screenshot isn't stored: it was dropped for the storage budget, or its file is missing. The thread stays."}
            </p>}
        </section>
        <aside className="screen-tab-side" aria-label={`Thread ${thread.number}: ${threadTitle(thread)}`}>
          <div className="screen-tab-summary">
            <dl className="screen-tab-facts">
              {page && <>
                <dt>Page</dt>
                <dd>
                  <span className="screen-tab-url" title={page.url}><AppWindowIcon aria-hidden="true" />{pageAddress(page.url)}</span>
                  {where && <span className="screen-muted">{where}</span>}
                </dd>
                {page.title && <><dt>Title</dt><dd className="screen-tab-text">{page.title}</dd></>}
              </>}
              {element && <>
                <dt>Element</dt>
                <dd>
                  <span className="screen-element">{elementLabel(element)}</span>
                  <span className="screen-muted screen-tab-selector" title={element.selector}>{element.selector}</span>
                </dd>
              </>}
              <dt>Captured</dt>
              <dd className="screen-tab-text">
                <Age time={thread.createdAt} />
                {head && <> · code at <code className="screen-tab-hash" title={head}>{shortHash(head)}</code></>}
              </dd>
            </dl>
            {(shown || opener) && (
              <div className="visual-actions">
                {shown && <>
                  <Button size="sm" variant="outline" data-status={copy} onClick={copyCrop}>
                    {copy === "copied" ? <CheckIcon aria-hidden="true" /> : copy === "failed" ? <XIcon aria-hidden="true" /> : <ClipboardCopyIcon aria-hidden="true" />}
                    {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy crop"}
                  </Button>
                  <span className="visually-hidden" role="status">{copy === "copied" ? "Crop copied" : copy === "failed" ? "Copy failed" : ""}</span>
                </>}
                {opener && (
                  <Button size="sm" variant="outline" title={opener === "review" ? "Open the page in the review window" : "Open the page in a new tab"} onClick={openPage}>
                    Open page<ArrowUpRightIcon aria-hidden="true" />
                  </Button>
                )}
              </div>
            )}
          </div>
          <FeedbackThreadZone thread={thread} feedbackId={feedbackId} project={project} actions={zoneActions} navigate={navigate} collapsible={false} />
        </aside>
      </div>
    </div>
  )
}
