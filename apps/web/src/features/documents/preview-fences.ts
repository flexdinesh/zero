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

// A row is indivisible; an unusually long plain row may exceed the markup
// target. Highlights already bounds tokenization per line (decision 0029).
export function fenceHighlightBatch(lines: readonly string[], start: number): { html: string; next: number } {
  let html = ""
  let next = start
  while (next < lines.length && next - start < 100) {
    const line = lines[next] ?? ""
    if (next > start && html.length + line.length + 1 > 16_384) break
    html += `${next > start ? "\n" : ""}${line}`
    next++
  }
  return { html, next }
}

function applyHighlight(fence: PreviewFence, lines: readonly string[], signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let frame = 0
    let offset = 0
    // Keep the unprocessed source in one text node throughout progressive
    // replacement. Copy and browser Find always see the complete text.
    let plain = document.createTextNode(fence.source)
    const finish = (complete: boolean) => {
      cancelAnimationFrame(frame)
      signal.removeEventListener("abort", onAbort)
      resolve(complete)
    }
    const onAbort = () => finish(false)
    const apply = () => {
      if (signal.aborted) { finish(false); return }
      const batch = fenceHighlightBatch(lines, offset)
      const template = document.createElement("template")
      template.innerHTML = batch.html + (batch.next < lines.length || fence.source.endsWith("\n") ? "\n" : "")
      const text = template.content.textContent ?? ""
      // Never let malformed output change the source's spelling or line breaks.
      if (!plain.data.startsWith(text)) { finish(false); return }
      const remaining = plain.splitText(text.length)
      plain.replaceWith(template.content)
      plain = remaining
      offset = batch.next
      if (offset === lines.length) {
        const complete = plain.length === 0
        if (complete) plain.remove()
        finish(complete)
      } else frame = requestAnimationFrame(apply)
    }
    if (signal.aborted || lines.length === 0) { resolve(false); return }
    fence.code.replaceChildren(plain)
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
