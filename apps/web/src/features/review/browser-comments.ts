// Pure model of the comments on the Browser's page (decision 0184): which
// visual threads belong to the page that shows, the pins the desktop app
// draws for them, their rows in the Browser view, and whether a project
// shows its pins.

import type { FeedbackPage, FeedbackThread } from "@zero/contracts"

import type { BrowserPin } from "../../lib/desktop-bridge.ts"
import { isClosed, threadTitle } from "../feedback/feedback-model.ts"
import { imageToCSS } from "../feedback/visual-geometry.ts"
import { elementLabel, isVisualThread, type VisualThread } from "../feedback/visual-model.ts"
import { samePage } from "./review-model.ts"

// PageThread is a visual thread captured from a page.
export type PageThread = VisualThread & { visual: { page: FeedbackPage } }

function onPage(thread: FeedbackThread): thread is PageThread {
  return isVisualThread(thread) && thread.visual.page !== undefined
}

// pageThreads lists the threads of the page at url: the open ones, then the
// closed ones, each by number. A thread belongs to a page by origin and
// path, and the hash when it is a route; the query is ignored.
export function pageThreads(threads: readonly FeedbackThread[], url: string): PageThread[] {
  return threads.filter(onPage)
    .filter((thread) => samePage(thread.visual.page.url, url))
    .sort((left, right) => Number(isClosed(left.status)) - Number(isClosed(right.status)) || left.number - right.number)
}

// openCount counts the threads still open.
export function openCount(threads: readonly FeedbackThread[]): number {
  return threads.filter((thread) => !isClosed(thread.status)).length
}

// pagePin is a thread's pin: on its element when the page gave a selector,
// else at the top right corner of its rectangle in document CSS pixels
// (the rectangle in the viewport, plus the scroll it was captured at).
export function pagePin(thread: PageThread): BrowserPin {
  const { element, page, rect } = thread.visual
  const css = imageToCSS(rect, page.clip ?? null, page.viewport.deviceScaleFactor)
  return {
    thread: thread.number,
    resolved: isClosed(thread.status),
    ...(element?.selector ? { selector: element.selector } : {}),
    x: Math.round(css.x + css.width + page.scroll.x),
    y: Math.round(css.y + page.scroll.y),
  }
}

// CommentRow is a thread's row under "On this page".
export interface CommentRow {
  number: number
  closed: boolean
  // name is what was picked: `button "Save changes"`, or "Region".
  name: string
  // title is the comment's first line.
  title: string
  // address is the thread's whole stored address when it is not the one
  // that shows (the same page under another query); "" otherwise.
  address: string
}

function sameAddress(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href
  } catch {
    return left === right
  }
}

// commentRow reads a thread's row for the page showing at url.
export function commentRow(thread: PageThread, url: string): CommentRow {
  const { element, page } = thread.visual
  return {
    number: thread.number,
    closed: isClosed(thread.status),
    name: element ? elementLabel(element) : "Region",
    title: threadTitle(thread),
    address: sameAddress(page.url, url) ? "" : page.url,
  }
}

// PinsHidden is the projects whose pins are hidden, oldest first, as
// zero-browser-pins-hidden stores them. Pins show by default.
export type PinsHidden = readonly string[]

export const pinsStorageKey = "zero-browser-pins-hidden"
const pinsProjects = 50

export function parsePinsHidden(value: unknown): PinsHidden {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((project): project is string => typeof project === "string" && project !== ""))].slice(-pinsProjects)
}

// pinsShown reports whether project shows its pins.
export function pinsShown(hidden: PinsHidden, project: string): boolean {
  return !hidden.includes(project)
}

// withPinsShown records project's choice; the oldest hidden projects go
// first past the limit.
export function withPinsShown(hidden: PinsHidden, project: string, shown: boolean): PinsHidden {
  const rest = hidden.filter((each) => each !== project)
  return shown ? rest : [...rest, project].slice(-pinsProjects)
}
