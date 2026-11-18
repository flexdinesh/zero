import { isFeedbackCompare, type FeedbackThread } from "@zero/contracts"
import { useCallback, useMemo } from "react"

import { compareKey, type Compare } from "../source-control/compare.ts"
import type { ReviewComments, ReviewZone } from "../source-control/ReviewDocument.tsx"
import { anchorKey, diffSide, feedbackCompare, lineRange } from "./feedback-model.ts"
import { FeedbackComposer } from "./FeedbackComposer.tsx"
import { FeedbackThreadZone } from "./FeedbackThreadZone.tsx"
import { useFeedback } from "./use-feedback.ts"
import { useFeedbackComposer } from "./use-feedback-composer.ts"

export interface ReviewFeedbackOptions {
  project: string
  // compare is the shown review's; null reads nothing.
  compare: Compare | null
  version: number
  // showResolved is the View option: closed threads show inline.
  showResolved: boolean
  navigate(href: string): void
  onChanged(): void
  // onSubmitted follows a new thread: the selection it was made from clears.
  onSubmitted(path: string): void
  // onShowOutdated opens the Feedback view at a file's outdated threads.
  onShowOutdated(id: string, path: string): void
}

export interface ReviewFeedback {
  comments: ReviewComments | undefined
  // counts are each file's open threads, for the Files rail.
  counts: ReadonlyMap<string, number>
}

const noCounts: ReadonlyMap<string, number> = new Map()

// useReviewFeedback reads the shown review's feedback, resolved against its
// compare, and places its threads and the comment composer as zones in the
// review (decision 0120).
export function useReviewFeedback({
  compare, navigate, onChanged, onShowOutdated, onSubmitted, project, showResolved, version,
}: ReviewFeedbackOptions): ReviewFeedback {
  const key = compare ? compareKey(compare) : ""
  // The compare by value, so a new object for the same review rereads nothing.
  const contractText = compare ? JSON.stringify(feedbackCompare(compare)) : ""
  const contract = useMemo(() => {
    const value: unknown = contractText ? JSON.parse(contractText) : null
    return isFeedbackCompare(value) ? value : null
  }, [contractText])
  const { feedback, actions, index } = useFeedback({ project, id: "", compare: contract, version, enabled: contract !== null, onChanged })
  const { anchor, cancel, open, submit } = useFeedbackComposer(JSON.stringify([project, key]), actions.start, onSubmitted)
  const feedbackId = feedback?.id ?? ""
  const feedbackProject = feedback?.project ?? project
  const renderThread = useCallback((thread: FeedbackThread): ReviewZone => ({
    key: `thread-${thread.number}`,
    side: diffSide(thread.location.side),
    line: lineRange(thread.location.lines)?.[1] ?? 0,
    node: <FeedbackThreadZone thread={thread} feedbackId={feedbackId} project={feedbackProject} actions={actions} navigate={navigate} />,
  }), [actions, feedbackId, feedbackProject, navigate])
  const composer = useMemo(() => anchor ? {
    path: anchor.path, key: "composer", side: diffSide(anchor.side), line: anchor.lines?.[1] ?? 0,
    node: <FeedbackComposer key={anchorKey(anchor)} anchor={anchor} onSubmit={(body) => submit(anchor, body)} onCancel={cancel} />,
  } : undefined, [anchor, cancel, submit])
  const showOutdated = useCallback((path: string) => onShowOutdated(feedbackId, path), [feedbackId, onShowOutdated])
  const onComment = useCallback<ReviewComments["onComment"]>((path, side, lines) => {
    open({ path, side, lines, compare: contract })
  }, [contract, open])
  const comments = useMemo((): ReviewComments | undefined => contract ? {
    files: index?.files, showResolved, renderThread, composer, onComment, onShowOutdated: showOutdated,
  } : undefined, [composer, contract, index, onComment, renderThread, showOutdated, showResolved])
  return { comments, counts: index?.counts ?? noCounts }
}
