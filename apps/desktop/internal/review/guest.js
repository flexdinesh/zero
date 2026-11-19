// Every guest page runs this before its own scripts (decisions 0175, 0176,
// 0177, 0180). The page is someone else's: the window is untrusted, so this
// script and the app talk only through Page.Eval, which calls
// window.__zeroReview. It draws nothing. It answers the page's facts and hit
// map for a screen capture, recorded in the same step, before the frame is
// taken and before focus leaves the page; both are the page's word, which
// the app validates and bounds, and never trusts.
(() => {
  if (window.top !== window || Object.prototype.hasOwnProperty.call(window, "__zeroReview")) return

  // The page's scripts run after this one and may replace these; what the
  // app reads stays this script's word as far as it can (decision 0175).
  const stringify = JSON.stringify.bind(JSON)
  const fromPoint = Document.prototype.elementFromPoint
  const selectAll = Document.prototype.querySelectorAll
  const encoder = new TextEncoder()

  const collapse = (text, limit) => {
    const value = (text || "").replace(/\s+/g, " ").trim()
    return value.length > limit ? value.slice(0, limit - 1) + "…" : value
  }

  // Never read (decision 0176): form field values, the text of fields and
  // editable regions, and anything a page marks as a password or a card.
  const guarded = "input, textarea, select, [contenteditable]:not([contenteditable=\"false\" i]), [type=\"password\" i], [autocomplete*=\"cc-\" i]"
  const isGuarded = (element) => element.isContentEditable || Boolean(element.closest(guarded))
  const unread = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "INPUT", "TEXTAREA", "SELECT", "OPTION"])

  // safeText is an element's text, skipping guarded and hidden subtrees.
  const safeText = (root, limit) => {
    let text = ""
    let visited = 0
    const walk = (node) => {
      if (text.length > limit * 2 || ++visited > 4000) return
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent + " "
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      if (unread.has(node.tagName) || node.isContentEditable || node.matches(guarded)) return
      if (node.hidden || node.getAttribute("aria-hidden") === "true") return
      const style = getComputedStyle(node)
      if (style.display === "none" || style.visibility === "hidden") return
      for (let child = node.firstChild; child; child = child.nextSibling) walk(child)
    }
    if (!isGuarded(root)) walk(root)
    return collapse(text, limit)
  }

  const implicitRole = (element) => {
    switch (element.tagName) {
      case "BUTTON": case "SUMMARY": return "button"
      case "A": return element.hasAttribute("href") ? "link" : ""
      case "SELECT": return "combobox"
      case "TEXTAREA": return "textbox"
      case "UL": case "OL": case "MENU": return "list"
      case "LI": return "listitem"
      case "NAV": return "navigation"
      case "MAIN": return "main"
      case "HEADER": return "banner"
      case "FOOTER": return "contentinfo"
      case "FORM": return "form"
      case "TABLE": return "table"
      case "DIALOG": return "dialog"
      case "IMG": return "img"
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading"
      case "INPUT": {
        const type = (element.getAttribute("type") || "text").toLowerCase()
        if (type === "checkbox" || type === "radio") return type
        if (type === "button" || type === "submit" || type === "reset") return "button"
        return type === "hidden" ? "" : "textbox"
      }
    }
    return ""
  }
  const named = new Set(["button", "link", "heading", "listitem", "menuitem", "option", "tab", "checkbox", "radio", "cell", "columnheader", "rowheader"])
  const accessibleName = (element, role) => {
    const label = element.getAttribute("aria-label")
    if (label) return collapse(label, 256)
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => {
        const owner = document.getElementById(id)
        return owner ? safeText(owner, 256) : ""
      }).join(" ")
      if (text.trim()) return collapse(text, 256)
    }
    for (const attribute of ["alt", "title", "placeholder"]) {
      const value = element.getAttribute(attribute)
      if (value) return collapse(value, 256)
    }
    if (element.labels && element.labels.length > 0) {
      return collapse(Array.from(element.labels, (owner) => safeText(owner, 256)).join(" "), 256)
    }
    return named.has(role) ? safeText(element, 256) : ""
  }

  const unique = (selector, element) => {
    try {
      const found = selectAll.call(document, selector)
      return found.length === 1 && found[0] === element
    } catch {
      return false
    }
  }
  const nthOfType = (element) => {
    let index = 1
    let others = false
    for (let sibling = element.parentElement?.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
      if (sibling === element) continue
      if (sibling.localName === element.localName) {
        others = true
        if (sibling.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) index++
      }
    }
    return others ? index : 0
  }
  // anchorOf is a selector that finds element alone by its test id or id.
  const anchorOf = (element) => {
    const testId = element.getAttribute("data-testid")
    if (testId && unique(`[data-testid="${CSS.escape(testId)}"]`, element)) return `[data-testid="${CSS.escape(testId)}"]`
    if (element.id && unique(`#${CSS.escape(element.id)}`, element)) return `#${CSS.escape(element.id)}`
    return ""
  }
  // selectorOf finds element alone, or answers "".
  const selectorOf = (element) => {
    const parts = []
    for (let node = element; node && parts.length < 24; node = node.parentElement) {
      const anchor = anchorOf(node)
      if (anchor) {
        parts.unshift(anchor)
        break
      }
      const nth = nthOfType(node)
      parts.unshift(nth ? `${CSS.escape(node.localName)}:nth-of-type(${nth})` : CSS.escape(node.localName))
      if (node === document.documentElement) break
    }
    const selector = parts.join(" > ")
    return unique(selector, element) && encoder.encode(selector).length <= 512 ? selector : ""
  }

  const roleOf = (element) => collapse((element.getAttribute("role") || "").split(/\s+/)[0] || implicitRole(element), 64)
  // A meaningful element is one a reviewer means when they click inside it:
  // it has a role, takes input, is replaced content, or the page names it.
  const replaced = new Set(["CANVAS", "SVG", "VIDEO", "IFRAME", "FRAME", "OBJECT", "EMBED", "IMG"])
  const meaningful = (element) => Boolean(roleOf(element)) || replaced.has(element.tagName.toUpperCase()) ||
    element.hasAttribute("data-testid") || Boolean(element.id) || element.hasAttribute("onclick") || element.hasAttribute("tabindex")

  // describe is an element's metadata (decision 0176): a unique selector,
  // its role, accessible name, and visible text, never a field's value.
  const describe = (element, entry) => {
    const selector = selectorOf(element)
    if (selector) entry.selector = selector
    const role = roleOf(element)
    if (role) entry.role = role
    const name = accessibleName(element, role)
    if (name) entry.name = name
    const text = safeText(element, 256)
    if (text) entry.text = text
  }

  // Elements whose overflow clips their descendants.
  const clips = (style) => style.overflowX !== "visible" || style.overflowY !== "visible" || style.contain.includes("paint")
  // visibleBox is the part of an element's border box the page shows: cut
  // to the viewport and to every ancestor that clips its overflow, up to a
  // fixed element, which only the viewport clips. null when nothing shows.
  const visibleBox = (element) => {
    const box = element.getBoundingClientRect()
    let left = Math.max(0, box.left)
    let top = Math.max(0, box.top)
    let right = Math.min(innerWidth, box.right)
    let bottom = Math.min(innerHeight, box.bottom)
    let fixed = getComputedStyle(element).position === "fixed"
    for (let node = element.parentElement; node && !fixed && node !== document.documentElement && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (clips(style)) {
        const outer = node.getBoundingClientRect()
        left = Math.max(left, outer.left + node.clientLeft)
        top = Math.max(top, outer.top + node.clientTop)
        right = Math.min(right, outer.left + node.clientLeft + node.clientWidth)
        bottom = Math.min(bottom, outer.top + node.clientTop + node.clientHeight)
      }
      if (style.position === "fixed") fixed = true
    }
    if (right - left < 1 || bottom - top < 1) return null
    return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right) - Math.floor(left), height: Math.ceil(bottom) - Math.floor(top) }
  }

  // Bounds of a capture's hit map: grid cells, elements, and the time
  // metadata may take before the rest go without it (decision 0180).
  const maxCells = 20000
  const maxElements = 2000
  const metadataBudget = 150

  // captured are the elements of the last capture, for its signature.
  let captured = []

  // signatureOf reads the layout the elements show now: their boxes, the
  // viewport, and the scroll. A capture compares it before and after the
  // screenshot, so the hit map and the pixels show the same page.
  const signatureOf = (elements) => {
    let hash = 2166136261
    const add = (value) => {
      const text = String(Math.round(value))
      for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
      hash = Math.imul(hash ^ 124, 16777619)
    }
    add(innerWidth); add(innerHeight); add(scrollX); add(scrollY)
    for (const element of elements) {
      if (!element.isConnected) {
        add(-1)
        continue
      }
      const box = element.getBoundingClientRect()
      add(box.x); add(box.y); add(box.width); add(box.height)
    }
    return (hash >>> 0).toString(16)
  }

  // capture records what a screen capture freezes, in one synchronous step
  // right before the app takes the frame (decisions 0176, 0180): the page's
  // title, layout viewport, device pixel ratio, and scroll, and a hit map.
  // The hit map is a grid of the topmost element at each cell's center and
  // those elements with their ancestors, parents first: each with its
  // visible box in CSS pixels of the viewport and, while time allows, its
  // metadata. Frames are opaque; a shadow root's contents answer as its host.
  const capture = () => {
    const width = innerWidth
    const height = innerHeight
    const step = Math.max(4, Math.ceil(Math.sqrt((width * height) / maxCells)))
    const columns = Math.ceil(width / step)
    const rows = Math.ceil(height / step)
    const found = new Map()
    const order = []
    // add records element and its ancestors while there is room, and
    // answers the nearest of them recorded.
    const add = (element) => {
      const chain = []
      for (let node = element; node && !found.has(node); node = node.parentElement) chain.push(node)
      let nearest = chain.length > 0 && chain[chain.length - 1].parentElement ? chain[chain.length - 1].parentElement : null
      for (let index = chain.length - 1; index >= 0; index--) {
        if (order.length >= maxElements) break
        found.set(chain[index], order.length)
        order.push(chain[index])
        nearest = chain[index]
      }
      return found.has(element) ? element : nearest
    }
    const cells = new Array(columns * rows).fill(null)
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = Math.min(width - 0.5, (column + 0.5) * step)
        const y = Math.min(height - 0.5, (row + 0.5) * step)
        const element = fromPoint.call(document, x, y)
        if (element) cells[row * columns + column] = add(element)
      }
    }
    // Parents come first: document order puts ancestors before descendants.
    order.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    const index = new Map(order.map((element, at) => [element, at]))
    const started = performance.now()
    const elements = order.map((element) => {
      let parent = -1
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (index.has(node)) {
          parent = index.get(node)
          break
        }
      }
      const entry = { parent, tag: element.localName.toLowerCase() }
      const box = visibleBox(element)
      if (box) entry.box = box
      if (meaningful(element)) entry.meaningful = true
      if (performance.now() - started < metadataBudget) describe(element, entry)
      return entry
    })
    captured = order
    return stringify({
      title: collapse(document.title, 256),
      width,
      height,
      devicePixelRatio,
      scrollX,
      scrollY,
      hits: { step, columns, rows, grid: cells.map((element) => (element ? index.get(element) : -1)), elements },
      signature: signatureOf(order),
    })
  }

  const signature = () => signatureOf(captured)

  const api = Object.freeze({ capture, signature })
  Object.defineProperty(window, "__zeroReview", { value: api, enumerable: false, configurable: false, writable: false })
})()
