import type { Feedback, FeedbackAnchor, FeedbackCompare, FeedbackLocation, FeedbackMessage, FeedbackThread, FeedbackVisual } from "@zero/contracts"
import { isCodeThread, type CodeThread } from "./feedback-model.ts"

// FeedbackFileThreads is one file's code threads; code-only views (review,
// Source) read only these, never visual threads (decision 0176).
export interface FeedbackFileThreads {
  readonly all: readonly CodeThread[]
  readonly open: readonly CodeThread[]
  readonly outdatedAll: number
  readonly outdatedOpen: number
}

const emptyThreads: readonly CodeThread[] = Object.freeze([])
export const emptyFeedbackFile: FeedbackFileThreads = Object.freeze({
  all: emptyThreads, open: emptyThreads, outdatedAll: 0, outdatedOpen: 0,
})

export interface FeedbackIndex {
  readonly feedback: Feedback
  readonly files: ReadonlyMap<string, FeedbackFileThreads>
  readonly counts: ReadonlyMap<string, number>
  // visualOpen counts open visual threads, which belong to no file.
  readonly visualOpen: number
  readonly byNumber: ReadonlyMap<number, FeedbackThread>
}

function sameArray<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((item, i) => item === b[i]))
}

function sameCompare(a: FeedbackCompare | undefined, b: FeedbackCompare | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.kind === b.kind && a.uncommitted === b.uncommitted
    && a.base === b.base && a.head === b.head && a.commit === b.commit && a.from === b.from && a.to === b.to)
}

function sameAnchor(a: FeedbackAnchor, b: FeedbackAnchor): boolean {
  return a === b || (a.path === b.path && a.side === b.side && a.blob === b.blob && a.language === b.language
    && sameArray(a.lines, b.lines) && sameCompare(a.compare, b.compare)
    && sameArray(a.text, b.text) && sameArray(a.before, b.before) && sameArray(a.after, b.after))
}

function sameAnchorOf(a: FeedbackAnchor | undefined, b: FeedbackAnchor | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && sameAnchor(a, b))
}

// A visual target never changes after creation but its availability; its
// small tree compares by value.
function sameVisual(a: FeedbackVisual | undefined, b: FeedbackVisual | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b))
}

function sameLocationOf(a: FeedbackLocation | undefined, b: FeedbackLocation | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && sameLocation(a, b))
}

function sameLocation(a: FeedbackLocation, b: FeedbackLocation): boolean {
  return a === b || (a.state === b.state && a.path === b.path && a.side === b.side && sameArray(a.lines, b.lines))
}

function sameMessage(a: FeedbackMessage, b: FeedbackMessage): boolean {
  return a === b || (a.number === b.number && a.author === b.author && a.name === b.name && a.status === b.status
    && a.createdAt === b.createdAt && a.body === b.body && a.bodyHTML === b.bodyHTML)
}

function sameThread(a: FeedbackThread, b: FeedbackThread): boolean {
  return a === b || (a.number === b.number && a.status === b.status && a.awaiting === b.awaiting
    && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && sameLocationOf(a.location, b.location)
    && sameAnchorOf(a.anchor, b.anchor) && sameVisual(a.visual, b.visual) && (a.messages === b.messages || (a.messages.length === b.messages.length
      && a.messages.every((message, i) => sameMessage(message, b.messages[i])))))
}

// Keep matching prefixes in the previous list. An unchanged file allocates
// no replacement thread arrays and needs no second pass to compare them.
class ThreadList {
  private readonly previous: readonly CodeThread[]
  private changed?: CodeThread[]
  length = 0

  constructor(previous: readonly CodeThread[]) {
    this.previous = previous
  }

  append(thread: CodeThread): void {
    if (!this.changed && this.previous[this.length] !== thread) this.changed = this.previous.slice(0, this.length)
    this.changed?.push(thread)
    this.length++
  }

  finish(): readonly CodeThread[] {
    if (this.length === 0) return emptyThreads
    if (this.changed) return this.changed
    return this.length === this.previous.length ? this.previous : this.previous.slice(0, this.length)
  }
}

interface FileGroup {
  previous: FeedbackFileThreads
  all: ThreadList
  open: ThreadList
  outdatedAll: number
  outdatedOpen: number
}

// shownFeedback is what a page shows of a read: where experimental features
// are off (visual false), visual threads are left out of every list, count,
// and badge (decision 0184).
export function shownFeedback(feedback: Feedback, visual: boolean): Feedback {
  if (visual || feedback.threads.every((thread) => thread.visual === undefined)) return feedback
  return { ...feedback, threads: feedback.threads.filter((thread) => thread.visual === undefined) }
}

export function indexFeedback(feedback: Feedback, previous?: FeedbackIndex): FeedbackIndex {
  if (previous?.feedback.id !== feedback.id || previous.feedback.project !== feedback.project
    || previous.feedback.branch !== feedback.branch) previous = undefined
  const byNumber = new Map<number, FeedbackThread>()
  const threads: FeedbackThread[] = []
  let unchanged = previous?.feedback.threads.length === feedback.threads.length
  const groups = new Map<string, FileGroup>()
  let visualOpen = 0
  for (const incoming of feedback.threads) {
    const known = previous?.byNumber.get(incoming.number)
    const thread = known && sameThread(known, incoming) ? known : incoming
    if (previous?.feedback.threads[threads.length] !== thread) unchanged = false
    threads.push(thread)
    byNumber.set(thread.number, thread)
    if (!isCodeThread(thread)) {
      if (thread.status === "open") visualOpen++
      continue
    }
    const { path, state } = thread.location
    let group = groups.get(path)
    if (!group) {
      const file = previous?.files.get(path) ?? emptyFeedbackFile
      group = { previous: file, all: new ThreadList(file.all), open: new ThreadList(file.open), outdatedAll: 0, outdatedOpen: 0 }
      groups.set(path, group)
    }
    if (state === "outdated") {
      group.outdatedAll++
      if (thread.status === "open") group.outdatedOpen++
    } else {
      group.all.append(thread)
      if (thread.status === "open") group.open.append(thread)
    }
  }

  if (previous && unchanged && previous.feedback.updatedAt === feedback.updatedAt && previous.feedback.createdAt === feedback.createdAt) return previous

  const files = new Map<string, FeedbackFileThreads>()
  const counts = new Map<string, number>()
  let countsMatch = true
  for (const [path, group] of groups) {
    const { previous: file, outdatedAll, outdatedOpen } = group
    const open = group.open.finish()
    const all = group.all.length === open.length ? open : group.all.finish()
    files.set(path, file.all === all && file.open === open && file.outdatedAll === outdatedAll && file.outdatedOpen === outdatedOpen
      ? file : { all, open, outdatedAll, outdatedOpen })
    const count = open.length + outdatedOpen
    if (count > 0) {
      counts.set(path, count)
      if (previous?.counts.get(path) !== count) countsMatch = false
    }
  }
  return {
    feedback: { ...feedback, threads },
    files,
    counts: countsMatch && previous?.counts.size === counts.size ? previous.counts : counts,
    visualOpen,
    byNumber,
  }
}
