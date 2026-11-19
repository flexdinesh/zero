import type { FeedbackElement, FeedbackPage, FeedbackRect, FeedbackThread, FeedbackVisual } from "@zero/contracts"
import { clipToBounds, cssToImage, frameSize, imageToCSS, regionClip, toImage, type Size } from "./visual-geometry.ts"

// Pure model of visual feedback threads (decision 0176): how a screenshot
// thread is labelled, whether its page can be opened, its Markdown as
// `zero feedback show` prints it, and the draft a composer sends.

// VisualThread is a thread on a screenshot rather than code.
export type VisualThread = FeedbackThread & { visual: FeedbackVisual }

export function isVisualThread(thread: FeedbackThread): thread is VisualThread {
  return thread.visual !== undefined
}

function parseURL(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

// isLoopback reports a host naming the machine it is read on: localhost,
// *.localhost, 127.0.0.0/8, or [::1].
export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "::1"
}

// pageAddress is a page's host and path without scheme, query, or
// fragment: "localhost:5173/settings"; the URL itself when unparsable.
export function pageAddress(url: string): string {
  const parsed = parseURL(url)
  if (!parsed) return url
  return parsed.pathname === "/" ? parsed.host : `${parsed.host}${parsed.pathname}`
}

// visualPlace is a visual thread's place for the UI: the page's address,
// or "Screenshot" for a pasted image.
export function visualPlace(visual: FeedbackVisual): string {
  return visual.page ? pageAddress(visual.page.url) : "Screenshot"
}

// canOpenPage reports a page URL the viewer can open as the agent would:
// the project's own loopback, or a host that is not loopback.
export function canOpenPage(page: FeedbackPage): boolean {
  const parsed = parseURL(page.url)
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return false
  if (page.localhost === "project") return true
  return page.localhost === undefined && !isLoopback(parsed.hostname)
}

// pageWhere says what a page's loopback host refers to: "localhost on your
// machine" when the reviewer's, "" otherwise.
export function pageWhere(page: FeedbackPage): string {
  return page.localhost === "viewer" ? "localhost on your machine" : ""
}

// elementLabel names an element hint as the composer shows it:
// `button "Save changes"`, or the tag alone.
export function elementLabel(element: Pick<FeedbackElement, "tag" | "name" | "text">): string {
  const name = element.name || element.text
  return name ? `${element.tag} "${name}"` : element.tag
}

// attachmentURL is where a visual thread's screenshot is read.
export function attachmentURL(project: string, feedbackId: string, attachment: string): string {
  return `/api/feedback-attachment?${new URLSearchParams({ project, id: feedbackId, attachment }).toString()}`
}

function decimal(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function rectText(rect: FeedbackRect): string {
  return `${decimal(rect.x)},${decimal(rect.y)} ${decimal(rect.width)}×${decimal(rect.height)}`
}

// visualHeading is a visual thread's place in its Markdown heading:
// "screenshot · <url>", with " (removed)" once the screenshot is gone.
export function visualHeading(visual: FeedbackVisual): string {
  return `screenshot${visual.available ? "" : " (removed)"}${visual.page ? ` · ${visual.page.url}` : ""}`
}

const localhostLines: Readonly<Record<NonNullable<FeedbackPage["localhost"]>, string>> = {
  project: "Localhost: this machine, where the project is; the URL opens as written",
  viewer: "Localhost: the reviewer's machine, not this one; the port may not reach the project",
}

// visualLines are a visual thread's lines under its Markdown heading
// (testdata/feedback/visual/show.md): the page, what its localhost names,
// the region in image, CSS, and document pixels, the element hint, the
// commit, and the command that reads the screenshot.
export function visualLines(feedbackId: string, visual: FeedbackVisual): string[] {
  const { attachment, element, head, page, rect } = visual
  const lines: string[] = []
  if (page) {
    const { viewport, scroll } = page
    lines.push(`Page: ${[
      page.title ? `"${page.title}"` : "",
      `viewport ${decimal(viewport.width)}×${decimal(viewport.height)} CSS px at ${decimal(viewport.deviceScaleFactor)}×`,
      `scrolled ${decimal(scroll.x)},${decimal(scroll.y)}`,
    ].filter(Boolean).join(" · ")}`)
    if (page.localhost) lines.push(localhostLines[page.localhost])
  }
  let region = `Region: image ${rectText(rect)} of ${attachment.width}×${attachment.height}`
  if (page) {
    const css = imageToCSS(rect, page.clip ?? null, page.viewport.deviceScaleFactor)
    region += ` · CSS ${rectText(css)} · document ${decimal(css.x + page.scroll.x)},${decimal(css.y + page.scroll.y)}`
  }
  lines.push(region)
  if (element) lines.push(`Element: ${element.name ? `${element.tag} "${element.name}"` : element.tag} · ${element.selector}`)
  if (head) lines.push(`Code at: ${head}`)
  lines.push(visual.available
    ? `Screenshot: zero feedback attachment ${feedbackId} ${attachment.id} [--crop -o region.png]`
    : "Screenshot: removed to stay within the storage budget")
  return lines
}

// ScreenPage is the page a capture froze, as the composer edits it.
export interface ScreenPage {
  url: string
  title: string
  viewport: { width: number; height: number; deviceScaleFactor: number }
  scroll: { x: number; y: number }
}

// ScreenHint is the page's element at the rectangle's center, box in CSS
// pixels of the viewport.
export interface ScreenHint {
  selector: string
  tag: string
  role?: string
  name?: string
  text?: string
  box?: FeedbackRect
}

export type AttachMode = "region" | "full"

// pageURLProblem says why an edited page URL cannot be sent, "" when it can.
export function pageURLProblem(url: string): string {
  const parsed = parseURL(url.trim())
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return "Enter an http or https URL."
  if (url.trim().length > 2048) return "The URL is longer than 2048 characters."
  return ""
}

function oneLine(text: string, limit: number): string {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, limit).join("")
}

const tagPattern = /^[a-z][a-z0-9-]*$/

// elementDraft bounds an element hint as the server stores it and moves
// its box into the image; null when the hint cannot be stored or its box
// falls outside the image (the page no longer matches the capture).
export function elementDraft(hint: ScreenHint, clip: FeedbackRect | null, deviceScaleFactor: number, image: Size): FeedbackElement | null {
  const tag = hint.tag.toLowerCase()
  if (!tagPattern.test(tag) || tag.length > 32 || !hint.selector || new TextEncoder().encode(hint.selector).length > 512) return null
  const element: FeedbackElement = { selector: hint.selector, tag }
  const role = hint.role ? oneLine(hint.role, 64) : ""
  const name = hint.name ? oneLine(hint.name, 256) : ""
  const text = hint.text ? oneLine(hint.text, 256) : ""
  if (role) element.role = role
  if (name) element.name = name
  if (text) element.text = text
  if (hint.box) {
    const box = cssToImage(hint.box, clip, deviceScaleFactor, image)
    if (!box) return null
    element.box = box
  }
  return element
}

// VisualPlan is what Send uploads and records: the part of the frozen image
// to upload (null for all of it), the uploaded image's size, and the
// target in its pixels.
export interface VisualPlan {
  clip: FeedbackRect | null
  image: Size
  rect: FeedbackRect
  page?: {
    url: string
    title?: string
    viewport: ScreenPage["viewport"]
    scroll: ScreenPage["scroll"]
    clip?: FeedbackRect
  }
  element?: FeedbackElement
}

// planVisual maps a rectangle drawn on the frozen image (frame pixels for a
// capture, image pixels for a paste) to what Send uploads. A region keeps
// the rectangle plus the 48 CSS px margin, clamped to the frame; Full view
// and pastes upload the whole image. null when the rectangle is outside
// the image.
export function planVisual(drawn: FeedbackRect, frozen: Size, page: ScreenPage | null, mode: AttachMode, hint: ScreenHint | null): VisualPlan | null {
  const inside = clipToBounds(drawn, frozen)
  if (!inside) return null
  if (!page) return { clip: null, image: frozen, rect: inside }
  const dsf = page.viewport.deviceScaleFactor
  // The PNG's own size is the frame; the viewport's only names it.
  const frame = frozen.width > 0 && frozen.height > 0 ? frozen : frameSize(page.viewport)
  const clip = mode === "region" ? regionClip(inside, dsf, frame) : null
  const image = clip ? { width: clip.width, height: clip.height } : frame
  const title = oneLine(page.title, 256)
  const plan: VisualPlan = {
    clip,
    image,
    rect: toImage(inside, clip),
    page: { url: page.url.trim(), ...(title ? { title } : {}), viewport: page.viewport, scroll: page.scroll, ...(clip ? { clip } : {}) },
  }
  const element = hint ? elementDraft(hint, clip, dsf, image) : null
  if (element) plan.element = element
  return plan
}
