import { type KeyboardEvent, type PointerEvent, useCallback, useLayoutEffect, useRef, useState } from "react"

const defaultWidth = 288
const minimumWidth = 208
const storageKey = "zero-sidebar-width"

function clampWidth(width: number, maximumWidth: number): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width))
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(storageKey))
    return Number.isFinite(stored) && stored > 0 ? Math.max(minimumWidth, stored) : defaultWidth
  } catch {
    return defaultWidth
  }
}

function writeWidth(width: number) {
  try {
    window.localStorage.setItem(storageKey, String(width))
  } catch {
    // Resizing still applies when storage is unavailable.
  }
}

export function useSidebarResize(active: boolean) {
  const element = useRef<HTMLDivElement>(null)
  const grids = useRef<readonly HTMLElement[]>([])
  const [preferredWidth, setPreferredWidth] = useState(readWidth)
  const [maximumWidth, setMaximumWidth] = useState(() => Math.max(minimumWidth, Math.floor(window.innerWidth / 2)))
  // A smaller window constrains display without replacing the saved preference.
  const width = clampWidth(preferredWidth, maximumWidth)
  const currentWidth = useRef(width)
  const currentMaximum = useRef(maximumWidth)
  const frame = useRef<number | null>(null)
  const resizeStart = useRef<{ pointerID: number; element: HTMLDivElement; width: number; preference: number; maximum: number; x: number; nextWidth: number } | null>(null)

  // A preceding project may finish its drag in layout-effect cleanup, after
  // this owner's initial render read. Restore its final preference pre-paint.
  useLayoutEffect(() => setPreferredWidth(readWidth()), [])

  useLayoutEffect(() => {
    const layout = element.current?.parentElement
    if (!layout) return
    const status = layout?.parentElement?.querySelector(".status-bar")
    // Resolve the two owners once; do not search through a large document in
    // every visual frame. Both elements retain this resize owner's lifetime.
    grids.current = status instanceof HTMLElement ? [layout, status] : [layout]
    return () => { grids.current = [] }
  }, [])

  useLayoutEffect(() => {
    currentWidth.current = width
    currentMaximum.current = maximumWidth
    // Only these grids consume the width. A root style mutation invalidates
    // the adjacent document even when this property does not inherit.
    for (const grid of grids.current) grid.style.setProperty("--sidebar-width", `${width}px`)
  }, [maximumWidth, width])

  const applyWidth = useCallback((next: number) => {
    const clamped = clampWidth(next, currentMaximum.current)
    currentWidth.current = clamped
    setPreferredWidth(clamped)
    return clamped
  }, [])

  const finishResize = useCallback(() => {
    const start = resizeStart.current
    if (!start) return
    resizeStart.current = null
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current)
      frame.current = null
    }
    // Flush the last pointer position even when release beats the next frame.
    if (start.nextWidth !== start.width) writeWidth(applyWidth(start.nextWidth))
    else setPreferredWidth(start.preference)
    if (start.element.hasPointerCapture(start.pointerID)) start.element.releasePointerCapture(start.pointerID)
  }, [applyWidth])

  useLayoutEffect(() => {
    if (!active) finishResize()
  }, [active, finishResize])

  useLayoutEffect(() => {
    const layout = element.current?.parentElement
    const activityBar = layout?.querySelector(".activity-bar")
    if (!layout || !activityBar) return
    let previous: { width: number; height: number; activity: number } | null = null
    const measure = () => {
      const box = layout.getBoundingClientRect()
      const activity = activityBar.getBoundingClientRect().width
      if (previous && (previous.width !== box.width || previous.height !== box.height || previous.activity !== activity)) finishResize()
      previous = { width: box.width, height: box.height, activity }
      setMaximumWidth(Math.max(minimumWidth, Math.floor(box.width / 2 - activity)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(layout)
    // Font settings change the activity rail's rem width independently.
    observer.observe(activityBar)
    return () => observer.disconnect()
  }, [finishResize])

  useLayoutEffect(() => {
    window.addEventListener("blur", finishResize)
    window.addEventListener("resize", finishResize)
    return () => {
      window.removeEventListener("blur", finishResize)
      window.removeEventListener("resize", finishResize)
      finishResize()
    }
  }, [finishResize])

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (!active || event.button !== 0 || !event.isPrimary || resizeStart.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    resizeStart.current = { pointerID: event.pointerId, element: event.currentTarget, width: currentWidth.current, preference: preferredWidth,
      maximum: currentMaximum.current, x: event.clientX, nextWidth: currentWidth.current }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    const start = resizeStart.current
    if (!start || start.pointerID !== event.pointerId) return
    start.nextWidth = clampWidth(start.width + event.clientX - start.x, start.maximum)
    // Coalesce high-frequency input into one React/layout update per frame.
    if (frame.current === null) frame.current = window.requestAnimationFrame(() => {
      frame.current = null
      if (resizeStart.current) applyWidth(resizeStart.current.nextWidth)
    })
  }

  function stopResize(event: PointerEvent<HTMLDivElement>) {
    if (resizeStart.current?.pointerID !== event.pointerId) return
    finishResize()
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    if (resizeStart.current) return
    writeWidth(applyWidth(currentWidth.current + (event.key === "ArrowLeft" ? -16 : 16)))
  }

  return { element, width, minimumWidth, maximumWidth, startResize, moveResize, stopResize,
    resizeWithKeyboard, resetWidth: () => { finishResize(); writeWidth(applyWidth(defaultWidth)) } }
}
