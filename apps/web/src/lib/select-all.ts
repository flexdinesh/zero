const mac = typeof navigator !== "undefined" && navigator.platform.includes("Mac")

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

// isSelectAllKey reports Select All: Cmd+A on macOS, Ctrl+A elsewhere
// (decision 0174).
export function isSelectAllKey(event: KeyLike, onMac: boolean): boolean {
  if (event.isComposing || event.altKey || event.shiftKey) return false
  const modifier = onMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return modifier && event.key.toLowerCase() === "a"
}

export function isSelectAll(event: KeyLike): boolean {
  return isSelectAllKey(event, mac)
}

// isTextField reports a target that takes typed text, whose Select All is
// its own.
export function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
}

// selectSpan selects from the start of first to the end of last.
export function selectSpan(first: Node, last: Node) {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStart(first, 0)
  range.setEnd(last, last.childNodes.length)
  selection.removeAllRanges()
  selection.addRange(range)
}

// spansAll reports a selection that reaches from the start of first to the
// end of last, or past them.
export function spansAll(selection: Selection | null, first: Node, last: Node): boolean {
  if (!selection || selection.rangeCount !== 1) return false
  const range = selection.getRangeAt(0)
  const whole = document.createRange()
  whole.setStart(first, 0)
  whole.setEnd(last, last.childNodes.length)
  return range.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, whole) >= 0
}
