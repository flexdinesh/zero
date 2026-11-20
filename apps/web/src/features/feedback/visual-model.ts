import type { FeedbackColorScheme, FeedbackElement, FeedbackElementPair, FeedbackPage, FeedbackRect, FeedbackThread, FeedbackVisual } from "@zero/contracts"
import { clipToBounds, cssToImage, frameSize, imageToCSS, regionClip, toImage, type Size } from "./visual-geometry.ts"

// Pure model of visual feedback threads (decision 0176): how a screenshot
// thread is labelled, whether its page can be opened, its Markdown as
// `zero feedback show` prints it, and the draft a screen comment sends.

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

// PageOpener is where Open page shows a visual thread's page: the project's
// Browser tab where the desktop app hosts it (decisions 0182, 0184), else a
// browser's own tab; null when the page cannot be opened as the agent would.
export type PageOpener = "review" | "browser" | null

export function pageOpener(page: FeedbackPage, browserTab: boolean): PageOpener {
  if (!canOpenPage(page)) return null
  return browserTab ? "review" : "browser"
}

// pageWhere says what a page's loopback host refers to: "localhost on your
// machine" when the reviewer's, "" otherwise.
export function pageWhere(page: FeedbackPage): string {
  return page.localhost === "viewer" ? "localhost on your machine" : ""
}

// elementLabel names an element hint by its role, else its tag, with its
// name or text:
// `menuitem "Export data"`, `button "Save changes"`, or the kind alone.
export function elementLabel(element: Pick<FeedbackElement, "tag" | "role" | "name" | "text">): string {
  const kind = element.role || element.tag
  const name = element.name || element.text
  return name ? `${kind} "${name}"` : kind
}

// ElementDetail is one more thing the page said of an element, for the
// screen tab: a label and its values, all the page's own text.
export interface ElementDetail {
  label: string
  values: string[]
}

// elementDetails lists what else the page said of an element (decision
// 0184), in the order `zero feedback show` prints it; parts it did not give
// are left out.
export function elementDetails(element: FeedbackElement): ElementDetail[] {
  const details: ElementDetail[] = []
  const add = (label: string, values: readonly (string | undefined)[]) => {
    const given = values.filter((value): value is string => Boolean(value))
    if (given.length > 0) details.push({ label, values: given })
  }
  add("Path", [element.path])
  add("Component", [element.component])
  add("Source", [element.source])
  add("Classes", [element.classes])
  add("Attributes", (element.attributes ?? []).map((pair) => `${pair.name}=${pair.value}`))
  add("Styles", (element.styles ?? []).map((pair) => `${pair.name}: ${pair.value}`))
  add("Nearby text", [element.nearby])
  add("Selected text", [element.selectedText])
  return details
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

// codeSpan is text as a Markdown code span, fenced by one backtick more than
// its longest backtick run and padded when it starts or ends with one, so
// text from the reviewed page can't restyle the Markdown (decision 0178).
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(longest + 1)
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text
  return `${fence}${padded}${fence}`
}

// plainWord is a role that reads safely outside a code span.
const plainWord = /^[a-z][a-z0-9-]*$/

// elementMarkdown is an element hint as `zero feedback show` prints it: the
// tag, its role when it differs, and its name or else text.
function elementMarkdown(element: FeedbackElement): string {
  let hint = element.tag
  if (element.role && element.role !== element.tag) hint += ` (${plainWord.test(element.role) ? element.role : codeSpan(element.role)})`
  const name = element.name || element.text
  if (name) hint += ` ${codeSpan(name)}`
  return element.selector ? `${hint} · ${codeSpan(element.selector)}` : hint
}

function pairSpans(pairs: readonly FeedbackElementPair[], joiner: string): string {
  return pairs.map((pair) => codeSpan(`${pair.name}${joiner}${pair.value}`)).join(" ")
}

// elementFactLines are what else the page said of an element (decision
// 0184), a line for each part it gave, as `zero feedback show` prints
// them: where it is, what rendered it, how it looked, and the text around
// it. All of it is the page's word, in code spans.
export function elementFactLines(element: FeedbackElement): string[] {
  const lines: string[] = []
  if (element.path) lines.push(`Path: ${codeSpan(element.path)}`)
  if (element.component && element.source) lines.push(`Component: ${codeSpan(element.component)} · source ${codeSpan(element.source)}`)
  else if (element.component) lines.push(`Component: ${codeSpan(element.component)}`)
  else if (element.source) lines.push(`Source: ${codeSpan(element.source)}`)
  if (element.classes) lines.push(`Classes: ${codeSpan(element.classes)}`)
  if (element.attributes?.length) lines.push(`Attributes: ${pairSpans(element.attributes, "=")}`)
  if (element.styles?.length) lines.push(`Styles (computed): ${pairSpans(element.styles, ": ")}`)
  if (element.nearby) lines.push(`Nearby text: ${codeSpan(element.nearby)}`)
  if (element.selectedText) lines.push(`Selected text: ${codeSpan(element.selectedText)}`)
  return lines
}

// visualHeading is a visual thread's place in its Markdown heading:
// "screenshot · <url>", with " (not stored)" once the screenshot is gone.
export function visualHeading(visual: FeedbackVisual): string {
  return `screenshot${visual.available ? "" : " (not stored)"}${visual.page ? ` · ${codeSpan(visual.page.url)}` : ""}`
}

const localhostLines: Readonly<Record<NonNullable<FeedbackPage["localhost"]>, string>> = {
  project: "Localhost: this machine, where the project is; the URL opens as written",
  viewer: "Localhost: the reviewer's machine, not this one; the port may not reach the project",
}

// visualLines are a visual thread's lines under its Markdown heading
// (testdata/feedback/visual/show.md): the page and the color scheme it
// showed in, what its localhost names, the region in image, CSS, and
// document pixels, the element hint and its facts, the commit, and the
// command that reads the screenshot.
export function visualLines(feedbackId: string, visual: FeedbackVisual): string[] {
  const { attachment, element, head, page, rect } = visual
  const lines: string[] = []
  if (!page) lines.push("Page: none (pasted image)")
  if (page) {
    const { viewport, scroll } = page
    lines.push(`Page: ${[
      page.title ? codeSpan(page.title) : "",
      `viewport ${decimal(viewport.width)}×${decimal(viewport.height)} CSS px at ${decimal(viewport.deviceScaleFactor)}×`,
      `scrolled ${decimal(scroll.x)},${decimal(scroll.y)}`,
      page.colorScheme ? `${page.colorScheme} scheme` : "",
    ].filter(Boolean).join(" · ")}`)
    if (page.localhost) lines.push(localhostLines[page.localhost])
  }
  let region = `Region: image ${rectText(rect)} of ${attachment.width}×${attachment.height}`
  if (page) {
    const exact = imageToCSS(rect, page.clip ?? null, page.viewport.deviceScaleFactor)
    // Whole CSS pixels, as the CLI prints them.
    const css = { x: Math.round(exact.x), y: Math.round(exact.y), width: Math.round(exact.width), height: Math.round(exact.height) }
    region += ` · CSS ${rectText(css)} · document ${decimal(css.x + page.scroll.x)},${decimal(css.y + page.scroll.y)}`
  }
  lines.push(region)
  if (element) lines.push(`Element (page's hint, unverified): ${elementMarkdown(element)}`, ...elementFactLines(element))
  if (head) lines.push(`Code at: ${head}`)
  lines.push(visual.available
    ? `Screenshot: zero feedback attachment ${feedbackId} ${attachment.id} [--crop -o region.png]`
    : "Screenshot: not stored (dropped for the storage budget, or its file is missing); the region and page facts above still apply")
  return lines
}

// ScreenPage is the page a capture froze.
export interface ScreenPage {
  url: string
  title: string
  viewport: { width: number; height: number; deviceScaleFactor: number }
  scroll: { x: number; y: number }
  colorScheme?: FeedbackColorScheme
}

// ScreenHint is the page's word on the element a comment is about
// (decisions 0176, 0184), box in CSS pixels of the viewport.
export interface ScreenHint {
  tag: string
  selector?: string
  role?: string
  name?: string
  text?: string
  box?: FeedbackRect
  path?: string
  classes?: string
  attributes?: readonly FeedbackElementPair[]
  styles?: readonly FeedbackElementPair[]
  component?: string
  source?: string
  nearby?: string
  selectedText?: string
}

export type AttachMode = "region" | "full"

function oneLine(text: string, limit: number): string {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, limit).join("")
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

// oneLineBytes is text on one line, cut to whole characters within limit
// bytes of UTF-8.
function oneLineBytes(text: string, limit: number): string {
  let kept = ""
  let size = 0
  for (const character of text.replace(/\s+/g, " ").trim()) {
    size += byteLength(character)
    if (size > limit) break
    kept += character
  }
  return kept.trimEnd()
}

const tagPattern = /^[a-z][a-z0-9-]*$/
const pairNamePattern = /^[a-z][a-z0-9-]*$/

// The server's bounds on an element's facts (decision 0184).
const elementBounds = { attributes: 8, attributeValue: 256, styles: 24, styleValue: 128, pairName: 64 }

// pairsDraft keeps the pairs the server stores: a lowercase name, a value
// of one bounded line, at most count of them. A field's value is never
// sent (decision 0176).
function pairsDraft(pairs: readonly FeedbackElementPair[] | undefined, count: number, valueLimit: number): FeedbackElementPair[] {
  return (pairs ?? [])
    .filter((pair) => pairNamePattern.test(pair.name) && pair.name.length <= elementBounds.pairName && pair.name !== "value")
    .slice(0, count)
    .map((pair) => ({ name: pair.name, value: oneLine(pair.value, valueLimit) }))
}

// elementDraft bounds an element hint as the server stores it and moves
// its box into the image; null when the hint cannot be stored or its box
// falls outside the image (the page no longer matches the capture). A
// selector the server would refuse is left out: a cut one finds nothing.
export function elementDraft(hint: ScreenHint, clip: FeedbackRect | null, deviceScaleFactor: number, image: Size): FeedbackElement | null {
  const tag = hint.tag.toLowerCase()
  if (!tagPattern.test(tag) || tag.length > 32) return null
  const element: FeedbackElement = { tag }
  const selector = hint.selector?.trim() ?? ""
  if (selector && !/[\r\n]/.test(selector) && byteLength(selector) <= 512) element.selector = selector
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
  const path = hint.path ? oneLineBytes(hint.path, 512) : ""
  const classes = hint.classes ? oneLineBytes(hint.classes, 256) : ""
  const attributes = pairsDraft(hint.attributes, elementBounds.attributes, elementBounds.attributeValue)
  const styles = pairsDraft(hint.styles, elementBounds.styles, elementBounds.styleValue)
  const component = hint.component ? oneLine(hint.component, 256) : ""
  const source = hint.source ? oneLineBytes(hint.source, 512) : ""
  const nearby = hint.nearby ? oneLine(hint.nearby, 256) : ""
  const selectedText = hint.selectedText ? oneLine(hint.selectedText, 256) : ""
  if (path) element.path = path
  if (classes) element.classes = classes
  if (attributes.length > 0) element.attributes = attributes
  if (styles.length > 0) element.styles = styles
  if (component) element.component = component
  if (source) element.source = source
  if (nearby) element.nearby = nearby
  if (selectedText) element.selectedText = selectedText
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
    colorScheme?: FeedbackColorScheme
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
    page: {
      url: page.url.trim(), ...(title ? { title } : {}), viewport: page.viewport, scroll: page.scroll, ...(clip ? { clip } : {}),
      ...(page.colorScheme ? { colorScheme: page.colorScheme } : {}),
    },
  }
  const element = hint ? elementDraft(hint, clip, dsf, image) : null
  if (element) plan.element = element
  return plan
}
