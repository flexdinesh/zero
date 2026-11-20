// Every guest page runs this before its own scripts (decisions 0175, 0176,
// 0184). The page is someone else's: its web view is untrusted, so this
// script and the app talk only through Page.Eval, which calls
// window.__zeroBrowser. What it answers is the page's word, which the app
// validates and bounds, and never trusts.
//
// It gives the page a browser's history keys, which the web view has none
// of. In comment mode it swallows the page's input, outlines the element
// under the pointer, and answers the element or region the reviewer picks,
// with what it can say of it. It draws the pick's outline and the pins of
// earlier comments in a closed shadow root. It never draws the composer:
// that is a page of the app's, in a web view of its own.
(() => {
  if (window.top !== window || Object.prototype.hasOwnProperty.call(window, "__zeroBrowser")) return

  // The page's scripts run after this one and may replace these; what the
  // app reads stays this script's word as far as it can (decision 0175).
  const stringify = JSON.stringify.bind(JSON)
  const parse = JSON.parse.bind(JSON)
  const fromPoint = Document.prototype.elementFromPoint
  const selectAll = Document.prototype.querySelectorAll
  const selectOne = Document.prototype.querySelector
  const computed = window.getComputedStyle.bind(window)
  const frame = window.requestAnimationFrame.bind(window)
  const encoder = new TextEncoder()
  const mac = /Mac/.test(navigator.platform)

  // --- history keys ---

  // historyMove is the move a key press asks for: -1 back, 1 forward, 0
  // reload, null for any other key. Ctrl/Cmd+R is the app's View menu's,
  // which reloads the guest that shows.
  const historyMove = (event) => {
    const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (event.key === "F5" && !event.altKey && !event.metaKey) return 0
    if (event.shiftKey) return null
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === "ArrowLeft") return -1
      if (event.key === "ArrowRight") return 1
    }
    if (mac && primary && !event.altKey) {
      if (event.code === "BracketLeft") return -1
      if (event.code === "BracketRight") return 1
    }
    return null
  }
  const back = history.back.bind(history)
  const forward = history.forward.bind(history)
  const reload = location.reload.bind(location)

  // --- what the page says of an element ---

  const collapse = (text, limit) => {
    const value = (text || "").replace(/\s+/g, " ").trim()
    return value.length > limit ? value.slice(0, limit - 1) + "…" : value
  }
  // cut bounds text by its UTF-8 bytes.
  const cut = (text, bytes) => {
    let value = text
    while (encoder.encode(value).length > bytes) value = value.slice(0, Math.max(0, value.length - Math.ceil((encoder.encode(value).length - bytes) / 4) - 1))
    return value
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
      const style = computed(node)
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
  const roleOf = (element) => collapse((element.getAttribute("role") || "").split(/\s+/)[0] || implicitRole(element), 64)

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

  // classesOf is an element's class names, without the hashes build tools
  // add past a readable name ("card_x7Hq2" stays; a bare hash goes).
  const classesOf = (element) => {
    const value = typeof element.className === "string" ? element.className : element.getAttribute("class") || ""
    return cut(collapse(value, 256), 256)
  }
  // step names one element of a path: its tag, id, or first two classes.
  const step = (element) => {
    const tag = element.localName.toLowerCase()
    if (element.id) return `${tag}#${element.id}`
    const classes = classesOf(element).split(" ").filter(Boolean).slice(0, 2)
    return classes.length > 0 ? `${tag}.${classes.join(".")}` : tag
  }
  // pathOf is the chain of ancestors a reader follows to the element,
  // outermost first, at most six steps: "main › form.settings › button".
  const pathOf = (element) => {
    const steps = []
    for (let node = element; node && node !== document.body && node !== document.documentElement && steps.length < 6; node = node.parentElement) {
      steps.unshift(collapse(step(node), 80))
    }
    return cut(steps.join(" › "), 512)
  }

  // The attributes a comment may carry: what names, links, or states an
  // element, never a value a person typed.
  const carried = ["id", "data-testid", "name", "type", "href", "src", "for", "aria-label", "aria-describedby", "aria-expanded", "aria-selected", "aria-checked", "aria-current", "aria-disabled", "aria-invalid", "disabled", "data-state", "title", "alt", "placeholder"]
  const attributesOf = (element) => {
    const found = []
    for (const name of carried) {
      if (found.length >= 8 || !element.hasAttribute(name)) continue
      let value = element.getAttribute(name) || ""
      // A link's query and fragment may carry secrets; its path says enough.
      if (name === "href" || name === "src") value = value.split(/[?#]/)[0]
      found.push({ name, value: cut(collapse(value, 256), 256) })
    }
    return found
  }

  // The computed styles a comment carries: what a reviewer talks about.
  const styled = ["color", "background-color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "padding", "margin", "border", "border-radius", "box-shadow", "opacity", "display", "position", "width", "height", "gap", "flex-direction", "align-items", "justify-content", "overflow", "z-index"]
  const plain = new Map([["letter-spacing", "normal"], ["text-align", "start"], ["box-shadow", "none"], ["opacity", "1"], ["position", "static"], ["gap", "normal"], ["overflow", "visible"], ["z-index", "auto"], ["border-radius", "0px"], ["padding", "0px"], ["margin", "0px"], ["background-color", "rgba(0, 0, 0, 0)"]])
  const flexOnly = new Set(["flex-direction", "align-items", "justify-content", "gap"])
  const stylesOf = (element) => {
    const style = computed(element)
    const flexible = /flex|grid/.test(style.display)
    const found = []
    for (const name of styled) {
      const value = collapse(style.getPropertyValue(name), 128)
      if (!value || plain.get(name) === value) continue
      if (flexOnly.has(name) && !flexible) continue
      if (name === "border" && /^0px /.test(value)) continue
      found.push({ name, value })
    }
    return found
  }

  // frameworkOf reads what a framework's development build leaves on an
  // element: the chain of components that rendered it, outermost first, and
  // where its source is. Production builds leave neither.
  const frameworkOf = (element) => {
    const result = { component: "", source: "" }
    try {
      const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"))
      if (key) {
        const names = []
        for (let fiber = element[key], depth = 0; fiber && depth < 200; fiber = fiber.return, depth++) {
          const type = fiber.type
          const name = typeof type === "function" ? type.displayName || type.name : type && typeof type === "object" ? type.displayName || (type.render && (type.render.displayName || type.render.name)) || (type.type && (type.type.displayName || type.type.name)) : ""
          if (typeof name === "string" && name && names[0] !== name && names.length < 6) names.unshift(name)
          const source = fiber._debugSource
          if (!result.source && source && typeof source.fileName === "string") {
            result.source = source.fileName + (Number.isInteger(source.lineNumber) ? ":" + source.lineNumber : "")
          }
        }
        result.component = names.join(" › ")
      }
      for (let node = element; node && !result.component; node = node.parentElement) {
        const instance = node.__vueParentComponent
        if (!instance) continue
        const names = []
        for (let owner = instance, depth = 0; owner && depth < 50; owner = owner.parent, depth++) {
          const type = owner.type || {}
          const name = type.name || type.__name || (typeof type.__file === "string" ? type.__file.split("/").pop().replace(/\.vue$/, "") : "")
          if (name && names.length < 6) names.unshift(name)
          if (!result.source && typeof type.__file === "string") result.source = type.__file
        }
        result.component = names.join(" › ")
      }
      for (let node = element; node && !result.source; node = node.parentElement) {
        const meta = node.__svelte_meta
        if (meta && meta.loc && typeof meta.loc.file === "string") {
          result.source = meta.loc.file + (Number.isInteger(meta.loc.line) ? ":" + meta.loc.line : "")
        }
        const marked = node.getAttribute("data-source") || node.getAttribute("data-inspector-relative-path")
        if (!result.source && marked) {
          const line = node.getAttribute("data-inspector-line")
          result.source = marked + (line && !marked.includes(":") ? ":" + line : "")
        }
      }
    } catch {
      // A page that guards these says nothing.
    }
    return { component: cut(collapse(result.component, 256), 256), source: cut(collapse(result.source, 512), 512) }
  }

  // nearbyOf is the text around an element: its siblings', which says where
  // a "Save" among many is.
  const nearbyOf = (element) => {
    const parts = []
    for (const sibling of [element.previousElementSibling, element.nextElementSibling]) {
      if (!sibling) continue
      const text = safeText(sibling, 100)
      if (text) parts.push(text)
    }
    if (parts.length === 0 && element.parentElement && element.parentElement !== document.body) {
      // A parent that says no more than the element says nothing of where.
      const text = safeText(element.parentElement, 200)
      if (text && text !== safeText(element, 200)) parts.push(text)
    }
    return collapse(parts.join(" · "), 256)
  }

  // selectedOf is the text the reviewer selected inside element, never a
  // field's.
  const selectedOf = (element) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ""
    const range = selection.getRangeAt(0)
    const owner = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
    if (!owner || isGuarded(owner) || !(element.contains(owner) || owner.contains(element))) return ""
    return collapse(selection.toString(), 256)
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
    let fixed = computed(element).position === "fixed"
    for (let node = element.parentElement; node && !fixed && node !== document.documentElement && node !== document.body; node = node.parentElement) {
      const style = computed(node)
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

  // factsOf is everything a comment carries of an element (decisions 0176,
  // 0184), each part bounded here and again by the app.
  const factsOf = (element, box) => {
    const facts = { tag: element.localName.toLowerCase(), box }
    const selector = selectorOf(element)
    if (selector) facts.selector = selector
    const role = roleOf(element)
    if (role) facts.role = role
    const name = accessibleName(element, role)
    if (name) facts.name = name
    const text = safeText(element, 256)
    if (text) facts.text = text
    const path = pathOf(element)
    if (path) facts.path = path
    const classes = classesOf(element)
    if (classes) facts.classes = classes
    const attributes = attributesOf(element)
    if (attributes.length > 0) facts.attributes = attributes
    const styles = stylesOf(element)
    if (styles.length > 0) facts.styles = styles
    const framework = frameworkOf(element)
    if (framework.component) facts.component = framework.component
    if (framework.source) facts.source = framework.source
    const nearby = nearbyOf(element)
    if (nearby) facts.nearby = nearby
    const selected = selectedOf(element)
    if (selected) facts.selectedText = selected
    return facts
  }

  const colorScheme = () => {
    try {
      const declared = computed(document.documentElement).colorScheme || ""
      if (/\bdark\b/.test(declared) && !/\blight\b/.test(declared)) return "dark"
      if (/\blight\b/.test(declared) && !/\bdark\b/.test(declared)) return "light"
      // A page that declares none says it by its background.
      const match = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(computed(document.body || document.documentElement).backgroundColor)
      if (match && (match[4] === undefined || Number(match[4]) > 0.5)) {
        return 0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3]) < 128 ? "dark" : "light"
      }
    } catch {
      // Light is what a page without styles is.
    }
    return "light"
  }
  const pageFacts = () => ({
    title: collapse(document.title, 256),
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
    scrollX,
    scrollY,
    colorScheme: colorScheme(),
  })

  // --- what this script draws ---

  // Colors are fixed: the page's own theme is unknown, and a white halo
  // keeps the accent readable on any of them.
  const accent = "#325dc8"
  const quiet = "#5f6672"
  let host = null
  let layer = null
  let outline = null
  let chip = null
  let pinLayer = null
  const paint = (element, styles) => {
    for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value)
    return element
  }
  // ensureLayer builds the overlay once the page has a root. Styles go
  // through the CSSOM, which a page's content security policy allows.
  const ensureLayer = () => {
    if (host && host.isConnected) return true
    if (!document.documentElement) return false
    host = document.createElement("zero-browser-overlay")
    paint(host, { all: "initial", position: "fixed", inset: "0", "z-index": "2147483647", "pointer-events": "none", contain: "strict" })
    const root = host.attachShadow({ mode: "closed" })
    layer = paint(document.createElement("div"), { position: "absolute", inset: "0", overflow: "hidden", font: "500 12px/16px system-ui, sans-serif" })
    outline = paint(document.createElement("div"), { position: "absolute", display: "none", "box-sizing": "border-box", border: `2px solid ${accent}`, "border-radius": "2px", "box-shadow": "0 0 0 1px rgba(255, 255, 255, 0.9), inset 0 0 0 1px rgba(255, 255, 255, 0.5)" })
    chip = paint(document.createElement("div"), { position: "absolute", display: "none", "max-width": "min(420px, 90vw)", padding: "2px 6px", background: accent, color: "#ffffff", "border-radius": "2px", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis", "box-shadow": "0 0 0 1px rgba(255, 255, 255, 0.9)" })
    pinLayer = paint(document.createElement("div"), { position: "absolute", inset: "0" })
    layer.append(outline, chip, pinLayer)
    root.append(layer)
    document.documentElement.append(host)
    return true
  }

  // crosshair shows comment mode at the pointer, through a constructed
  // sheet: no style element for the page's policy to refuse.
  let crosshair = null
  const setCrosshair = (on) => {
    try {
      if (!crosshair) {
        crosshair = new CSSStyleSheet()
        crosshair.replaceSync("*, *::before, *::after { cursor: crosshair !important }")
      }
      const sheets = document.adoptedStyleSheets.filter((sheet) => sheet !== crosshair)
      document.adoptedStyleSheets = on ? [...sheets, crosshair] : sheets
    } catch {
      // The pointer keeps the page's cursor.
    }
  }

  const chipText = (element, box) => {
    const role = roleOf(element)
    const name = accessibleName(element, role) || safeText(element, 40)
    const what = role || step(element)
    const label = name ? `${what} “${collapse(name, 40)}”` : what
    return `${collapse(label, 64)}  ${box.width} × ${box.height}`
  }
  const drawOutline = (box, text) => {
    if (!ensureLayer()) return
    paint(outline, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` })
    if (!text) {
      chip.style.display = "none"
      return
    }
    chip.textContent = text
    paint(chip, { display: "block", left: "0px", top: "0px" })
    const size = chip.getBoundingClientRect()
    const above = box.y - size.height - 4
    const top = above >= 2 ? above : Math.min(innerHeight - size.height - 2, box.y + box.height + 4)
    const left = Math.max(2, Math.min(box.x, innerWidth - size.width - 2))
    paint(chip, { left: `${left}px`, top: `${top}px` })
  }
  const clearOutline = () => {
    if (!host) return
    outline.style.display = "none"
    chip.style.display = "none"
  }

  // --- pins ---

  let pins = []
  let pinsVisible = false
  let pinTimer = 0
  const pinElements = new Map()
  const placePins = () => {
    if (!host || !pinLayer) return
    const shown = pinsVisible && !hiddenForCapture
    for (const pin of pins) {
      let button = pinElements.get(pin.thread)
      if (!button) {
        button = paint(document.createElement("button"), { position: "absolute", display: "none", "box-sizing": "border-box", "min-width": "20px", height: "20px", padding: "0 5px", border: "0", "border-radius": "3px", color: "#ffffff", font: "600 11px/20px system-ui, sans-serif", "text-align": "center", cursor: "pointer", "pointer-events": "auto", "box-shadow": "0 0 0 1px rgba(255, 255, 255, 0.9), 0 1px 3px rgba(0, 0, 0, 0.35)" })
        button.type = "button"
        button.textContent = String(pin.thread)
        button.setAttribute("aria-label", `Comment ${pin.thread}`)
        const thread = pin.thread
        button.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          emit({ type: "pin", thread })
        })
        pinLayer.append(button)
        pinElements.set(pin.thread, button)
      }
      button.style.background = pin.resolved ? quiet : accent
      let at = null
      if (pin.selector) {
        let target = null
        try {
          target = selectOne.call(document, pin.selector)
        } catch {
          target = null
        }
        const box = target ? visibleBox(target) : null
        if (box) at = { x: box.x + box.width - 10, y: box.y - 10 }
      } else {
        at = { x: pin.x - scrollX - 10, y: pin.y - scrollY - 10 }
      }
      if (!shown || !at || at.x < -20 || at.y < -20 || at.x > innerWidth || at.y > innerHeight) {
        button.style.display = "none"
        continue
      }
      paint(button, { display: "block", left: `${Math.max(2, Math.min(at.x, innerWidth - 22))}px`, top: `${Math.max(2, Math.min(at.y, innerHeight - 22))}px` })
    }
  }
  const setPins = (raw, visible) => {
    let next = []
    try {
      const parsed = parse(raw)
      if (Array.isArray(parsed)) next = parsed.filter((pin) => pin && Number.isInteger(pin.thread)).slice(0, 200)
    } catch {
      next = []
    }
    const kept = new Set(next.map((pin) => pin.thread))
    for (const [thread, button] of pinElements) {
      if (kept.has(thread)) continue
      button.remove()
      pinElements.delete(thread)
    }
    pins = next
    pinsVisible = visible === true
    clearInterval(pinTimer)
    pinTimer = 0
    if (pins.length > 0 && pinsVisible && ensureLayer()) {
      // Layout moves under pins without an event to say so.
      pinTimer = setInterval(placePins, 500)
    }
    placePins()
    return true
  }

  // --- events for the app ---

  // The app awaits next() and asks again: each answer is one event. Events
  // wait here while it is between two asks.
  const queue = []
  let waiting = null
  const emit = (event) => {
    const text = stringify(event)
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve(text)
      return
    }
    if (queue.length < 32) queue.push(text)
  }
  const next = () => new Promise((resolve) => {
    if (queue.length > 0) {
      resolve(queue.shift())
      return
    }
    // A second ask replaces the first, which answers nothing.
    if (waiting) waiting(stringify({ type: "replaced" }))
    waiting = resolve
  })

  // --- comment mode ---

  // mode is "off", "pick" (the pointer outlines and a click picks), or
  // "held" (a pick waits for its comment: the page stays still).
  let mode = "off"
  let pointer = null
  // hover is the chain the reviewer walks: hover[0] is the element under
  // the pointer, and Alt+Up adds its parents.
  let hover = []
  // picked is the chain of the held pick; region is its rectangle when the
  // reviewer dragged one.
  let picked = []
  let region = null
  let press = null
  let dragging = false
  let hiddenForCapture = false

  const isOurs = (element) => element === host
  const pickable = (element) => {
    if (!element || isOurs(element)) return null
    if (element === document.documentElement || element === document.body) return element
    return element
  }
  // parentOf is the next ancestor that shows a different box.
  const parentOf = (element) => {
    const box = visibleBox(element)
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const outer = visibleBox(node)
      if (outer && (!box || outer.x !== box.x || outer.y !== box.y || outer.width !== box.width || outer.height !== box.height)) return node
    }
    return null
  }
  const current = (chain) => chain[chain.length - 1] || null

  const showHover = () => {
    const element = current(hover)
    const box = element ? visibleBox(element) : null
    if (!element || !box) {
      clearOutline()
      return
    }
    drawOutline(box, chipText(element, box))
  }
  const hoverAt = (x, y) => {
    const element = pickable(fromPoint.call(document, x, y))
    if (element !== hover[0]) hover = element ? [element] : []
    showHover()
  }

  // selection describes the held pick for the app.
  const selection = () => {
    if (region) {
      const center = fromPoint.call(document, region.x + region.width / 2, region.y + region.height / 2)
      const element = pickable(center)
      const box = element ? visibleBox(element) : null
      return { type: "pick", kind: "region", rect: region, element: element && box ? factsOf(element, box) : null, canWalkUp: false, canWalkDown: false, page: pageFacts() }
    }
    const element = current(picked)
    const box = element && element.isConnected ? visibleBox(element) : null
    if (!element || !box) return null
    return { type: "pick", kind: "element", rect: box, element: factsOf(element, box), canWalkUp: parentOf(element) !== null, canWalkDown: picked.length > 1, page: pageFacts() }
  }

  // hold freezes a pick: everything this script drew goes, two frames pass
  // so the page paints without it, and then the app hears of the pick and
  // takes the frame.
  const hold = () => {
    mode = "held"
    hiddenForCapture = true
    clearOutline()
    placePins()
    setCrosshair(false)
    frame(() => frame(() => {
      const picked = selection()
      if (!picked) {
        resume()
        return
      }
      emit(picked)
    }))
  }
  // mark draws the held pick again, once the app has its frame.
  const mark = () => {
    if (mode !== "held") return false
    hiddenForCapture = false
    placePins()
    const element = region ? null : current(picked)
    const box = region || (element ? visibleBox(element) : null)
    if (box) drawOutline(box, element ? chipText(element, box) : `Region  ${box.width} × ${box.height}`)
    return true
  }
  // walk moves the held pick to its parent or back, and answers it.
  const walk = (direction) => {
    if (mode !== "held" || region) return stringify(null)
    const element = current(picked)
    if (direction === "parent") {
      const parent = element ? parentOf(element) : null
      if (parent) picked.push(parent)
    } else if (picked.length > 1) {
      picked.pop()
    }
    mark()
    return stringify(selection())
  }
  // resume leaves a held pick: back to picking in comment mode.
  const resume = () => {
    hiddenForCapture = false
    picked = []
    region = null
    clearOutline()
    placePins()
    if (mode !== "held") return true
    mode = "pick"
    setCrosshair(true)
    if (pointer) hoverAt(pointer.x, pointer.y)
    return true
  }
  // comment turns comment mode on or off. Turned on over selected text, it
  // picks that text at once.
  const comment = (on) => {
    if (!on) {
      mode = "off"
      hover = []
      picked = []
      region = null
      press = null
      dragging = false
      hiddenForCapture = false
      clearOutline()
      placePins()
      setCrosshair(false)
      return true
    }
    if (mode !== "off") return true
    if (!ensureLayer()) return false
    mode = "pick"
    setCrosshair(true)
    const selected = window.getSelection()
    if (selected && !selected.isCollapsed && selected.rangeCount > 0) {
      const range = selected.getRangeAt(0)
      const owner = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
      const box = range.getBoundingClientRect()
      const left = Math.max(0, Math.floor(box.left))
      const top = Math.max(0, Math.floor(box.top))
      const right = Math.min(innerWidth, Math.ceil(box.right))
      const bottom = Math.min(innerHeight, Math.ceil(box.bottom))
      if (owner && !isGuarded(owner) && right - left >= 1 && bottom - top >= 1) {
        region = { x: left, y: top, width: right - left, height: bottom - top }
        hold()
        return true
      }
    }
    if (pointer) hoverAt(pointer.x, pointer.y)
    return true
  }

  // In comment mode the page hears none of the reviewer's input: it would
  // press buttons and follow links. Pins stay clickable.
  const swallow = (event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onPointerMove = (event) => {
    pointer = { x: event.clientX, y: event.clientY }
    if (mode !== "pick" || isOurs(event.target)) return
    swallow(event)
    if (press && (dragging || Math.abs(event.clientX - press.x) > 4 || Math.abs(event.clientY - press.y) > 4)) {
      dragging = true
      const x = Math.max(0, Math.min(press.x, event.clientX))
      const y = Math.max(0, Math.min(press.y, event.clientY))
      const right = Math.min(innerWidth, Math.max(press.x, event.clientX))
      const bottom = Math.min(innerHeight, Math.max(press.y, event.clientY))
      const box = { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(right - x)), height: Math.max(1, Math.round(bottom - y)) }
      drawOutline(box, `Region  ${box.width} × ${box.height}`)
      return
    }
    hoverAt(event.clientX, event.clientY)
  }
  const onPointerDown = (event) => {
    if (mode === "off" || isOurs(event.target)) return
    swallow(event)
    if (mode === "held") {
      // The composer has the reviewer's words: it takes the keyboard back.
      emit({ type: "focus" })
      return
    }
    if (event.button === 0) press = { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event) => {
    if (mode === "off" || isOurs(event.target)) return
    swallow(event)
    if (mode !== "pick" || !press) return
    const start = press
    press = null
    if (dragging) {
      dragging = false
      const x = Math.max(0, Math.min(start.x, event.clientX))
      const y = Math.max(0, Math.min(start.y, event.clientY))
      const right = Math.min(innerWidth, Math.max(start.x, event.clientX))
      const bottom = Math.min(innerHeight, Math.max(start.y, event.clientY))
      if (right - x >= 8 && bottom - y >= 8) {
        region = { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) }
        hold()
        return
      }
    }
    hoverAt(event.clientX, event.clientY)
    if (hover.length === 0) return
    picked = hover.slice()
    hold()
  }
  const onKeyDown = (event) => {
    if (mode === "off") {
      const move = historyMove(event)
      if (move === null || event.repeat) return
      swallow(event)
      if (move < 0) back()
      else if (move > 0) forward()
      else reload()
      return
    }
    // Keys with Ctrl or Cmd are the app's menu's or the system's.
    if (event.ctrlKey || event.metaKey) return
    swallow(event)
    if (event.repeat) return
    if (event.key === "Escape") {
      emit({ type: mode === "held" ? "escape" : "cancel" })
      return
    }
    if (mode !== "pick" || !event.altKey) return
    if (event.key === "ArrowUp") {
      const parent = current(hover) ? parentOf(current(hover)) : null
      if (parent) hover.push(parent)
      showHover()
    } else if (event.key === "ArrowDown" && hover.length > 1) {
      hover.pop()
      showHover()
    }
  }
  const onInput = (event) => {
    if (mode === "off" || isOurs(event.target)) return
    swallow(event)
  }
  const onMoved = () => {
    if (pins.length > 0) placePins()
    if (mode === "pick" && pointer && !dragging) hoverAt(pointer.x, pointer.y)
    else if (mode === "held") mark()
  }
  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("pointerup", onPointerUp, true)
  window.addEventListener("keydown", onKeyDown, true)
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "keyup", "keypress", "touchstart", "touchend", "dragstart", "selectstart", "pointerover", "pointerout", "pointerenter", "pointerleave", "mouseover", "mouseout", "mouseenter", "mouseleave", "mousemove", "focusin"]) {
    window.addEventListener(type, onInput, true)
  }
  // A held pick stays where its comment is being written.
  window.addEventListener("wheel", (event) => {
    if (mode === "held") event.preventDefault()
  }, { capture: true, passive: false })
  window.addEventListener("scroll", onMoved, { capture: true, passive: true })
  window.addEventListener("resize", onMoved, { passive: true })

  const api = Object.freeze({ next, comment, mark, walk, resume, pins: setPins })
  Object.defineProperty(window, "__zeroBrowser", { value: api, enumerable: false, configurable: false, writable: false })
})()
