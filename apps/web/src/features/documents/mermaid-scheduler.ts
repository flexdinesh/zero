// Every compile gets a browser task. Cancellation also guards a callback that
// has already been queued for delivery.
export function scheduleMermaidTask(compile: () => void, delay = 0): () => void {
  let cancelled = false
  const timer = setTimeout(() => {
    if (!cancelled) compile()
  }, delay)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

// A scheduler belongs to one source and renderer lifetime. Keep its last SVG
// while later widths settle; observing the same rounded width is a no-op.
export function createMermaidWidthScheduler(compile: (width: number) => void) {
  let observedWidth = 0
  let compiledWidth: number | null = null
  let cancelPending: (() => void) | null = null
  let disposed = false

  return {
    resize(width: number) {
      if (disposed) return
      const roundedWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0
      if (roundedWidth === observedWidth) return
      observedWidth = roundedWidth
      cancelPending?.()
      cancelPending = null
      if (roundedWidth === 0 || roundedWidth === compiledWidth) return

      cancelPending = scheduleMermaidTask(() => {
        cancelPending = null
        compiledWidth = roundedWidth
        compile(roundedWidth)
      }, compiledWidth === null ? 0 : 150)
    },
    dispose() {
      disposed = true
      cancelPending?.()
      cancelPending = null
    },
  }
}
