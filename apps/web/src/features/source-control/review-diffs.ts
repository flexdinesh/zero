import type { FileDiffMetadata } from "@pierre/diffs"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { isDiffResponse, type DiffResponse, type LineDiff } from "@zero/contracts"
import { failureReason, fetchJSON, RequestError, type RequestFailure } from "../../api/http.ts"
import type { Compare } from "./compare.ts"
import type { CompareFile } from "./compare-files.ts"
import { diffContent, type DiffContent } from "./diff-content.ts"
import { fileDiffMetadata } from "./diff-metadata.ts"
import { reviewCache } from "./review-cache.ts"
import { sameDiffContent } from "./same-diff-content.ts"

// A review tab reads each file's diff when its section nears the viewport
// (decision 0035). The server computes each diff's hunks (decision 0083);
// visited diffs stay with the mounted review so Pierre keeps its layout.

// A RenderedDiff is a text diff Pierre shows and the server's line diff it
// was laid out from, which places selections and steps.
export interface RenderedDiff {
  fileDiff: FileDiffMetadata
  lineDiff: LineDiff
}

export type ReviewDiff =
  | { kind: "loading" }
  // missingLineDiff: text sides came without a line diff, so none shows.
  | { kind: "ready"; diff: DiffResponse; content: DiffContent; rendered: RenderedDiff | null; missingLineDiff: boolean }
  // unchanged: the file no longer differs, e.g. a branch dropped it.
  | { kind: "unchanged"; message: string }
  | { kind: "error"; message: string }

// diffError keeps the server's own sentence; other failures say what failed.
function diffError(failure: RequestFailure): string {
  return failure.kind === "rejected" ? failure.error : `Couldn't load this diff: ${failureReason(failure)}.`
}

export function diffUrl(project: string, compare: Compare, file: CompareFile, ignoreWhitespace: boolean): string {
  const params = new URLSearchParams({ project, path: file.path })
  if (file.oldPath) params.set("oldPath", file.oldPath)
  if (compare.kind === "commit") params.set("commit", compare.hash)
  if (compare.kind === "branch") {
    params.set("branch", "1")
    if (compare.base) params.set("base", compare.base)
    if (compare.head) params.set("head", compare.head)
    if (compare.uncommitted) params.set("uncommitted", "1")
  }
  if (compare.kind === "range") {
    params.set("from", compare.from)
    params.set("to", compare.to)
  }
  if (ignoreWhitespace) params.set("ignoreWhitespace", "1")
  return `/api/diff?${params.toString()}`
}

async function readDiff(url: string, signal: AbortSignal, previous?: ReviewDiff): Promise<ReviewDiff> {
  let diff: DiffResponse
  try {
    diff = await fetchJSON(url, { signal }, isDiffResponse, diffError)
  } catch (error: unknown) {
    if (!(error instanceof RequestError)) throw error
    // Code "unchanged": the file matches again, or the branch no longer changes it.
    return error.failure.kind === "rejected" && error.failure.code === "unchanged"
      ? { kind: "unchanged", message: error.message }
      : { kind: "error", message: error.message }
  }
  // Pierre treats a new fileDiff object as new content and discards its
  // measured layout and expanded gaps. An unchanged read is not new content.
  if (previous?.kind === "ready" && sameDiffContent(previous.diff, diff)) {
    return { ...previous, diff }
  }
  const content = diffContent(diff)
  if (content.kind !== "text" || (!content.oldFile && !content.newFile)) {
    return { kind: "ready", diff, content, rendered: null, missingLineDiff: false }
  }
  if (!diff.lineDiff) return { kind: "ready", diff, content, rendered: null, missingLineDiff: true }
  const rendered = { fileDiff: fileDiffMetadata(content.oldFile, content.newFile, diff.lineDiff), lineDiff: diff.lineDiff }
  return { kind: "ready", diff, content, rendered, missingLineDiff: false }
}

interface ReviewDiffSource {
  project: string
  compare: Compare
  file: CompareFile
  // version names the list read: live compares reread diffs when it changes;
  // "" for commits, which never change. Stats arriving for the same read do
  // not change it.
  version: string
  ignoreWhitespace: boolean
}

interface ReviewDiffOptions extends ReviewDiffSource {
  // wanted is false while the section is collapsed or far from view.
  wanted: boolean
}

function diffRevision(version: string, ignoreWhitespace: boolean): string {
  return `${version}\n${ignoreWhitespace}`
}

// Each mounted review owns its data. Replacing or closing that review lets
// the entire store go; no global cache or second eviction lifecycle exists.
export function createReviewDiffs() {
  const cache = reviewCache<{ revision: string; diff: ReviewDiff }>()
  const reads = new Map<string, symbol>()
  return {
    get: cache.get,
    subscribe: cache.subscribe,
    // peek is source's diff read at its revision, null when not yet read.
    peek(source: ReviewDiffSource): ReviewDiff | null {
      const cached = cache.get(diffUrl(source.project, source.compare, source.file, false))
      return cached?.revision === diffRevision(source.version, source.ignoreWhitespace) ? cached.diff : null
    },
    async load(source: ReviewDiffSource, signal: AbortSignal): Promise<ReviewDiff> {
      signal.throwIfAborted()
      const key = diffUrl(source.project, source.compare, source.file, false)
      const revision = diffRevision(source.version, source.ignoreWhitespace)
      const cached = cache.get(key)
      if (cached?.revision === revision && cached.diff.kind !== "error") return cached.diff
      const read = Symbol()
      reads.set(key, read)
      try {
        const url = diffUrl(source.project, source.compare, source.file, source.ignoreWhitespace)
        const diff = await readDiff(url, signal, cached?.diff)
        signal.throwIfAborted()
        // A change-step read may overlap a newer refresh of the same file.
        if (reads.get(key) === read) cache.set(key, { revision, diff })
        return diff
      } finally {
        if (reads.get(key) === read) reads.delete(key)
      }
    },
  }
}

export type ReviewDiffs = ReturnType<typeof createReviewDiffs>

// useReviewDiff reads one file's diff while wanted.
export function useReviewDiff(diffs: ReviewDiffs, { project, compare, file, version, ignoreWhitespace, wanted }: ReviewDiffOptions) {
  const key = diffUrl(project, compare, file, false)
  const subscribe = useCallback((listener: () => void) => diffs.subscribe(key, listener), [diffs, key])
  const snapshot = useCallback(() => diffs.get(key), [diffs, key])
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!wanted || !project) return
    const controller = new AbortController()
    void diffs.load({ project, compare, file, version, ignoreWhitespace }, controller.signal).catch(() => {
      // Aborted by scrolling away, a newer read, or unmount.
    })
    return () => controller.abort()
  }, [attempt, compare, diffs, file, ignoreWhitespace, project, version, wanted])

  const retry = () => setAttempt((count) => count + 1)
  // A reread (new content or whitespace option) keeps the last diff shown
  // until it lands, so sections keep their height and the review its scroll.
  const diff: ReviewDiff = entry?.diff ?? { kind: "loading" }
  return { diff, retry }
}
