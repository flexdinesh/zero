import { isPlainLanguage } from "../../highlighting/syntax-highlight.ts"
import { highlightFence } from "../../highlighting/use-highlighted-lines.ts"

// A fence owns only its completion label. Controls subscribe independently so
// finishing one fence does not update every portal in a large document.
export function createPreviewFence(code: HTMLElement, language: string | null, source: string) {
  let label: string | null = null
  const listeners = new Set<() => void>()
  return {
    code, language, source,
    snapshot: () => label,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    complete() {
      label = language
      for (const listener of listeners) listener()
    },
  }
}

export type PreviewFence = ReturnType<typeof createPreviewFence>

// Partition at visual newline boundaries, using the worker's markup budget. All
// chunks retain their original line endings, including a final missing newline.
// A row is indivisible; one unusually long row may exceed the markup target.
export function fenceHighlightChunks(source: string, lines: readonly string[]): Array<{ source: string; html: string }> | null {
  const rows = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []
  if (rows.length > 1 && rows.at(-1) === "") rows.pop()
  if (rows.length !== lines.length || lines.length === 0) return null
  const chunks: Array<{ source: string; html: string }> = []
  let chunk = { source: "", html: "" }
  let count = 0
  for (const [index, line] of lines.entries()) {
    const row = rows[index] ?? ""
    const ending = /(?:\r\n|\r|\n)$/.exec(row)?.[0] ?? ""
    // HTML parsing normalizes literal CRs. Character references preserve them.
    const html = line + ending.replaceAll("\r", "&#13;")
    // A bare CR is source data, not a visual break in preformatted DOM text.
    // Keep those worker rows together rather than introducing block breaks.
    if (chunk.source.endsWith("\n") && (count >= 100 || chunk.html.length + html.length > 16_384)) {
      chunks.push(chunk)
      chunk = { source: "", html: "" }
      count = 0
    }
    chunk.source += row
    chunk.html += html
    count++
  }
  chunks.push(chunk)
  return chunks
}

function applyHighlight(fence: PreviewFence, lines: readonly string[], signal: AbortSignal): Promise<boolean> {
  const chunks = fenceHighlightChunks(fence.source, lines)
  if (!chunks || signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let frame = 0
    let offset = 0
    let elements: HTMLElement[] | undefined
    const finish = (complete: boolean) => {
      cancelAnimationFrame(frame)
      signal.removeEventListener("abort", onAbort)
      document.removeEventListener("selectionchange", onSelectionChange)
      resolve(complete)
    }
    const onAbort = () => finish(false)
    const onSelectionChange = () => {
      document.removeEventListener("selectionchange", onSelectionChange)
      frame = requestAnimationFrame(apply)
    }
    const apply = () => {
      if (signal.aborted) { finish(false); return }
      // Replacing selected text nodes collapses native selection and Find
      // ranges. Leave them intact until the user moves or clears the range.
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)).some((range) => range.intersectsNode(fence.code))) {
        document.addEventListener("selectionchange", onSelectionChange)
        return
      }
      if (!elements) {
        elements = chunks.map((chunk) => {
          const element = document.createElement("span")
          element.className = "preview-fence-chunk"
          const text = document.createElement("span")
          text.className = "preview-fence-chunk-text"
          text.textContent = chunk.source
          element.append(text)
          return text
        })
        // Every byte remains present throughout highlighting. Stable block
        // boundaries contain layout work within the chunk being replaced.
        // Outer chunks retain the pre's line-box strut; inner inline spans
        // retain the original code typography, including live font changes.
        fence.code.classList.add("preview-fence-chunks")
        fence.code.replaceChildren(...elements.flatMap((element) => element.parentElement ? [element.parentElement] : []))
        frame = requestAnimationFrame(apply)
        return
      }
      const chunk = chunks[offset]
      const element = elements[offset]
      if (!chunk || !element) { finish(false); return }
      const template = document.createElement("template")
      template.innerHTML = chunk.html
      const text = template.content.textContent ?? ""
      // Never let malformed output change the source's spelling or line breaks.
      if (text !== chunk.source) { finish(false); return }
      element.replaceChildren(template.content)
      offset++
      if (offset === chunks.length) finish(true)
      else frame = requestAnimationFrame(apply)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    frame = requestAnimationFrame(apply)
  })
}

// Find this preview's scroll owner once. Previews also appear in independently
// scrolling narration and feedback, not only the main document pane.
export function previewScrollRoot(article: HTMLElement): Element | null {
  for (let parent = article.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) return parent
  }
  return null
}

export function schedulePreviewFences(fences: readonly PreviewFence[], root: Element | null): () => void {
  const eligible = fences.filter((fence) => fence.language !== null && !isPlainLanguage(fence.language))
  if (eligible.length === 0) return () => {}
  const pending = new Set<PreviewFence>()
  const attempted = new Set<PreviewFence>()
  let active: AbortController | null = null
  let frame = 0
  let stopped = false
  let observer: IntersectionObserver | undefined

  const schedule = () => {
    if (!stopped && active === null && frame === 0 && pending.size > 0) frame = requestAnimationFrame(run)
  }
  const run = () => {
    frame = 0
    let next = pending.values().next().value
    if (observer) {
      const bounds = root?.getBoundingClientRect()
      const top = bounds?.top ?? 0
      const bottom = bounds?.bottom ?? window.innerHeight
      // An intersecting near fence can become visible without crossing the
      // observer's threshold. Refresh priorities when work is dispatched.
      const candidates = [...pending].map((fence) => {
        const rectangle = fence.code.getBoundingClientRect()
        return { fence, visible: rectangle.bottom > top && rectangle.top < bottom, distance: Math.abs(rectangle.top - top) }
      })
      candidates.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance)
      next = candidates[0]?.fence
    }
    if (stopped || !next || next.language === null) return
    pending.delete(next)
    attempted.add(next)
    const controller = new AbortController()
    active = controller
    void highlightFence(next.source, next.language, controller.signal).then(async (lines) => {
      if (stopped || controller.signal.aborted || !lines) return
      const applied = await applyHighlight(next, lines, controller.signal)
      if (applied && !stopped && !controller.signal.aborted) next.complete()
    }).catch(() => {
      // Optional presentation failure leaves the complete source readable.
    }).finally(() => {
      if (active === controller) active = null
      observer?.unobserve(next.code.parentElement ?? next.code)
      schedule()
    })
  }

  if (typeof IntersectionObserver === "undefined") {
    for (const fence of eligible) pending.add(fence)
    schedule()
  } else {
    const targets = new Map<Element, PreviewFence>(eligible.map((fence) => [fence.code.parentElement ?? fence.code, fence]))
    observer = new IntersectionObserver((entries) => {
      if (stopped) return
      for (const entry of entries) {
        const fence = targets.get(entry.target)
        if (!fence || attempted.has(fence)) continue
        if (!entry.isIntersecting) pending.delete(fence)
        else pending.add(fence)
      }
      schedule()
    }, { root, rootMargin: "300px 0px" })
    for (const target of targets.keys()) observer.observe(target)
  }

  return () => {
    stopped = true
    observer?.disconnect()
    cancelAnimationFrame(frame)
    pending.clear()
    active?.abort()
  }
}
