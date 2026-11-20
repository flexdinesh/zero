import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { isFeedback, type Feedback, type FeedbackThread } from "@zero/contracts"
import { commentRow, openCount, pagePin, pageThreads, parsePinsHidden, pinsShown, withPinsShown } from "./browser-comments.ts"

async function visualFixture(): Promise<Feedback> {
  const text = await readFile(new URL("../../../../../testdata/feedback/visual/feedback.json", import.meta.url), "utf8")
  const value: unknown = JSON.parse(text)
  assert.ok(isFeedback(value))
  return value
}

const shown = "http://localhost:5173/settings"

// onSettings is thread 5 again under another number, status, and address.
function onSettings(base: FeedbackThread, number: number, change: { status?: FeedbackThread["status"]; url?: string; selector?: boolean } = {}): FeedbackThread {
  assert.ok(base.visual?.page && base.visual.element)
  const { selector, ...element } = base.visual.element
  return {
    ...base, number, status: change.status ?? "open",
    visual: {
      ...base.visual,
      page: { ...base.visual.page, url: change.url ?? shown },
      element: change.selector === false ? element : { ...element, selector },
    },
  }
}

test("the page's threads are the visual ones captured on it, open first, each by number", async () => {
  const feedback = await visualFixture()
  const base = feedback.threads.find((thread) => thread.number === 5)
  assert.ok(base)
  const threads = [
    ...feedback.threads,
    onSettings(base, 12, { status: "resolved" }),
    onSettings(base, 11, { status: "wontfix" }),
    onSettings(base, 10),
    onSettings(base, 9, { url: "http://localhost:5173/billing" }),
  ]
  // Thread 5's stored address has a query and a fragment that is no route;
  // 1 is on code, 6 and 8 are pasted images, 7 and 9 are other pages.
  assert.deepEqual(pageThreads(threads, shown).map((thread) => thread.number), [5, 10, 11, 12])
  assert.equal(openCount(pageThreads(threads, shown)), 2)
  assert.deepEqual(pageThreads(threads, "http://localhost:5173/billing?plan=pro").map((thread) => thread.number), [9])
  assert.deepEqual(pageThreads(threads, ""), [])
  assert.deepEqual(pageThreads(threads, "http://localhost:5173/"), [])
})

test("a pin sits on its element's selector, else at the rectangle's top right corner in the document", async () => {
  const feedback = await visualFixture()
  const base = feedback.threads.find((thread) => thread.number === 5)
  assert.ok(base)
  const [open, closed] = pageThreads([base, onSettings(base, 6, { status: "resolved", selector: false })], shown)
  assert.ok(open && closed)
  // The README's worked example: the button at CSS 605,320 210×48, the page
  // scrolled 1320: its top right corner is document 815,1640.
  assert.deepEqual(pagePin(open), { thread: 5, resolved: false, selector: "main form > button[data-testid=\"save\"]", x: 815, y: 1640 })
  assert.deepEqual(pagePin(closed), { thread: 6, resolved: true, x: 815, y: 1640 })
  // A fractional scale rounds to whole CSS pixels: image 61,73 301×51 in
  // the clip at 400,300, at 1.25×, scrolled 240.
  const [docs] = pageThreads(feedback.threads, "http://127.0.0.1:3000/docs/getting-started")
  assert.ok(docs)
  assert.deepEqual(pagePin(docs), { thread: 7, resolved: false, selector: "nav a[href=\"/docs/getting-started\"]", x: 610, y: 538 })
})

test("a row names what was picked and the comment, and its address only when another one shows", async () => {
  const feedback = await visualFixture()
  const [thread] = pageThreads(feedback.threads, shown)
  assert.ok(thread)
  assert.deepEqual(commentRow(thread, shown), {
    number: 5, closed: false, name: "button \"Save changes\"",
    title: "Save overlaps the card edge at 1440 px. Keep it inside the card padding.",
    address: "http://localhost:5173/settings?tab=billing&session=REDACTED#plan",
  })
  assert.equal(commentRow(thread, "http://localhost:5173/settings?tab=billing&session=REDACTED#plan").address, "")
  const region: typeof thread = { ...thread, status: "resolved", visual: { ...thread.visual, element: undefined } }
  assert.equal(commentRow(region, shown).name, "Region")
  assert.equal(commentRow(region, shown).closed, true)
})

test("pins show by default, and each project remembers hiding them", () => {
  assert.deepEqual(parsePinsHidden(null), [])
  assert.deepEqual(parsePinsHidden(["/a", 3, "", "/a", "/b"]), ["/a", "/b"])
  let hidden = parsePinsHidden("nope")
  assert.equal(pinsShown(hidden, "/a"), true)
  hidden = withPinsShown(hidden, "/a", false)
  hidden = withPinsShown(hidden, "/a", false)
  assert.deepEqual(hidden, ["/a"])
  assert.equal(pinsShown(hidden, "/a"), false)
  assert.equal(pinsShown(hidden, "/b"), true)
  assert.deepEqual(withPinsShown(hidden, "/a", true), [])
  for (let index = 0; index < 60; index++) hidden = withPinsShown(hidden, `/p${index}`, false)
  assert.equal(hidden.length, 50)
  assert.equal(pinsShown(hidden, "/a"), true)
  assert.equal(pinsShown(hidden, "/p59"), false)
})
