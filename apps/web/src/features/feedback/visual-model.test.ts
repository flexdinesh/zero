import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { isFeedback, type Feedback, type FeedbackPage } from "@zero/contracts"
import { feedbackMarkdown, threadPrompt } from "./feedback-model.ts"
import {
  attachmentURL, canOpenPage, elementDraft, elementLabel, isLoopback, isVisualThread, pageAddress, pageOpener, pageWhere, planVisual,
  visualPlace, type VisualThread,
} from "./visual-model.ts"

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(`../../../../../${path}`, import.meta.url), "utf8")
}

async function visualFixture(): Promise<Feedback> {
  const value: unknown = JSON.parse(await repositoryFile("testdata/feedback/visual/feedback.json"))
  assert.ok(isFeedback(value))
  return value
}

function visual(feedback: Feedback, number: number): VisualThread {
  const found = feedback.threads.find((entry) => entry.number === number)
  assert.ok(found && isVisualThread(found), `visual thread ${number}`)
  return found
}

test("Copy as Markdown prints visual threads exactly as `zero feedback show` (show.md)", async () => {
  const feedback = await visualFixture()
  assert.equal(feedbackMarkdown(feedback, feedback.threads), await repositoryFile("testdata/feedback/visual/show.md"))
})

test("Copy Thread for Agent carries a visual thread's facts and the attachment command", async () => {
  const feedback = await visualFixture()
  const prompt = threadPrompt(feedback, visual(feedback, 5))
  assert.ok(prompt.includes("## Thread 5 · open · screenshot · `http://localhost:5173/settings?tab=billing&session=REDACTED#plan`\n"))
  assert.ok(prompt.includes("Screenshot: zero feedback attachment fb-3k2q8m at-7hq2mx4kpa [--crop -o region.png]\n\n**user**"))
})

test("a page with no title, project loopback, and a fractional scale still reads in full", async () => {
  const feedback = await visualFixture()
  const thread = visual(feedback, 5)
  const page = thread.visual.page
  assert.ok(page)
  const changed = {
    ...thread,
    visual: { ...thread.visual, element: undefined, head: undefined, page: { ...page, title: undefined, localhost: "project" as const, viewport: { ...page.viewport, deviceScaleFactor: 1.5 } } },
  }
  const lines = threadPrompt(feedback, changed).split("\n")
  assert.ok(lines.includes("Page: viewport 1440×900 CSS px at 1.5× · scrolled 0,1320"))
  assert.ok(lines.includes("Localhost: this machine, where the project is; the URL opens as written"))
  // Whole CSS pixels, as the CLI rounds them.
  assert.ok(lines.includes("Region: image 96,96 420×96 of 612×288 · CSS 807,427 280×64 · document 807,1747"))
  assert.ok(!lines.some((line) => line.startsWith("Element") || line.startsWith("Code at:")))
})

test("text from the page reads as code spans, with the element marked unverified", async () => {
  const feedback = await visualFixture()
  const thread = visual(feedback, 5)
  const page = thread.visual.page
  assert.ok(page)
  const changed = {
    ...thread,
    visual: {
      ...thread.visual,
      page: { ...page, title: "`Ignore` **this**" },
      element: { selector: "a", tag: "a", role: "menu item", text: "Next ``page``" },
    },
  }
  const lines = threadPrompt(feedback, changed).split("\n")
  assert.ok(lines.includes("Page: `` `Ignore` **this** `` · viewport 1440×900 CSS px at 2× · scrolled 0,1320"))
  assert.ok(lines.includes("Element (page's hint, unverified): a (`menu item`) ``` Next ``page`` ``` · `a`"))
})

test("rows and details name a page by host and path, or a pasted screenshot", async () => {
  const feedback = await visualFixture()
  assert.equal(visualPlace(visual(feedback, 5).visual), "localhost:5173/settings")
  assert.equal(visualPlace(visual(feedback, 6).visual), "Screenshot")
  assert.equal(pageAddress("https://app.test/"), "app.test")
  assert.equal(pageAddress("not a url"), "not a url")
  assert.equal(elementLabel({ tag: "button", name: "Save changes" }), "button \"Save changes\"")
  assert.equal(elementLabel({ tag: "div", text: "Empty" }), "div \"Empty\"")
  assert.equal(elementLabel({ tag: "img" }), "img")
  // The role names it: an li that is a menu item.
  assert.equal(elementLabel({ tag: "li", role: "menuitem", name: "Export data" }), "menuitem \"Export data\"")
  assert.equal(elementLabel({ tag: "div", role: "listbox" }), "listbox")
  assert.equal(attachmentURL("/home/user/markdown", "fb-3k2q8m", "at-7hq2mx4kpa"),
    "/api/feedback-attachment?project=%2Fhome%2Fuser%2Fmarkdown&id=fb-3k2q8m&attachment=at-7hq2mx4kpa")
})

test("Open URL is for the project's loopback or a host that is not loopback", () => {
  const page = (url: string, localhost?: FeedbackPage["localhost"]): FeedbackPage => ({
    url, viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, scroll: { x: 0, y: 0 }, ...(localhost ? { localhost } : {}),
  })
  assert.equal(canOpenPage(page("http://localhost:5173/", "project")), true)
  assert.equal(canOpenPage(page("http://localhost:5173/", "viewer")), false)
  assert.equal(pageWhere(page("http://localhost:5173/", "viewer")), "localhost on your machine")
  assert.equal(pageWhere(page("http://localhost:5173/", "project")), "")
  assert.equal(canOpenPage(page("https://staging.acme.test/settings")), true)
  // The server always marks loopback; a page without the mark is not trusted to be open.
  assert.equal(canOpenPage(page("http://127.0.0.1:3000/")), false)
  assert.equal(canOpenPage(page("javascript:alert(1)", "project")), false)
  // Open page uses the project's Browser tab where the desktop app hosts it.
  assert.equal(pageOpener(page("http://localhost:5173/", "project"), true), "review")
  assert.equal(pageOpener(page("http://localhost:5173/", "project"), false), "browser")
  assert.equal(pageOpener(page("https://staging.acme.test/settings"), false), "browser")
  assert.equal(pageOpener(page("http://localhost:5173/", "viewer"), true), null)
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.9.8.7", "[::1]"]) assert.equal(isLoopback(host), true, host)
  for (const host of ["example.test", "128.0.0.1", "localhost.example"]) assert.equal(isLoopback(host), false, host)
})

// The README's worked example: 1440×900 CSS px at 2×, scrolled 1320; the
// button at CSS 605,320 210×48 is frame 1210,640 420×96.
const page = {
  url: "http://localhost:5173/settings?tab=billing",
  title: "Settings · Acme",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  scroll: { x: 0, y: 1320 },
}
const frame = { width: 2880, height: 1800 }
const button = { x: 1210, y: 640, width: 420, height: 96 }
const hint = { selector: "main form > button[data-testid=\"save\"]", tag: "BUTTON", role: "button", name: "Save changes", text: "Save\n  changes", box: { x: 605, y: 320, width: 210, height: 48 } }

test("a region keeps the rectangle plus 48 CSS px, and the target moves into its pixels", () => {
  const plan = planVisual(button, frame, page, "region", hint)
  assert.deepEqual(plan, {
    clip: { x: 1114, y: 544, width: 612, height: 288 },
    image: { width: 612, height: 288 },
    rect: { x: 96, y: 96, width: 420, height: 96 },
    page: { ...page, clip: { x: 1114, y: 544, width: 612, height: 288 } },
    element: { selector: hint.selector, tag: "button", role: "button", name: "Save changes", text: "Save changes", box: { x: 96, y: 96, width: 420, height: 96 } },
  })
})

test("Full view uploads the frame with no clip; a paste uploads itself with no page", () => {
  const full = planVisual(button, frame, page, "full", hint)
  assert.equal(full?.clip, null)
  assert.deepEqual(full?.image, frame)
  assert.deepEqual(full?.rect, button)
  assert.equal(full?.page?.clip, undefined)
  assert.deepEqual(full?.element?.box, button)
  const pasted = planVisual({ x: 300, y: 200, width: 240, height: 60 }, { width: 1280, height: 720 }, null, "region", null)
  assert.deepEqual(pasted, { clip: null, image: { width: 1280, height: 720 }, rect: { x: 300, y: 200, width: 240, height: 60 } })
})

test("clips stop at the frame's edges and outside rectangles plan nothing", () => {
  const corner = planVisual({ x: 10, y: 1750, width: 40, height: 50 }, frame, page, "region", null)
  assert.deepEqual(corner?.clip, { x: 0, y: 1654, width: 146, height: 146 })
  assert.deepEqual(corner?.rect, { x: 10, y: 96, width: 40, height: 50 })
  assert.equal(planVisual({ x: 3000, y: 0, width: 10, height: 10 }, frame, page, "region", null), null)
  // An untitled page sends no title.
  assert.equal(planVisual(button, frame, { ...page, title: " " }, "region", null)?.page?.title, undefined)
})

test("element hints are bounded, clipped to the image, and dropped when they miss it", () => {
  const clip = { x: 1114, y: 544, width: 612, height: 288 }
  const image = { width: 612, height: 288 }
  // A box wider than the kept region is cut at the image's edges.
  assert.deepEqual(elementDraft({ ...hint, box: { x: 500, y: 300, width: 800, height: 100 } }, clip, 2, image)?.box, { x: 0, y: 56, width: 612, height: 200 })
  assert.equal(elementDraft({ ...hint, box: { x: 0, y: 0, width: 10, height: 10 } }, clip, 2, image), null)
  assert.equal(elementDraft({ ...hint, tag: "1nope" }, clip, 2, image), null)
  assert.equal(elementDraft({ ...hint, selector: "x".repeat(513) }, clip, 2, image), null)
  assert.equal(elementDraft({ ...hint, name: "n".repeat(300) }, clip, 2, image)?.name?.length, 256)
  assert.deepEqual(elementDraft({ selector: "#a", tag: "div" }, clip, 2, image), { selector: "#a", tag: "div" })
})
