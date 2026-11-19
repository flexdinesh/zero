import type { SelectionSide } from "@pierre/diffs"
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"

import { diffFindRows, rowsInLines, type DiffFindRow } from "../find/diff-find-rows.ts"
import { revealRect, textRange } from "../find/find-dom.ts"
import { useFindOpen } from "../find/FindProvider.tsx"
import { useFindTarget, type FindTarget } from "../find/find-target.ts"
import type { Compare } from "./compare.ts"
import type { CompareFile } from "./compare-files.ts"
import type { ReviewDiff, ReviewDiffs } from "./review-diffs.ts"
import type { ReviewSelection, ShownDiff } from "./ReviewDocument.tsx"

// Find in a review (decision 0172) reads every file's diff once find opens,
// four at a time, and matches the rows each diff shows. Files join in
// review order as their diffs arrive, so earlier matches keep their place.

const concurrentReads = 4
// revealHold is how long a revealed match is held in place while diffs
// around it render and measure, unless the reader scrolls first.
const revealHold = 2000
const revealTop = 1 / 3

// RenderListeners tell find which file's diff rendered.
export function createRenderListeners() {
  const listeners = new Set<(path: string) => void>()
  return {
    notify(path: string) {
      for (const listener of listeners) listener(path)
    },
    subscribe(listener: (path: string) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

type RenderListeners = ReturnType<typeof createRenderListeners>

interface RowPlace {
  path: string
  row: DiffFindRow
}

interface ReviewFindInput {
  project: string
  compare: Compare
  files: readonly CompareFile[]
  version: string
  ignoreWhitespace: boolean
  expandUnchanged: boolean
  diffs: ReviewDiffs
  selection: ReviewSelection | null
  shown: RefObject<Map<string, ShownDiff>>
  container: RefObject<HTMLElement | null>
  scrollRoot: RefObject<HTMLElement | null>
  scrollPane(root: HTMLElement, top: number): void
  isOpen(file: CompareFile): boolean
  setFileOpen(path: string, open: boolean): void
  renders: RenderListeners
}

// sideOf is where a row's line is: deleted rows on the old side.
function sideOf(row: DiffFindRow): { side: SelectionSide; line: number } {
  return row.kind === "deletion" ? { side: "deletions", line: row.oldLine } : { side: "additions", line: row.newLine }
}

// rowElements maps a rendered diff's rows by column and line: d for the
// old side, a for the new. A unified view shows context once, as new.
function rowElements(section: Element | null): Map<string, Element> {
  const rows = new Map<string, Element>()
  const root = section?.querySelector("diffs-container")?.shadowRoot
  if (!root) return rows
  for (const row of root.querySelectorAll("[data-line]")) {
    const line = row.getAttribute("data-line")
    const deleted = row.getAttribute("data-line-type") === "change-deletion"
    const column = row.closest("[data-deletions]") ? "d" : row.closest("[data-additions]") ? "a" : deleted ? "d" : "a"
    rows.set(`${column}:${line}`, row)
  }
  return rows
}

function rowsFor(rows: ReadonlyMap<string, Element>, row: DiffFindRow): Element[] {
  const found: Element[] = []
  const add = (key: string) => {
    const element = rows.get(key)
    if (element) found.push(element)
  }
  if (row.kind !== "addition") add(`d:${row.oldLine}`)
  if (row.kind !== "deletion") add(`a:${row.newLine}`)
  return found
}

export function useReviewFind(input: ReviewFindInput) {
  const {
    project, compare, files, version, ignoreWhitespace, expandUnchanged, diffs, selection, shown, container, scrollRoot, scrollPane,
    isOpen, setFileOpen, renders,
  } = input
  const finding = useFindOpen()
  // reads are the diffs read for find, by path, published once a frame.
  const [reads, setReads] = useState<ReadonlyMap<string, ReviewDiff>>(() => new Map())
  useEffect(() => {
    if (!finding || !project) return
    const controller = new AbortController()
    const arrived = new Map<string, ReviewDiff>()
    let frame = 0
    const publish = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setReads(new Map(arrived))
      })
    }
    let next = 0
    const work = async () => {
      while (next < files.length && !controller.signal.aborted) {
        const file = files[next++]
        if (!file) continue
        const source = { project, compare, file, version, ignoreWhitespace }
        let diff = diffs.peek(source)
        if (!diff) {
          try {
            diff = await diffs.load(source, controller.signal)
          } catch {
            if (controller.signal.aborted) return
            diff = { kind: "error", message: "" }
          }
        }
        arrived.set(file.path, diff)
        publish()
      }
    }
    for (let worker = 0; worker < concurrentReads; worker++) void work()
    return () => {
      controller.abort()
      cancelAnimationFrame(frame)
      setReads(new Map())
    }
  }, [compare, diffs, files, finding, ignoreWhitespace, project, version])

  // shownLines are each diff's expanded gap lines, read as it renders.
  const [shownLines, setShownLines] = useState<ReadonlyMap<string, ReadonlySet<number>>>(() => new Map())
  useEffect(() => {
    if (!finding) return
    return renders.subscribe((path) => {
      const view = shown.current.get(path)
      const lines = new Set<number>()
      for (const gap of view?.rendered.lineDiff.gaps ?? []) {
        for (let line = gap.newStart; line < gap.newStart + gap.lines; line++) if (view?.lineShown(line)) lines.add(line)
      }
      setShownLines((current) => {
        const before = current.get(path)
        if (before && before.size === lines.size && [...lines].every((line) => before.has(line))) return current
        return new Map(current).set(path, lines)
      })
    })
  }, [finding, renders, shown])

  const model = useMemo(() => {
    const segments: string[] = []
    const places: RowPlace[] = []
    const starts = new Map<string, number>()
    let loaded = 0
    if (finding) {
      for (const file of files) {
        const diff = reads.get(file.path)
        // Files join in order, so a file's rows never move a later read.
        if (!diff) break
        loaded++
        if (diff.kind !== "ready" || !diff.rendered) continue
        const { fileDiff, lineDiff } = diff.rendered
        const expanded = shownLines.get(file.path)
        const rows = diffFindRows(lineDiff, fileDiff.deletionLines, fileDiff.additionLines,
          (line) => expandUnchanged || (expanded?.has(line) ?? false))
        starts.set(file.path, segments.length)
        for (const row of rows) {
          segments.push(row.text)
          places.push({ path: file.path, row })
        }
      }
    }
    return { segments, places, starts, loaded }
  }, [expandUnchanged, files, finding, reads, shownLines])

  // A revealed match stays placed while its diff and the ones above it
  // render, until the hold ends or the reader scrolls.
  const pin = useRef<{ path: string; side: SelectionSide; line: number; until: number } | null>(null)
  const place = useCallback(() => {
    const held = pin.current
    const root = scrollRoot.current
    const content = container.current
    if (!held || !root || !content) return
    if (performance.now() > held.until) {
      pin.current = null
      return
    }
    const box = shown.current.get(held.path)?.lineBox(held.side, held.line)
    let top: number
    if (box) {
      if (box.top >= root.scrollTop && box.top + box.height <= root.scrollTop + root.clientHeight) return
      top = box.top - root.clientHeight * revealTop
    } else {
      const section = content.querySelector(`[data-review-path="${CSS.escape(held.path)}"]`)
      if (!section) return
      top = section.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
    }
    scrollPane(root, Math.max(0, Math.min(top, root.scrollHeight - root.clientHeight)))
  }, [container, scrollPane, scrollRoot, shown])
  useEffect(() => {
    const root = scrollRoot.current
    if (!root) return
    const release = () => { pin.current = null }
    const events: ReadonlyArray<keyof HTMLElementEventMap> = ["wheel", "pointerdown", "touchstart"]
    for (const type of events) root.addEventListener(type, release, { passive: true })
    const stop = renders.subscribe((path) => {
      if (pin.current?.path === path) requestAnimationFrame(place)
    })
    return () => {
      stop()
      for (const type of events) root.removeEventListener(type, release)
    }
  }, [place, renders, scrollRoot])

  const latest = useRef({ files, isOpen })
  useEffect(() => { latest.current = { files, isOpen } })

  const selectedPath = selection?.path ?? ""
  const lines = selection?.lines ?? null
  const target = useMemo((): FindTarget => {
    const { segments, places, starts, loaded } = model
    const sectionOf = (path: string) => container.current?.querySelector(`[data-review-path="${CSS.escape(path)}"]`) ?? null
    const rangesOf = (lookup: Map<string, Map<string, Element>>, segment: number, start: number, end: number): Range[] => {
      const placed = places[segment]
      if (!placed) return []
      let rows = lookup.get(placed.path)
      if (!rows) {
        rows = rowElements(sectionOf(placed.path))
        lookup.set(placed.path, rows)
      }
      return rowsFor(rows, placed.row).flatMap((element) => {
        const range = textRange(element, start, end)
        return range ? [range] : []
      })
    }
    const fileRows = (path: string) => {
      const first = starts.get(path)
      if (first === undefined) return null
      let last = first
      while (places[last + 1]?.path === path) last++
      return { first, rows: places.slice(first, last + 1).map((placed) => placed.row) }
    }
    let selected: { start: number; end: number } | null = null
    if (lines) {
      const file = fileRows(selectedPath)
      const side = lines.side ?? "additions"
      const covered = file ? rowsInLines(file.rows, side, lines.start, lines.endSide ?? side, lines.end) : null
      if (file && covered) selected = { start: file.first + covered.start, end: file.first + covered.end }
    }
    return {
      segments,
      status: finding && loaded < files.length ? `Searching ${loaded.toLocaleString()} of ${files.length.toLocaleString()} files…` : undefined,
      selection: selected,
      paint(matches) {
        const lookup = new Map<string, Map<string, Element>>()
        return matches.map((match) => rangesOf(lookup, match.segment, match.start, match.end))
      },
      reveal(match) {
        const placed = places[match.segment]
        if (!placed) return
        const file = latest.current.files.find((item) => item.path === placed.path)
        if (file && !latest.current.isOpen(file)) setFileOpen(placed.path, true)
        pin.current = { path: placed.path, ...sideOf(placed.row), until: performance.now() + revealHold }
        place()
        // Wide code scrolls sideways inside its diff.
        requestAnimationFrame(() => {
          const root = scrollRoot.current
          const [range] = rangesOf(new Map(), match.segment, match.start, match.end)
          if (root && range) revealRect(root, range.getBoundingClientRect(), range.startContainer.parentElement)
        })
      },
      place(matches) {
        return matches.map((match) => {
          const placed = places[match.segment]
          const where = placed ? sideOf(placed.row) : null
          return placed && where ? shown.current.get(placed.path)?.lineBox(where.side, where.line)?.top ?? null : null
        })
      },
      firstVisible() {
        const root = scrollRoot.current
        if (!root) return 0
        const top = root.getBoundingClientRect().top
        const path = files.find((file) => {
          const section = sectionOf(file.path)
          return section && starts.has(file.path) && section.getBoundingClientRect().bottom > top
        })?.path
        const file = path ? fileRows(path) : null
        if (!path || !file) return 0
        const view = shown.current.get(path)
        const index = file.rows.findIndex((row) => {
          const where = sideOf(row)
          const box = view?.lineBox(where.side, where.line)
          return box ? box.top >= root.scrollTop : false
        })
        return file.first + Math.max(0, index)
      },
      subscribe(onChange) {
        let pending = 0
        const stop = renders.subscribe(() => {
          if (pending) return
          pending = requestAnimationFrame(() => {
            pending = 0
            onChange()
          })
        })
        return () => {
          stop()
          cancelAnimationFrame(pending)
        }
      },
    }
  }, [container, files, finding, lines, model, place, renders, scrollRoot, selectedPath, setFileOpen, shown])
  useFindTarget(target)
}
