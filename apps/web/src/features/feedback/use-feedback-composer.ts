import { useCallback, useLayoutEffect, useRef, useState } from "react"

import type { FeedbackAnchorInput } from "./feedback-model.ts"
import type { FeedbackActions } from "./use-feedback.ts"

// Source and Review each own one composer. The anchor object identifies an
// opening, even if the same lines are reopened while a write is pending.
export function useFeedbackComposer(scope: string, start: FeedbackActions["start"], onSubmitted: (path: string) => void) {
  const [draft, setDraft] = useState<{ scope: string; anchor: FeedbackAnchorInput } | null>(null)
  if (draft && draft.scope !== scope) setDraft(null)
  const anchor = draft?.scope === scope ? draft.anchor : null
  const current = useRef(anchor)
  useLayoutEffect(() => {
    current.current = anchor
    return () => { current.current = null }
  }, [anchor])

  const open = useCallback((anchor: FeedbackAnchorInput) => setDraft({ scope, anchor }), [scope])
  const cancel = useCallback(() => setDraft(null), [])
  const submit = useCallback(async (anchor: FeedbackAnchorInput, body: string) => {
    const location = window.location.href
    await start(anchor, body)
    if (current.current !== anchor) return
    setDraft(null)
    if (window.location.href === location) onSubmitted(anchor.path)
  }, [onSubmitted, start])

  return { anchor, open, cancel, submit }
}
