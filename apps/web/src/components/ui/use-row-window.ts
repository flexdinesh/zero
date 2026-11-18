import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type RefObject } from "react"

import { rowAt, rowOffsets, windowedIndexes } from "./row-window.ts"

const fullListLimit = 32

interface RowWindowOptions {
  keys: readonly string[]
  scroll: RefObject<HTMLDivElement | null>
  visible: boolean
  sharedScroll?: boolean
  selectedKey?: string
  expanded?: ReadonlySet<string>
  parentKey?(key: string): string
  onEmptyFocus?(): void
}

interface Geometry {
  keys: readonly string[]
  positions: ReadonlyMap<string, number>
  offsets: readonly number[]
  windowed: boolean
}

interface Layout {
  geometry: Geometry
  root: HTMLElement
  origin: number
  scrollTop: number
}

interface Measurement {
  width: number
  rowHeight: number
  height: number
}

function rowElement(region: HTMLElement, key: string) {
  return region.querySelector<HTMLElement>(`[data-window-key="${CSS.escape(key)}"]`)
}

export function rowInViewport(root: HTMLElement, row: HTMLElement): boolean {
  const top = root.getBoundingClientRect().top + root.clientTop
  const box = row.getBoundingClientRect()
  return box.top >= top && box.bottom <= top + root.clientHeight
}

// All interaction orders live in the caller's data. Only the visible rows,
// the tab stop, and any focused or pending row need DOM nodes.
export function useRowWindow({ keys, scroll, visible, sharedScroll, selectedKey, expanded, parentKey, onEmptyFocus }: RowWindowOptions) {
  const region = useRef<HTMLDivElement>(null)
  const estimateProbe = useRef<HTMLDivElement>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const layout = useRef<Layout | null>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0, rowHeight: 24 })
  const [measured, setMeasured] = useState<ReadonlyMap<string, Measurement>>(() => new Map())
  const [cursor, setCursor] = useState("")
  const [owned, setOwned] = useState("")
  const [request, setRequest] = useState<{ key: string; focus: boolean } | null>(null)
  const positions = useMemo(() => new Map(keys.map((key, index): [string, number] => [key, index])), [keys])
  const previousPositions = useRef(positions)
  const tabKey = positions.has(cursor) ? cursor : selectedKey && positions.has(selectedKey) ? selectedKey : keys[0] ?? ""
  const windowed = keys.length > fullListLimit
  const present = keys.length > 0
  const getScrollRoot = useCallback(() => sharedScroll
    ? region.current?.closest<HTMLElement>("[data-window-scroll-root]") ?? null : scroll.current, [scroll, sharedScroll])
  const geometry = useMemo<Geometry>(() => ({ keys, positions, windowed,
    offsets: rowOffsets(keys.length, (index) => {
      const key = keys[index]
      if (key === undefined || !expanded?.has(key)) return viewport.rowHeight
      const previous = measured.get(key)
      return previous?.width === viewport.width && previous.rowHeight === viewport.rowHeight
        ? previous.height : viewport.rowHeight * 4
    }),
  }), [expanded, keys, measured, positions, viewport.rowHeight, viewport.width, windowed])
  const { offsets } = geometry
  const indexes = windowed ? windowedIndexes(offsets, viewport.top, viewport.height,
    [positions.get(tabKey), positions.get(owned), request ? positions.get(request.key) : undefined]) : keys.map((_, index) => index)

  const sync = useCallback((anchor: boolean) => {
    const root = getScrollRoot()
    const list = region.current
    const probe = estimateProbe.current
    if (!visible || !root || !list || !probe || !root.clientHeight) return
    const box = list.getBoundingClientRect()
    const origin = box.top - root.getBoundingClientRect().top - root.clientTop + root.scrollTop
    const previous = layout.current
    if (anchor && previous?.root === root && (previous.geometry.windowed || geometry.windowed)
      && (previous.geometry !== geometry || origin !== previous.origin)) {
      const oldTop = previous.scrollTop - previous.origin
      if (oldTop >= 0 && oldTop < (previous.geometry.offsets.at(-1) ?? 0)) {
        const oldIndex = rowAt(previous.geometry.offsets, oldTop)
        const key = previous.geometry.keys[oldIndex]
        const nextIndex = (key === undefined ? undefined : geometry.positions.get(key)) ?? Math.min(oldIndex, geometry.keys.length - 1)
        const nextTop = geometry.offsets[nextIndex]
        if (nextTop !== undefined) {
          const delta = oldTop - (previous.geometry.offsets[oldIndex] ?? 0)
          const rowEnd = geometry.offsets[nextIndex + 1] ?? nextTop
          root.scrollTop = origin + nextTop + Math.min(delta, Math.max(0, rowEnd - nextTop - 1))
        }
      }
    }
    layout.current = { geometry, root, origin, scrollTop: root.scrollTop }
    const next = { top: root.scrollTop - origin, height: root.clientHeight, width: box.width, rowHeight: probe.getBoundingClientRect().height }
    if (next.rowHeight > 0) setViewport((old) => old.top === next.top && old.height === next.height
      && old.width === next.width && old.rowHeight === next.rowHeight ? old : next)
  }, [geometry, getScrollRoot, visible])

  useLayoutEffect(() => {
    const root = getScrollRoot()
    const list = region.current
    const probe = estimateProbe.current
    if (!visible || !present || !root || !list || !probe) return
    sync(true)
    const onScroll = () => {
      if (windowed) sync(false)
      else if (layout.current) layout.current.scrollTop = root.scrollTop
    }
    root.addEventListener("scroll", onScroll, { passive: true })
    if (!windowed) return () => root.removeEventListener("scroll", onScroll)
    const resize = new ResizeObserver((entries) => {
      const heights: [string, Measurement][] = []
      const rowHeight = probe.getBoundingClientRect().height
      for (const { target } of entries) {
        if (!(target instanceof HTMLElement)) continue
        const key = target.dataset.windowDetail
        if (!key) continue
        const { width, height } = target.getBoundingClientRect()
        if (height > 0) heights.push([key, { height, width, rowHeight }])
      }
      if (heights.length) setMeasured((previous) => {
        if (heights.every(([key, next]) => {
          const old = previous.get(key)
          return old?.height === next.height && old.rowHeight === next.rowHeight && old.width === next.width
        })) return previous
        const next = new Map(previous)
        for (const [key, measurement] of heights) next.set(key, measurement)
        return next
      })
      sync(true)
    })
    observer.current = resize
    resize.observe(root)
    resize.observe(probe)
    if (sharedScroll) for (const pane of root.children) resize.observe(pane)
    for (const row of list.querySelectorAll("[data-window-detail]")) resize.observe(row)
    return () => {
      root.removeEventListener("scroll", onScroll)
      resize.disconnect()
      observer.current = null
    }
  }, [getScrollRoot, present, sharedScroll, sync, visible, windowed])

  useLayoutEffect(() => {
    setMeasured((previous) => {
      if ([...previous.keys()].every((key) => positions.has(key) && expanded?.has(key))) return previous
      return new Map([...previous].filter(([key]) => positions.has(key) && expanded?.has(key)))
    })
  }, [expanded, positions])

  const measureDetails = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      observer.current?.observe(element)
      return () => observer.current?.unobserve(element)
    }
  }, [])

  const reveal = useCallback((key: string, focus: boolean) => setRequest({ key, focus }), [])
  const focusRow = useCallback((key: string) => reveal(key, true), [reveal])

  // Recover only after a focused row was removed. A focus move elsewhere
  // or a hidden panel must not hand focus back to this list.
  useLayoutEffect(() => {
    const oldIndex = previousPositions.current.get(owned) ?? 0
    previousPositions.current = positions
    if (!visible || !owned || positions.has(owned)) return
    setOwned("")
    if (document.activeElement !== document.body) return
    const parent = parentKey?.(owned)
    const destination = parent && positions.has(parent) ? parent : keys[Math.min(oldIndex, keys.length - 1)]
    if (destination) focusRow(destination)
    else onEmptyFocus?.()
  }, [focusRow, keys, onEmptyFocus, owned, parentKey, positions, visible])

  useLayoutEffect(() => {
    if (!visible || !request) return
    setRequest(null)
    const root = getScrollRoot()
    const list = region.current
    if (!root || !list || !positions.has(request.key)) return
    const row = rowElement(list, request.key)
    if (!row) return
    const top = root.getBoundingClientRect().top + root.clientTop
    const box = row.getBoundingClientRect()
    if (box.top < top) root.scrollTop += box.top - top
    else if (box.bottom > top + root.clientHeight) root.scrollTop += box.bottom - top - root.clientHeight
    if (request.focus) row.focus({ preventScroll: true })
    sync(false)
  }, [getScrollRoot, positions, request, sync, visible])

  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const row = event.target.closest<HTMLElement>("[data-window-key], [data-window-detail]")
    const key = row?.dataset.windowKey
    setOwned(key ?? row?.dataset.windowDetail ?? "")
    if (key) setCursor(key)
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setOwned("")
  }

  function rowStyle(index: number): CSSProperties | undefined {
    return windowed ? { position: "absolute", insetInline: 0, top: offsets[index] } : undefined
  }

  return {
    region, getScrollRoot, estimateProbe, measureDetails, indexes, positions, tabKey, reveal, focusRow, onFocus, onBlur, rowStyle,
    regionStyle: windowed ? { height: offsets.at(-1) } : undefined,
    windowed,
  }
}
