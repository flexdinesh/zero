import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"

import { indexText, observeText, revealRect, topIn, type TextIndex } from "./find-dom.ts"
import { useFindOpen } from "./FindProvider.tsx"
import { useFindTarget, type FindTarget } from "./find-target.ts"

// Find reads the prose and code blocks; diagrams and code-block controls
// are not text.
const skip = ".mermaid-portal, .code-block-controls-portal, svg, style, script"

function sameText(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((text, index) => text === right[index])
}

// usePreviewFind offers a Markdown preview's rendered text to find
// (decision 0172). The text is read while find is open, and again when the
// preview's DOM changes, such as code blocks highlighting.
export function usePreviewFind(enabled: boolean, article: RefObject<HTMLElement | null>, html: string) {
  const open = useFindOpen()
  const reading = enabled && open
  const index = useRef<TextIndex | null>(null)
  const [segments, setSegments] = useState<readonly string[]>([])
  const listeners = useRef(new Set<() => void>())
  useLayoutEffect(() => {
    const root = article.current
    if (!reading || !root) return
    const read = () => {
      const next = indexText(root, skip)
      index.current = next
      setSegments((current) => sameText(current, next.segments) ? current : next.segments)
      for (const listener of listeners.current) listener()
    }
    read()
    const stop = observeText(root, read)
    return () => {
      stop()
      index.current = null
    }
  }, [article, html, reading])

  const target = useMemo((): FindTarget | null => {
    if (!enabled) return null
    const current = () => {
      const root = article.current
      if (!index.current && root) index.current = indexText(root, skip)
      return index.current
    }
    const rangeOf = (segment: number, start: number, end: number) => current()?.range(segment, start, end) ?? null
    const paneOf = () => article.current?.closest("main") ?? null
    return {
      segments,
      selection: undefined,
      paint(matches) {
        return matches.map((match) => {
          const range = rangeOf(match.segment, match.start, match.end)
          return range ? [range] : []
        })
      },
      reveal(match) {
        const range = rangeOf(match.segment, match.start, match.end)
        const pane = paneOf()
        if (range && pane) revealRect(pane, range.getBoundingClientRect(), range.startContainer.parentElement)
      },
      place(matches) {
        const pane = paneOf()
        return matches.map((match) => {
          const range = pane ? rangeOf(match.segment, match.start, match.end) : null
          return pane && range ? topIn(pane, range.getBoundingClientRect()) : null
        })
      },
      firstVisible() {
        const pane = paneOf()
        const text = current()
        if (!pane || !text) return 0
        const top = pane.getBoundingClientRect().top
        let low = 0
        let high = text.segments.length - 1
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          const range = text.range(middle, 0, Math.min(1, text.segments[middle]?.length ?? 0))
          if (range && range.getBoundingClientRect().bottom <= top) low = middle + 1
          else high = middle
        }
        return Math.max(0, low)
      },
      subscribe(onChange) {
        listeners.current.add(onChange)
        return () => listeners.current.delete(onChange)
      },
    }
  }, [article, enabled, segments])
  useFindTarget(target)
}
