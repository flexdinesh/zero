// First paint (decisions 0192, 0193): what the first route draws before its
// loaders finish, and how long a loader holds the workspace for its tree.

// firstPaintBudget is how long, from a loader's start, the workspace waits
// for a newly shown project's tree: a tree that arrives in time mounts with
// the workspace, so a small project never shows a skeleton.
export const firstPaintBudget = 500

// remainingWait is what is left of budget at now for a wait started at
// startedAt; never negative, and a clock that went back spends nothing.
export function remainingWait(startedAt: number, now: number, budget: number): number {
  return Math.max(0, budget - Math.max(0, now - startedAt))
}

// loadsWorkspace reports whether a first route will show the workspace,
// and so whether its frame shows while it loads: / without a project or a
// repository asks which project to open, and paints at once.
export function loadsWorkspace(pathname: string, search: Readonly<Record<string, unknown>>): boolean {
  if (pathname === "/composer") return false
  if (pathname !== "/") return true
  return present(search.project) || present(search.repo)
}

function present(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== ""
}

// settleWithin reports whether promise settles, either way, within ms; an
// aborted signal stops the wait early.
export function settleWithin(promise: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (settled: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      resolve(settled)
    }
    const aborted = () => finish(false)
    const timer = setTimeout(() => finish(false), ms)
    signal?.addEventListener("abort", aborted, { once: true })
    promise.then(() => finish(true), () => finish(true))
  })
}
