import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { Feedback, FeedbackCompare, FeedbackStatus, FeedbackSummary, FeedbackThread } from "@zero/contracts"
import {
  createFeedbackThread, deleteFeedback, deleteFeedbackThread, feedbackUrl, fetchFeedback, fetchFeedbackList, isFeedbackMissing,
  postFeedbackMessage, uploadFeedbackAttachment, type FeedbackQuery, type FeedbackVisualDraft,
} from "../../api/feedback-data.ts"
import { isAbort } from "../../api/http.ts"
import { experimentalEnabled } from "../../lib/desktop-bridge.ts"
import { indexFeedback, shownFeedback, type FeedbackIndex } from "./feedback-index.ts"
import type { FeedbackAnchorInput } from "./feedback-model.ts"

export type FeedbackLoad =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "missing" }
  | { kind: "error"; message: string }

export interface FeedbackOptions {
  project: string
  // id names the feedback; "" reads the compare's head branch's, else HEAD's.
  id: string
  // compare is what locations resolve against; null for the working tree.
  compare: FeedbackCompare | null
  // version rereads when it changes: a feedback event, a change on disk, or
  // a write elsewhere on the page.
  version: number
  enabled: boolean
  // onChanged reports a write, so other readers on the page reread.
  onChanged(): void
}

export interface FeedbackActions {
  // start opens a thread with its first message at anchor.
  start(anchor: FeedbackAnchorInput, body: string): Promise<FeedbackThread>
  // startVisual uploads png, then opens a visual thread on it (decision
  // 0176); the target's rectangles are in png's pixels.
  startVisual(png: Blob, visual: Omit<FeedbackVisualDraft, "attachment">, body: string): Promise<FeedbackThread>
  // reply adds a message, a status change, or both.
  reply(thread: number, body: string, status?: FeedbackStatus): Promise<FeedbackThread>
  removeThread(thread: number): Promise<void>
  removeFeedback(): Promise<void>
}

// FeedbackSession keeps the last read and its index while it rereads.
export interface FeedbackSession {
  load: FeedbackLoad
  feedback: Feedback | null
  index: FeedbackIndex | null
  actions: FeedbackActions
  retry(): void
}

interface FeedbackRead {
  key: string
  query: FeedbackQuery
  load: FeedbackLoad
  feedback: Feedback | null
  index: FeedbackIndex | null
}

function pending(key: string, query: FeedbackQuery): FeedbackRead {
  return { key, query, load: { kind: "loading" }, feedback: null, index: null }
}

function withFeedback(previous: FeedbackRead, feedback: Feedback): FeedbackRead {
  const index = indexFeedback(shownFeedback(feedback, experimentalEnabled()), previous.index ?? undefined)
  return index === previous.index ? previous : { ...previous, feedback: index.feedback, index }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

// withThread replaces or appends a thread the server returned.
function withThread(feedback: Feedback, thread: FeedbackThread): Feedback {
  const exists = feedback.threads.some((entry) => entry.number === thread.number)
  return {
    ...feedback,
    threads: exists ? feedback.threads.map((entry) => entry.number === thread.number ? thread : entry) : [...feedback.threads, thread],
    updatedAt: thread.updatedAt,
  }
}

// useFeedback reads one branch's feedback (decision 0120) and writes to it.
// Writes update the threads in place, then ask the page to reread.
export function useFeedback({ compare, enabled, id, onChanged, project, version }: FeedbackOptions): FeedbackSession {
  const key = useMemo(() => feedbackUrl({ project, id, compare }), [compare, id, project])
  const [state, setState] = useState(() => pending(key, { project, id, compare }))
  // Each visit owns a query, even when returning to the same URL.
  if (state.key !== key) setState(pending(key, { project, id, compare }))
  const { query } = state
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled || !query.project) return
    const controller = new AbortController()
    setState((previous) => previous.query === query && !previous.feedback && previous.load.kind !== "loading"
      ? { ...previous, load: { kind: "loading" } } : previous)
    fetchFeedback(query, controller.signal).then((feedback) => {
      if (controller.signal.aborted) return
      setState((previous) => {
        if (previous.query !== query) return previous
        const next = withFeedback(previous, feedback)
        return next.load.kind === "ready" ? next : { ...next, load: { kind: "ready" } }
      })
    }, (error: unknown) => {
      if (controller.signal.aborted || isAbort(error)) return
      const load: FeedbackLoad = isFeedbackMissing(error) ? { kind: "missing" } : { kind: "error", message: message(error, "Couldn't read feedback.") }
      setState((previous) => previous.query !== query ? previous
        : load.kind === "missing" ? { ...previous, load, feedback: null, index: null } : { ...previous, load })
    })
    return () => controller.abort()
  }, [attempt, enabled, query, version])

  const feedback = enabled ? state.feedback : null
  const known = feedback?.id || query.id
  // Before the first thread, only the branch distinguishes empty responses.
  const emptyBranch = known ? undefined : feedback?.branch
  const changed = useRef(onChanged)
  useLayoutEffect(() => { changed.current = onChanged }, [onChanged])

  const actions = useMemo<FeedbackActions>(() => {
    const apply = (update: (current: Feedback) => Feedback) => {
      setState((previous) => previous.query === query && previous.feedback?.id === known && (known || previous.feedback.branch === emptyBranch)
        ? withFeedback(previous, update(previous.feedback)) : previous)
      changed.current()
    }
    return {
      async start(anchor, body) {
        const thread = await createFeedbackThread({
          project: query.project,
          ...(known ? { id: known } : {}),
          ...(anchor.compare ? { compare: anchor.compare } : {}),
          path: anchor.path,
          side: anchor.side,
          ...(anchor.lines ? { lines: [anchor.lines[0], anchor.lines[1]] } : {}),
          body,
        })
        apply((current) => withThread(current, thread))
        return thread
      },
      async startVisual(png, visual, body) {
        const upload = await uploadFeedbackAttachment(query.project, png)
        const thread = await createFeedbackThread({
          project: query.project,
          ...(known ? { id: known } : {}),
          visual: { attachment: upload.id, ...visual },
          body,
        })
        apply((current) => withThread(current, thread))
        return thread
      },
      async reply(thread, body, status) {
        const updated = await postFeedbackMessage({
          project: query.project, id: known, thread, ...(body ? { body } : {}), ...(status ? { status } : {}),
        })
        apply((current) => withThread(current, updated))
        return updated
      },
      async removeThread(thread) {
        await deleteFeedbackThread(query.project, known, thread)
        apply((current) => ({ ...current, threads: current.threads.filter((entry) => entry.number !== thread) }))
      },
      async removeFeedback() {
        if (!known) return
        await deleteFeedback(query.project, known)
        changed.current()
      },
    }
  }, [emptyBranch, known, query])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  return useMemo((): FeedbackSession => ({
    load: enabled ? state.load : { kind: "idle" }, feedback, index: enabled ? state.index : null, actions, retry,
  }), [actions, enabled, feedback, retry, state.index, state.load])
}

export interface FeedbackList {
  result: FeedbackSummary[] | null
  error: string
}

// useFeedbackList lists the repository's feedback, one per branch, while
// wanted, again whenever version changes.
export function useFeedbackList(project: string, wanted: boolean, version: number): FeedbackList {
  const [state, setState] = useState<FeedbackList & { project: string }>({ project: "", result: null, error: "" })
  useEffect(() => {
    if (!wanted || !project) return
    const controller = new AbortController()
    fetchFeedbackList(project, controller.signal).then((result) => {
      if (!controller.signal.aborted) setState({ project, result, error: "" })
    }, (error: unknown) => {
      if (controller.signal.aborted || isAbort(error)) return
      setState((previous) => ({ project, result: previous.project === project ? previous.result : null, error: message(error, "Couldn't list feedback.") }))
    })
    return () => controller.abort()
  }, [project, version, wanted])
  return state.project === project ? { result: state.result, error: state.error } : { result: null, error: "" }
}
