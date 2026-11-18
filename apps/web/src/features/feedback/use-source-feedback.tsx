import { useCallback, useMemo } from "react"

import type { SourceComments, SourceZone } from "../documents/SourceDocument.tsx"
import type { LineRange } from "../../lib/line-selection.ts"
import { anchorKey, lineRange } from "./feedback-model.ts"
import { FeedbackComposer } from "./FeedbackComposer.tsx"
import { FeedbackThreadZone } from "./FeedbackThreadZone.tsx"
import { useFeedback } from "./use-feedback.ts"
import { useFeedbackComposer } from "./use-feedback-composer.ts"

export interface SourceFeedbackOptions {
  project: string
  // path is the Source tab's file; "" shows nothing.
  path: string
  // enabled while Source shows the working tree's text: not Preview,
  // Format, a snapshot, or a binary or too-large file.
  enabled: boolean
  version: number
  // showResolved is the View option: closed threads show inline.
  showResolved: boolean
  navigate(href: string): void
  onChanged(): void
  // onSubmitted follows a new thread: the selection it was made from clears.
  onSubmitted(): void
}

// useSourceFeedback reads the checkout's feedback, resolved against the
// working tree, and places the file's new-side threads and the comment
// composer as zones in Source (decision 0120). Source threads have no
// compare.
export function useSourceFeedback({
  enabled, navigate, onChanged, onSubmitted, path, project, showResolved, version,
}: SourceFeedbackOptions): SourceComments | undefined {
  const { feedback, actions, index } = useFeedback({ project, id: "", compare: null, version, enabled: enabled && path !== "", onChanged })
  const { anchor, cancel, open, submit } = useFeedbackComposer(JSON.stringify([project, path]), actions.start, onSubmitted)
  const comment = useCallback((range: LineRange) => {
    open({ path, side: "new", lines: [range.start, range.end], compare: null })
  }, [open, path])
  const file = index?.files.get(path)
  const threads = showResolved ? file?.all : file?.open
  const feedbackId = feedback?.id ?? ""
  const feedbackProject = feedback?.project ?? project

  return useMemo((): SourceComments | undefined => {
    if (!enabled || !path) return undefined
    const zones: SourceZone[] = []
    if (threads) {
      for (const thread of threads) {
        if (thread.location.side !== "new") continue
        const lines = lineRange(thread.location.lines)
        zones.push({
          key: `thread-${thread.number}`,
          line: lines ? lines[1] : 0,
          node: <FeedbackThreadZone thread={thread} feedbackId={feedbackId} project={feedbackProject} actions={actions} navigate={navigate} />,
        })
      }
    }
    if (anchor) {
      zones.push({
        key: "composer",
        line: anchor.lines ? anchor.lines[1] : 0,
        node: <FeedbackComposer key={anchorKey(anchor)} anchor={anchor} onSubmit={(body) => submit(anchor, body)} onCancel={cancel} />,
      })
    }
    return { zones, onComment: comment }
  }, [actions, anchor, cancel, comment, enabled, feedbackId, feedbackProject, navigate, path, submit, threads])
}
