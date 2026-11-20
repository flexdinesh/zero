// Every guest page runs this before its own scripts (decisions 0175, 0184).
// The page is someone else's: its web view is untrusted, so this script and
// the app talk only through Page.Eval. It gives the page a browser's history
// keys, which the web view has none of: Alt+Left and Alt+Right, on macOS
// Cmd+[ and Cmd+], and reload on F5. Ctrl/Cmd+R is the app's View menu's,
// which reloads the guest that shows.
(() => {
  if (window.top !== window || Object.prototype.hasOwnProperty.call(window, "__zeroBrowser")) return
  Object.defineProperty(window, "__zeroBrowser", { value: Object.freeze({}), enumerable: false, configurable: false, writable: false })

  const mac = /Mac/.test(navigator.platform)
  // historyMove is the move a key press asks for: -1 back, 1 forward, 0
  // reload, null for any other key.
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
  window.addEventListener("keydown", (event) => {
    const move = historyMove(event)
    if (move === null || event.repeat) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (move < 0) back()
    else if (move > 0) forward()
    else reload()
  }, true)
})()
