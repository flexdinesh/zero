import { useCallback, useLayoutEffect, useRef, type PointerEvent } from "react"

export interface ResizeDragSession {
  // Geometry belongs to the layout owner. Consume every move, including
  // clamped moves, before coalescing only the visual writes.
  move(event: PointerEvent<HTMLDivElement>): void
  render(): void
  commit(): void
  // Observe external constraints, never the dimension this drag changes.
  geometry: readonly Element[]
}

interface Drag {
  pointer: number
  element: HTMLDivElement
  session: ResizeDragSession
  frame: number | null
  disconnect(): void
}

function observeGeometry(elements: readonly Element[], finish: () => void): () => void {
  const initial = elements.map((element) => ({ element, box: element.getBoundingClientRect() }))
  const observer = new ResizeObserver(() => {
    if (initial.some(({ element, box }) => {
      const next = element.getBoundingClientRect()
      return next.width !== box.width || next.height !== box.height
    })) finish()
  })
  for (const element of elements) observer.observe(element)
  // Font Size is applied through this root property. Other root style writes
  // (including sidebar previews) need no computed-style or geometry read.
  const root = document.documentElement
  const font = root.style.getPropertyValue("--font-size-base")
  const fontSize = root.style.fontSize
  const fonts = new MutationObserver(() => {
    if (root.style.getPropertyValue("--font-size-base") !== font || root.style.fontSize !== fontSize) finish()
  })
  fonts.observe(root, { attributes: true, attributeFilter: ["style"] })
  window.addEventListener("resize", finish)
  window.addEventListener("blur", finish)
  return () => {
    observer.disconnect()
    fonts.disconnect()
    window.removeEventListener("resize", finish)
    window.removeEventListener("blur", finish)
  }
}

// Pointer capture, one visual frame, and idempotent completion. Owners supply
// the arithmetic and commit action; no transient geometry enters shared state.
export function useResizeDrag() {
  const current = useRef<Drag | null>(null)
  const finish = useCallback(() => {
    const drag = current.current
    if (!drag) return
    current.current = null
    drag.disconnect()
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame)
    try {
      // Release may beat the queued frame. Keep the latest valid geometry on
      // cancellation, lost capture, blur, hiding, and unmount as well.
      drag.session.render()
      drag.session.commit()
    } finally {
      if (drag.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer)
    }
  }, [])

  // Activity also runs layout-effect cleanup when it hides retained content.
  useLayoutEffect(() => finish, [finish])

  function start(event: PointerEvent<HTMLDivElement>, begin: () => ResizeDragSession | null) {
    if (event.button !== 0 || !event.isPrimary || current.current) return
    const session = begin()
    if (!session) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const drag: Drag = { pointer: event.pointerId, element: event.currentTarget, session, frame: null, disconnect: () => {} }
    current.current = drag
    drag.element.setPointerCapture(drag.pointer)
    drag.disconnect = observeGeometry(session.geometry, () => {
      // An obsolete observer delivery must not end a subsequently started drag.
      if (current.current === drag) finish()
    })
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const drag = current.current
    if (!drag || drag.pointer !== event.pointerId) return
    drag.session.move(event)
    if (drag.frame === null) drag.frame = window.requestAnimationFrame(() => {
      drag.frame = null
      if (current.current === drag) drag.session.render()
    })
  }

  function stop(event: PointerEvent<HTMLDivElement>) {
    if (current.current?.pointer === event.pointerId) finish()
  }

  return { start, move, stop, finish, isResizing: () => current.current !== null }
}
