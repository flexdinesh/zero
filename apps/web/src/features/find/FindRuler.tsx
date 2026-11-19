import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react"

import { useFindTicks } from "./FindProvider.tsx"

interface Lane {
  top: number
  height: number
  right: number
}

// FindRuler marks every match along the document pane's right edge while
// find is open, the current one in accent, as VS Code's overview ruler
// does (decision 0172). It takes no pointer: the overlay scrollbar's thumb
// stays draggable above it.
export function FindRuler({ pane }: { pane: RefObject<HTMLElement | null> }) {
  const store = useFindTicks()
  const { ticks, current } = useSyncExternalStore(store.subscribe, store.get, store.get)
  const lane = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Lane | null>(null)
  const shown = ticks.length > 0
  useLayoutEffect(() => {
    const root = pane.current
    const parent = lane.current?.offsetParent
    if (!shown || !root || !(parent instanceof HTMLElement)) return
    const measure = () => {
      const outer = parent.getBoundingClientRect()
      const inner = root.getBoundingClientRect()
      setBox({ top: inner.top - outer.top, height: root.clientHeight, right: outer.right - inner.right })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [pane, shown])
  if (!shown) return null
  return (
    <div ref={lane} className="find-ruler" aria-hidden="true"
      style={box ? { top: box.top, height: box.height, right: box.right } : { visibility: "hidden" }}>
      {ticks.map((tick) => <span key={tick} className="find-ruler-tick" style={{ top: `${tick * 100}%` }} />)}
      {current !== null && <span className="find-ruler-tick" data-current="" style={{ top: `${current * 100}%` }} />}
    </div>
  )
}
