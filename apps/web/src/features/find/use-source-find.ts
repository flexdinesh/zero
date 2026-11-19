import { useMemo, type RefObject } from "react"

import type { LineRange } from "../../lib/line-selection.ts"
import { observeText, revealRect, textRange, topIn } from "./find-dom.ts"
import { useFindTarget, type FindTarget } from "./find-target.ts"

// rowElements are a Source document's own rows, in line order, without the
// rows of anything nested in its zones.
function rowElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(":scope > code > .source-document-line[data-line]")]
}

function lineContent(row: HTMLElement | undefined): Element | null {
  return row?.querySelector(":scope > .source-document-line-content") ?? null
}

function paneOf(root: HTMLElement | null): HTMLElement | null {
  return root?.closest("main") ?? null
}

// useSourceFind offers a Source or Format document's lines to find
// (decision 0172). selection is the gutter's line range, null for none, or
// undefined where the view selects no lines.
export function useSourceFind(
  enabled: boolean, container: RefObject<HTMLElement | null>, lines: readonly string[], selection: LineRange | null | undefined,
) {
  const start = selection?.start ?? 0
  const end = selection?.end ?? 0
  const selectable = selection !== undefined
  const target = useMemo((): FindTarget | null => {
    if (!enabled) return null
    const rangeOf = (rows: readonly HTMLElement[], segment: number, from: number, to: number) => {
      const content = lineContent(rows[segment])
      return content ? textRange(content, from, to) : null
    }
    return {
      segments: lines,
      selection: !selectable ? undefined : start > 0 ? { start: start - 1, end: end - 1 } : null,
      paint(matches) {
        const rows = rowElements(container.current)
        return matches.map((match) => {
          const range = rangeOf(rows, match.segment, match.start, match.end)
          return range ? [range] : []
        })
      },
      reveal(match) {
        const root = container.current
        const pane = paneOf(root)
        const rows = rowElements(root)
        const range = rangeOf(rows, match.segment, match.start, match.end)
        if (!pane || !range) return
        // The sticky line numbers cover code scrolled under them.
        const gutter = rows[match.segment]?.querySelector(":scope > .source-document-line-number")
        revealRect(pane, range.getBoundingClientRect(), lineContent(rows[match.segment]), gutter?.getBoundingClientRect().width ?? 0)
      },
      place(matches) {
        const root = container.current
        const pane = paneOf(root)
        const rows = rowElements(root)
        // Rows share an offset parent, so one box places them all.
        const first = rows[0]
        if (!pane || !first) return matches.map(() => null)
        const top = topIn(pane, first.getBoundingClientRect())
        return matches.map((match) => {
          const row = rows[match.segment]
          return row ? top + row.offsetTop - first.offsetTop : null
        })
      },
      firstVisible() {
        const root = container.current
        const pane = paneOf(root)
        const rows = rowElements(root)
        if (!pane || rows.length === 0) return 0
        const top = pane.getBoundingClientRect().top
        let low = 0
        let high = rows.length - 1
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          const row = rows[middle]
          if (row && row.getBoundingClientRect().bottom <= top) low = middle + 1
          else high = middle
        }
        return low
      },
      subscribe(onChange) {
        const root = container.current
        return root ? observeText(root, onChange) : () => {}
      },
    }
  }, [container, enabled, end, lines, selectable, start])
  useFindTarget(target)
}
