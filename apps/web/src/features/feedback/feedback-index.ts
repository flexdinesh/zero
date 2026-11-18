import type { Feedback, FeedbackAnchor, FeedbackCompare, FeedbackLocation, FeedbackMessage, FeedbackThread } from "@zero/contracts"

export interface FeedbackFileThreads {
  readonly all: readonly FeedbackThread[]
  readonly open: readonly FeedbackThread[]
  readonly outdatedAll: number
  readonly outdatedOpen: number
}

const emptyThreads: readonly FeedbackThread[] = Object.freeze([])
export const emptyFeedbackFile: FeedbackFileThreads = Object.freeze({
  all: emptyThreads, open: emptyThreads, outdatedAll: 0, outdatedOpen: 0,
})

export interface FeedbackIndex {
  readonly feedback: Feedback
  readonly files: ReadonlyMap<string, FeedbackFileThreads>
  readonly counts: ReadonlyMap<string, number>
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

function sameLocation(a: FeedbackLocation, b: FeedbackLocation): boolean {
  return a === b || (a.state === b.state && a.path === b.path && a.side === b.side && sameArray(a.lines, b.lines))
}

function sameMessage(a: FeedbackMessage, b: FeedbackMessage): boolean {
  return a === b || (a.number === b.number && a.author === b.author && a.name === b.name && a.status === b.status
    && a.createdAt === b.createdAt && a.body === b.body && a.bodyHTML === b.bodyHTML)
}

function sameThread(a: FeedbackThread, b: FeedbackThread): boolean {
  return a === b || (a.number === b.number && a.status === b.status && a.awaiting === b.awaiting
    && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && sameLocation(a.location, b.location)
    && sameAnchor(a.anchor, b.anchor) && (a.messages === b.messages || (a.messages.length === b.messages.length
      && a.messages.every((message, i) => sameMessage(message, b.messages[i])))))
}

// Keep matching prefixes in the previous list. An unchanged file allocates
// no replacement thread arrays and needs no second pass to compare them.
class ThreadList {
  private readonly previous: readonly FeedbackThread[]
  private changed?: FeedbackThread[]
  length = 0

  constructor(previous: readonly FeedbackThread[]) {
    this.previous = previous
  }

  append(thread: FeedbackThread): void {
    if (!this.changed && this.previous[this.length] !== thread) this.changed = this.previous.slice(0, this.length)
    this.changed?.push(thread)
    this.length++
  }

  finish(): readonly FeedbackThread[] {
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

export function indexFeedback(feedback: Feedback, previous?: FeedbackIndex): FeedbackIndex {
  if (previous?.feedback.id !== feedback.id || previous.feedback.project !== feedback.project
    || previous.feedback.branch !== feedback.branch) previous = undefined
  const byNumber = new Map<number, FeedbackThread>()
  const threads: FeedbackThread[] = []
  let unchanged = previous?.feedback.threads.length === feedback.threads.length
  const groups = new Map<string, FileGroup>()
  for (const incoming of feedback.threads) {
    const known = previous?.byNumber.get(incoming.number)
    const thread = known && sameThread(known, incoming) ? known : incoming
    if (previous?.feedback.threads[threads.length] !== thread) unchanged = false
    threads.push(thread)
    byNumber.set(thread.number, thread)
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
    byNumber,
  }
}
