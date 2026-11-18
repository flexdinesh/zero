import { useCallback, useLayoutEffect, useRef, type PointerEvent } from "react"

import { useResizeDrag } from "../../lib/use-resize-drag.ts"
import { defaultLayout, paneIds, paneShares, resizePair, type PaneId, type SourceControlLayout } from "./source-control-layout.ts"

type Weights = SourceControlLayout["weights"]

interface PaneResizeOptions {
  active: boolean
  mobile: boolean
  open: readonly PaneId[]
  weights: Weights
  onCommit(weights: Weights): void
  onReset(): void
}

// One owner for the coordinated pane geometry and both separator values.
// Lists retain their React identities while the owner previews a split.
export function usePaneResize({ active, mobile, open, weights, onCommit, onReset }: PaneResizeOptions) {
  const container = useRef<HTMLDivElement>(null)
  const elements = useRef<Record<PaneId, HTMLElement | null>>({ working: null, commits: null, branches: null })
  const sashes = useRef<Record<PaneId, HTMLDivElement | null>>({ working: null, commits: null, branches: null })
  const drag = useResizeDrag()
  const { finish } = drag

  const apply = useCallback((next: Weights, ids: readonly PaneId[], natural: boolean) => {
    const shares = paneShares(next, ids)
    for (const id of paneIds) {
      const element = elements.current[id]
      if (element) element.style.flexGrow = String(natural ? 0 : shares[id] ?? 0)
      const above = ids[ids.indexOf(id) - 1]
      const sash = sashes.current[id]
      if (sash && above) sash.setAttribute("aria-valuenow", String(Math.round(next[above] / (next[above] + next[id]) * 100)))
    }
  }, [])

  useLayoutEffect(() => {
    finish()
    if (active) apply(weights, open, mobile)
  }, [active, apply, finish, mobile, open, weights])

  function start(above: PaneId, below: PaneId, event: PointerEvent<HTMLDivElement>) {
    drag.start(event, () => {
      const element = container.current
      if (!element || !active || mobile || !open.includes(above) || !open.includes(below)) return null
      const height = element.getBoundingClientRect().height
      if (height <= 0) return null
      let preview = weights
      let y = event.clientY
      return {
        geometry: [element],
        move: (next) => {
          preview = resizePair(preview, open, above, below, (next.clientY - y) / height)
          y = next.clientY
        },
        render: () => apply(preview, open, false),
        commit: () => onCommit(preview),
      }
    })
  }

  return {
    container, start, move: drag.move, stop: drag.stop, finish, isResizing: drag.isResizing,
    reset: () => {
      finish()
      // Finish and reset can batch back to the rendered preference. Apply the
      // reset even when equal context values need no subsequent React render.
      apply(defaultLayout.weights, open, mobile)
      onReset()
    },
    setPaneElement: (id: PaneId, element: HTMLElement | null) => { elements.current[id] = element },
    setSashElement: (id: PaneId, element: HTMLDivElement | null) => { sashes.current[id] = element },
  }
}
