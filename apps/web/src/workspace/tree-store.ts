import { loadTree, type TreeLoadResult } from "../api/page-data.ts"
import { firstPaintBudget, remainingWait, settleWithin } from "./first-load.ts"
import { readMemory, scanConfirmed } from "./workspace-memory.ts"

// The tree store holds one project's tree read at a time, so the route
// loader can start it beside the page and the workspace take it up when it
// mounts (decision 0193).

export interface TreeStoreDeps {
  load(project: string, scan: boolean, signal: AbortSignal): Promise<TreeLoadResult>
  // scan reports whether this browser asked to scan the project's broad
  // folder; non-broad folders ignore the flag.
  scan(project: string): boolean
}

export interface TreeStore {
  // start joins the project's read, pending or settled, or starts one; a
  // pending read of another project is aborted.
  start(project: string): Promise<TreeLoadResult>
  // reread starts a fresh read of the project, replacing any it holds.
  reread(project: string): Promise<TreeLoadResult>
  // settled is the project's read once it has settled, else null.
  settled(project: string): TreeLoadResult | null
  // waitedOut reports that a loader waited out its budget for the
  // project's current read.
  waitedOut(project: string): boolean
  markWaitedOut(project: string): void
  // mount records the project whose workspace is mounted, until the
  // returned function unmounts it; an unmounted project's settled read is
  // dropped, so its next workspace reads afresh.
  mount(project: string): () => void
  // mounted is the project whose workspace is mounted, or null.
  mounted(): string | null
}

interface Entry {
  project: string
  scan: boolean
  controller: AbortController
  promise: Promise<TreeLoadResult>
  result: TreeLoadResult | null
  waitedOut: boolean
}

export function createTreeStore(deps: TreeStoreDeps): TreeStore {
  let entry: Entry | null = null
  let mountedProject: string | null = null

  const begin = (project: string, scan: boolean): Entry => {
    if (entry && entry.result === null) entry.controller.abort()
    const controller = new AbortController()
    const promise = deps.load(project, scan, controller.signal)
    const started: Entry = { project, scan, controller, promise, result: null, waitedOut: false }
    promise.then((result) => {
      started.result = result
    }, () => {
      // A failed or aborted read keeps nothing: the next start reads again.
      if (entry === started) entry = null
    })
    entry = started
    return started
  }

  const current = (project: string): Entry | null => entry?.project === project ? entry : null

  return {
    start(project) {
      const scan = deps.scan(project)
      const held = current(project)
      if (held && held.scan === scan) return held.promise
      return begin(project, scan).promise
    },
    reread(project) {
      return begin(project, deps.scan(project)).promise
    },
    settled(project) {
      return current(project)?.result ?? null
    },
    waitedOut(project) {
      return current(project)?.waitedOut ?? false
    },
    markWaitedOut(project) {
      const held = current(project)
      if (held) held.waitedOut = true
    },
    mount(project) {
      mountedProject = project
      return () => {
        if (mountedProject === project) mountedProject = null
        const held = current(project)
        if (held && held.result !== null) entry = null
      }
    },
    mounted() {
      return mountedProject
    },
  }
}

// treeStore is the page's one store: reads ask for a broad folder's tree
// once this browser confirmed scanning it.
export const treeStore: TreeStore = createTreeStore({
  load: (project, scan, signal) => loadTree(project, signal, scan),
  scan: (project) => scanConfirmed(readMemory(), project),
})

export interface RouteTree {
  project: string
  // preload is the loader's: preloads never start a tree.
  preload: boolean
  signal: AbortSignal
}

// withRouteTree runs a route's page load with its project's tree. On a real
// navigation to a project whose workspace is not mounted (first load or a
// project switch) it starts the tree beside the page, then, once the page
// has loaded, waits for the tree up to firstPaintBudget from its start, so
// a quick tree mounts with the workspace. Navigations within the mounted
// project leave the tree to the workspace and never wait.
export async function withRouteTree<T>(store: TreeStore, route: RouteTree, page: () => Promise<T>,
  now: () => number = () => performance.now(), budget = firstPaintBudget): Promise<T> {
  const startedAt = now()
  const tree = !route.preload && route.project !== "" && store.mounted() !== route.project ? store.start(route.project) : null
  const result = await page()
  if (tree && !await settleWithin(tree, remainingWait(startedAt, now(), budget), route.signal) && !route.signal.aborted) {
    store.markWaitedOut(route.project)
  }
  return result
}
