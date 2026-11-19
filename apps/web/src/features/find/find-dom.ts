// DOM helpers for find in file (decision 0172): text ranges over rendered
// rows and blocks, a text index of rendered prose, highlights through the
// CSS Custom Highlight API, and scrolling a match into view.

// TextPiece places part of a text node, from nodeStart for length, at
// segmentStart in its segment's text.
interface TextPiece {
  node: Text
  nodeStart: number
  segmentStart: number
  length: number
}

// rangeIn maps [start, end) of a segment to a DOM range over its pieces.
function rangeIn(pieces: readonly TextPiece[], start: number, end: number): Range | null {
  let range: Range | null = null
  for (const piece of pieces) {
    const pieceEnd = piece.segmentStart + piece.length
    if (!range && start < pieceEnd) {
      range = document.createRange()
      range.setStart(piece.node, piece.nodeStart + start - piece.segmentStart)
    }
    if (range && end <= pieceEnd) {
      range.setEnd(piece.node, piece.nodeStart + end - piece.segmentStart)
      return range
    }
  }
  return null
}

function textPieces(element: Node): TextPiece[] {
  const pieces: TextPiece[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || node.length === 0) continue
    pieces.push({ node, nodeStart: 0, segmentStart: offset, length: node.length })
    offset += node.length
  }
  return pieces
}

// textRange maps [start, end) of an element's text to a range, null when
// its text is shorter.
export function textRange(element: Node, start: number, end: number): Range | null {
  return rangeIn(textPieces(element), start, end)
}

// Blocks start a new segment; their text never runs into a neighbor's.
const blockTags = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY",
  "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
])

// TextIndex is rendered prose as segments: each block's text, and each line
// of preformatted text, with the text nodes that hold it.
export interface TextIndex {
  segments: string[]
  range(segment: number, start: number, end: number): Range | null
}

// skipped is content find does not read: hidden, collapsed, or controls.
function skipped(element: Element, skip: string): boolean {
  if (element.matches(skip)) return true
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true
  const parent = element.parentElement
  return parent instanceof HTMLDetailsElement && !parent.open && element.tagName !== "SUMMARY"
}

// indexText reads root's rendered text in document order, skipping
// elements that match skip. Whitespace reads as spaces, as it renders.
export function indexText(root: Element, skip: string): TextIndex {
  const segments: string[] = []
  const pieces: TextPiece[][] = []
  let text = ""
  let current: TextPiece[] = []
  const flush = () => {
    if (current.length) {
      segments.push(text)
      pieces.push(current)
    }
    text = ""
    current = []
  }
  const append = (node: Text, from: number, to: number, value: string) => {
    if (to <= from) return
    current.push({ node, nodeStart: from, segmentStart: text.length, length: to - from })
    text += value
  }
  const visit = (node: Node, pre: boolean) => {
    if (node instanceof Text) {
      const value = node.data
      if (!pre) {
        append(node, 0, value.length, value.replace(/\s/g, " "))
        return
      }
      // Preformatted text reads line by line.
      let from = 0
      for (let newline = value.indexOf("\n"); newline >= 0; newline = value.indexOf("\n", from)) {
        append(node, from, newline, value.slice(from, newline))
        flush()
        from = newline + 1
      }
      append(node, from, value.length, value.slice(from))
      return
    }
    if (!(node instanceof Element) || skipped(node, skip)) return
    const block = blockTags.has(node.tagName)
    if (block) flush()
    const inPre = pre || node.tagName === "PRE"
    for (const child of node.childNodes) visit(child, inPre)
    if (block) flush()
  }
  visit(root, false)
  flush()
  return {
    segments,
    range(segment, start, end) {
      const list = pieces[segment]
      return list ? rangeIn(list, start, end) : null
    },
  }
}

const matchHighlight = "zero-find-match"
const currentHighlight = "zero-find-current"

export const highlightsSupported = typeof CSS !== "undefined" && "highlights" in CSS

// showHighlights paints every match and, above them, the current one.
export function showHighlights(matches: readonly Range[], current: readonly Range[]) {
  if (!highlightsSupported) return
  CSS.highlights.set(matchHighlight, new Highlight(...matches))
  const highlight = new Highlight(...current)
  highlight.priority = 1
  CSS.highlights.set(currentHighlight, highlight)
}

export function clearHighlights() {
  if (!highlightsSupported) return
  CSS.highlights.delete(matchHighlight)
  CSS.highlights.delete(currentHighlight)
}

// revealTop is where a revealed match lands: the pane's top third, as line
// anchors do.
const revealTop = 1 / 3

function horizontalScroller(element: Element | null, pane: Element): HTMLElement | null {
  for (let node = element; node && node !== pane; node = node.parentElement) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth) {
      const overflow = getComputedStyle(node).overflowX
      if (overflow === "auto" || overflow === "scroll") return node
    }
  }
  return null
}

// revealRect scrolls pane so a box shows: near its top third when off
// screen, and sideways in the nearest scroller, clear of a sticky gutter
// that ends at inset from the scroller's left.
export function revealRect(pane: HTMLElement, rect: DOMRect, from: Element | null, inset = 0) {
  const box = pane.getBoundingClientRect()
  if (rect.top < box.top || rect.bottom > box.bottom) pane.scrollTop += rect.top - box.top - pane.clientHeight * revealTop
  const scroller = horizontalScroller(from, pane)
  if (!scroller) return
  const side = scroller.getBoundingClientRect()
  const margin = Math.min(side.width / 4, rect.height * 4)
  if (rect.right > side.right) scroller.scrollLeft += rect.right - side.right + margin
  else if (rect.left < side.left + inset) scroller.scrollLeft -= side.left + inset - rect.left + margin
}

// topIn is a box's top in pane's scroll content.
export function topIn(pane: HTMLElement, rect: DOMRect): number {
  return rect.top - pane.getBoundingClientRect().top + pane.scrollTop
}

// observeText calls onChange once a frame while root's DOM changes.
export function observeText(root: Node, onChange: () => void): () => void {
  let frame = 0
  const observer = new MutationObserver(() => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      onChange()
    })
  })
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  return () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  }
}
