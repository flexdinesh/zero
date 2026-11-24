import { useRef, useState, type KeyboardEvent } from "react"

// useRovingRows moves focus through a listbox's options with the arrow keys,
// Home, and End; Enter activates the focused one. With remove, Delete and
// Backspace remove the focused one and focus moves to the row after it, or
// the last row.
export function useRovingRows(count: number, current: number, activate: (index: number) => void, remove?: (index: number) => void) {
  const container = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(-1)
  const tabIndex = focused >= 0 && focused < count ? focused : Math.max(0, current)
  function focusRow(index: number) {
    setFocused(index)
    container.current?.querySelectorAll<HTMLElement>("[role=option]")[index]?.focus()
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = tabIndex + (event.key === "ArrowDown" ? 1 : -1)
      if (next >= 0 && next < count) focusRow(next)
    } else if (event.key === "Home" || event.key === "End") {
      focusRow(event.key === "Home" ? 0 : count - 1)
    } else if (event.key === "Enter" || event.key === " ") {
      activate(tabIndex)
    } else if (remove && (event.key === "Delete" || event.key === "Backspace") && event.target instanceof HTMLElement && event.target.getAttribute("role") === "option") {
      const index = tabIndex
      remove(index)
      // The rows render without it first.
      requestAnimationFrame(() => focusRow(Math.min(index, count - 2)))
    } else {
      return
    }
    event.preventDefault()
  }
  return { container, tabIndex, setFocused, onKeyDown }
}
