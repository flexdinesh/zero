import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject,
} from "react"

import { clearHighlights, showHighlights } from "./find-dom.ts"
import {
  countLabel, emptyFindQuery, findMatches, firstFrom, nearestIndex, seedPattern, stepIndex,
  type FindMatch, type FindOutcome, type FindQuery,
} from "./find-model.ts"
import { FindTargetContext, type FindTarget } from "./find-target.ts"

// Find in file (decision 0172): Ctrl/Cmd+F opens a bar under the document
// toolbar that finds text in the active view, paints every match, and
// steps through them. One provider owns the query and the current match;
// the visible view offers its text as a FindTarget.

const mac = typeof navigator !== "undefined" && navigator.platform.includes("Mac")

export interface FindCommands {
  open(): void
  step(direction: 1 | -1): void
}

type FindOption = "matchCase" | "wholeWord" | "regex"

// FindSession is what the bar shows and does.
export interface FindSession {
  query: FindQuery
  count: string
  invalid: string
  status: string
  hasMatches: boolean
  inSelection: boolean
  // selectionReason explains why Find in Selection is off, "" when it can run.
  selectionReason: string
  focusRequest: number
  setPattern(pattern: string): void
  setOption(option: FindOption, value: boolean): void
  setInSelection(value: boolean): void
  step(direction: 1 | -1): void
  close(): void
}

// TickStore holds the scrollbar marks: fractions of the pane's scroll
// height, and the current match's.
export interface FindTicks {
  ticks: readonly number[]
  current: number | null
}

interface TickStore {
  get(): FindTicks
  set(next: FindTicks): void
  subscribe(listener: () => void): () => void
}

const noTicks: FindTicks = { ticks: [], current: null }

function createTickStore(): TickStore {
  let value = noTicks
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const FindSessionContext = createContext<FindSession | null>(null)
const FindOpenContext = createContext(false)
// FindAvailableContext opens find, null while the shown view has no text.
const FindAvailableContext = createContext<(() => void) | null>(null)

// useFindAvailable opens find on the shown view; null when it has none.
export function useFindAvailable(): (() => void) | null {
  return useContext(FindAvailableContext)
}
const FindTicksContext = createContext<TickStore>(createTickStore())

// useFindSession is the open bar's session, null while find is closed.
export function useFindSession(): FindSession | null {
  return useContext(FindSessionContext)
}

// useFindOpen is whether find is open, so a view can read what it needs,
// such as a review's diffs.
export function useFindOpen(): boolean {
  return useContext(FindOpenContext)
}

export function useFindTicks(): TickStore {
  return useContext(FindTicksContext)
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
}

const noMatches: readonly FindMatch[] = []
const idle: FindOutcome = { kind: "matches", matches: noMatches, truncated: false }
// Ticks closer than this share one mark.
const tickResolution = 1000

interface FindProviderProps {
  // scope is the active tab; changing it closes find.
  scope: string
  // pane is the document pane, whose scroll the marks follow.
  pane: RefObject<HTMLElement | null>
  registerCommands(commands: FindCommands | null): void
  children: ReactNode
}

export function FindProvider({ scope, pane, registerCommands, children }: FindProviderProps) {
  const [target, setTarget] = useState<FindTarget | null>(null)
  const register = useCallback((next: FindTarget) => {
    setTarget(next)
    return () => setTarget((current) => current === next ? null : current)
  }, [])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<FindQuery>(emptyFindQuery)
  const [inSelection, setInSelection] = useState(false)
  // current is the current match; null starts from anchor, the segment
  // where this search began.
  const [current, setCurrent] = useState<FindMatch | null>(null)
  const [anchor, setAnchor] = useState(0)
  const [focusRequest, setFocusRequest] = useState(0)
  // revealRequest reveals the current match again, e.g. stepping onto the
  // only one.
  const [revealRequest, setRevealRequest] = useState(0)
  const [seenScope, setSeenScope] = useState(scope)
  if (seenScope !== scope) {
    setSeenScope(scope)
    setOpen(false)
    setCurrent(null)
  }
  const returnFocus = useRef<HTMLElement | null>(null)
  const [ticks] = useState(createTickStore)

  const active = open && target !== null
  const selection = target?.selection
  const findScope = inSelection && selection ? selection : null
  const segments = target?.segments
  const outcome = useMemo(
    () => active && segments ? findMatches(segments, query, findScope) : idle,
    [active, findScope, query, segments],
  )
  const matches = outcome.kind === "matches" ? outcome.matches : noMatches
  const index = current ? nearestIndex(matches, current) : firstFrom(matches, anchor)
  const match = matches[index] ?? null
  const matchKey = match ? `${match.segment}:${match.start}:${match.end}` : ""

  const latest = useRef({ target, match, matches, index, open, query })
  useLayoutEffect(() => { latest.current = { target, match, matches, index, open, query } })

  // The current match scrolls into view when it changes or a step lands on
  // it again; a reread that keeps it leaves the scroll alone.
  useEffect(() => {
    if (!active || !matchKey) return
    const { target: shown, match: revealed } = latest.current
    if (shown && revealed) shown.reveal(revealed)
  }, [active, matchKey, revealRequest])

  // Ranges are rebuilt when the matches or the rendered text change;
  // stepping only moves the current one between the two highlights.
  const ranges = useRef<ReadonlyArray<readonly Range[]>>([])
  const currentIndex = useRef(index)
  const paintCurrent = useCallback(() => {
    const all: Range[] = []
    const now: Range[] = []
    ranges.current.forEach((list, at) => (at === currentIndex.current ? now : all).push(...list))
    showHighlights(all, now)
  }, [])
  const placeTicks = useCallback(() => {
    const root = pane.current
    const { target: shown, matches: listed, index: at } = latest.current
    if (!root || !shown || !latest.current.open) {
      ticks.set(noTicks)
      return
    }
    const height = Math.max(root.scrollHeight, 1)
    const seen = new Set<number>()
    const marks: number[] = []
    let currentMark: number | null = null
    const tops = shown.place(listed)
    tops.forEach((top, position) => {
      if (top === null) return
      const fraction = Math.min(1, Math.max(0, top / height))
      if (position === at) currentMark = fraction
      const bucket = Math.round(fraction * tickResolution)
      if (seen.has(bucket)) return
      seen.add(bucket)
      marks.push(bucket / tickResolution)
    })
    ticks.set({ ticks: marks, current: currentMark })
  }, [pane, ticks])

  useEffect(() => {
    if (!active || !target) return
    const paint = () => {
      ranges.current = target.paint(matches)
      paintCurrent()
      placeTicks()
    }
    paint()
    const stop = target.subscribe(paint)
    const root = pane.current
    const resize = new ResizeObserver(() => placeTicks())
    if (root) resize.observe(root)
    return () => {
      stop()
      resize.disconnect()
      ranges.current = []
      clearHighlights()
      ticks.set(noTicks)
    }
  }, [active, matches, paintCurrent, pane, placeTicks, target, ticks])
  useEffect(() => {
    currentIndex.current = index
    if (!active) return
    paintCurrent()
    placeTicks()
  }, [active, index, paintCurrent, placeTicks])

  const close = useCallback(() => {
    setOpen(false)
    const back = returnFocus.current
    returnFocus.current = null
    if (back?.isConnected) back.focus({ preventScroll: true })
    else pane.current?.focus({ preventScroll: true })
  }, [pane])

  // openFind opens or refocuses find on the shown view, starting from a
  // one-line text selection or the last query; false when nothing can be
  // searched, so the browser keeps its own find.
  const openFind = useCallback((): boolean => {
    const { target: shown, open: isOpen, query: last } = latest.current
    if (!shown) return false
    const focused = document.activeElement
    const fromBar = focused instanceof Element && focused.closest(".find-bar") !== null
    if (!fromBar) {
      returnFocus.current = focused instanceof HTMLElement && pane.current?.contains(focused) ? focused : null
      const seed = seedPattern(window.getSelection()?.toString() ?? "", last.regex)
      if (seed !== null && seed !== last.pattern) {
        setQuery({ ...last, pattern: seed })
        setCurrent(null)
      }
    }
    if (!isOpen) {
      setAnchor(shown.firstVisible())
      setCurrent(null)
    }
    setOpen(true)
    setFocusRequest((count) => count + 1)
    setRevealRequest((count) => count + 1)
    return true
  }, [pane])

  const step = useCallback((direction: 1 | -1) => {
    const { matches: listed, index: at, open: isOpen } = latest.current
    if (!isOpen || listed.length === 0) return
    const next = listed[stepIndex(listed.length, at, direction)]
    if (!next) return
    setCurrent(next)
    setAnchor(next.segment)
    setRevealRequest((count) => count + 1)
  }, [])

  useEffect(() => {
    registerCommands({ open: () => { openFind() }, step })
    return () => registerCommands(null)
  }, [openFind, registerCommands, step])

  // Ctrl/Cmd+F opens find unless a dialog or another text field has the
  // keys; F3 (and Cmd+G on macOS) steps while it is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      const key = event.key.toLowerCase()
      if (modifier && !event.altKey && !event.shiftKey && key === "f") {
        if (document.querySelector("dialog[open]")) return
        const inBar = event.target instanceof Element && event.target.closest(".find-bar") !== null
        if (isTextField(event.target) && !inBar) return
        if (openFind()) event.preventDefault()
        return
      }
      if (!latest.current.open) return
      const f3 = event.key === "F3" && !event.metaKey && !event.ctrlKey && !event.altKey
      const g = mac && modifier && !event.altKey && key === "g"
      if (!f3 && !g) return
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [openFind, step])

  const setPattern = useCallback((pattern: string) => {
    setQuery((last) => ({ ...last, pattern }))
    setCurrent(null)
  }, [])
  const setOption = useCallback((option: FindOption, value: boolean) => {
    setQuery((last) => ({ ...last, [option]: value }))
    setCurrent(null)
  }, [])
  const changeInSelection = useCallback((value: boolean) => {
    setInSelection(value)
    setCurrent(null)
  }, [])

  const selectionReason = selection === undefined ? "Find in Selection works on selected lines in Source and reviews"
    : selection === null ? "Select lines to find in them" : ""
  const truncated = outcome.kind === "matches" && outcome.truncated
  const session = useMemo((): FindSession | null => active ? {
    query,
    count: query.pattern ? countLabel(index, matches.length, truncated) : "",
    invalid: outcome.kind === "invalid" ? outcome.message : "",
    status: target.status ?? "",
    hasMatches: matches.length > 0,
    inSelection: findScope !== null,
    selectionReason,
    focusRequest,
    setPattern,
    setOption,
    setInSelection: changeInSelection,
    step,
    close,
  } : null, [
    active, changeInSelection, close, findScope, focusRequest, index, matches.length, outcome, query, selectionReason, setOption,
    setPattern, step, target, truncated,
  ])

  const hasTarget = target !== null
  const available = useMemo(() => hasTarget ? () => { openFind() } : null, [hasTarget, openFind])
  return (
    <FindTargetContext.Provider value={register}>
      <FindAvailableContext.Provider value={available}>
        <FindOpenContext.Provider value={open}>
          <FindTicksContext.Provider value={ticks}>
            <FindSessionContext.Provider value={session}>
              {children}
            </FindSessionContext.Provider>
          </FindTicksContext.Provider>
        </FindOpenContext.Provider>
      </FindAvailableContext.Provider>
    </FindTargetContext.Provider>
  )
}
