import { createContext, useContext, useEffect } from "react"

import type { FindMatch, SegmentRange } from "./find-model.ts"

// FindTarget is a view find searches (decision 0172): Source, Format,
// Preview, or a review. The view owns its text and geometry; the provider
// owns the query, the matches, and the current one.
export interface FindTarget {
  // segments is the view's text in order; a new array means new text.
  segments: readonly string[]
  // status says what is still loading, e.g. a review's diffs.
  status?: string
  // selection is the selected segments, null for none; undefined when the
  // view has no selection to find in.
  selection: SegmentRange | null | undefined
  // paint lists each match's ranges; a match not rendered has none.
  paint(matches: readonly FindMatch[]): ReadonlyArray<readonly Range[]>
  // reveal scrolls a match into view, loading or opening what holds it.
  reveal(match: FindMatch): void
  // place lists each match's top in the pane's scroll content, null where
  // unplaced.
  place(matches: readonly FindMatch[]): ReadonlyArray<number | null>
  // firstVisible is the segment at the pane's top.
  firstVisible(): number
  // subscribe asks for a repaint when the rendered text or layout changes.
  subscribe(onChange: () => void): () => void
}

// RegisterTarget offers a target and returns its withdrawal, which leaves a
// newer target in place.
type RegisterTarget = (target: FindTarget) => () => void

export const FindTargetContext = createContext<RegisterTarget>(() => () => {})

// useFindTarget offers target to find while the view is mounted and
// visible; null offers nothing.
export function useFindTarget(target: FindTarget | null) {
  const register = useContext(FindTargetContext)
  useEffect(() => target ? register(target) : undefined, [register, target])
}
