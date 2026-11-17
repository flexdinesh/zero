import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

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

export function useSidebarResize() {
  const element = useRef<HTMLDivElement>(null)
  const [preferredWidth, setPreferredWidth] = useState(readWidth)
  const [maximumWidth, setMaximumWidth] = useState(() => Math.max(minimumWidth, Math.floor(window.innerWidth / 2)))
  // A smaller window constrains display without replacing the saved preference.
  const width = clampWidth(preferredWidth, maximumWidth)
  const currentWidth = useRef(width)
  const currentMaximum = useRef(maximumWidth)
  const frame = useRef<number | null>(null)
  const resizeStart = useRef<{ pointerID: number; element: HTMLDivElement; width: number; x: number; nextWidth: number } | null>(null)

  useLayoutEffect(() => {
    const layout = element.current?.parentElement
    const activityBar = layout?.querySelector(".activity-bar")
    if (!layout || !activityBar) return
    const measure = () => setMaximumWidth(Math.max(minimumWidth,
      Math.floor(layout.getBoundingClientRect().width / 2 - activityBar.getBoundingClientRect().width)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(layout)
    // Font settings change the rail's rem width independently of the window.
    observer.observe(activityBar)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    currentWidth.current = width
    currentMaximum.current = maximumWidth
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`)
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
    writeWidth(applyWidth(start.nextWidth))
    if (start.element.hasPointerCapture(start.pointerID)) start.element.releasePointerCapture(start.pointerID)
  }, [applyWidth])

  useEffect(() => {
    window.addEventListener("blur", finishResize)
    return () => {
      window.removeEventListener("blur", finishResize)
      finishResize()
    }
  }, [finishResize])

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || resizeStart.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    resizeStart.current = { pointerID: event.pointerId, element: event.currentTarget, width: currentWidth.current, x: event.clientX, nextWidth: currentWidth.current }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    const start = resizeStart.current
    if (!start || start.pointerID !== event.pointerId) return
    start.nextWidth = clampWidth(start.width + event.clientX - start.x, currentMaximum.current)
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
    resizeWithKeyboard, resetWidth: () => { writeWidth(applyWidth(defaultWidth)) } }
}
