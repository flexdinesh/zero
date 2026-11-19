// Every guest page runs this before its own scripts (decisions 0175, 0176,
// 0177). The page is someone else's: the window is untrusted, so this script
// and the app talk only through Page.Eval, which calls window.__zeroReview.
// It draws nothing. It answers the page's facts for a screen capture and the
// element at a point for a comment's hint; both are the page's word, which
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

  // elementAt describes the element the page shows at a point in its
  // viewport, in CSS pixels. Frames are opaque; a shadow root's contents
  // answer as its host.
  const elementAt = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return stringify(null)
    const element = fromPoint.call(document, x, y)
    if (!element || /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(element.tagName)) return stringify(null)
    const selector = selectorOf(element)
    if (!selector) return stringify(null)
    const role = collapse((element.getAttribute("role") || "").split(/\s+/)[0] || implicitRole(element), 64)
    const described = { selector, tag: element.localName }
    if (role) described.role = role
    const name = accessibleName(element, role)
    if (name) described.name = name
    const text = safeText(element, 256)
    if (text) described.text = text
    const box = element.getBoundingClientRect()
    described.box = { x: box.x, y: box.y, width: box.width, height: box.height }
    return stringify(described)
  }

  // facts are what a capture records of the page: its title, the layout
  // viewport in CSS pixels, the device pixel ratio, and the scroll.
  const facts = () => stringify({
    title: collapse(document.title, 256),
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
    scrollX,
    scrollY,
  })

  const api = Object.freeze({ facts, elementAt })
  Object.defineProperty(window, "__zeroReview", { value: api, enumerable: false, configurable: false, writable: false })
})()
