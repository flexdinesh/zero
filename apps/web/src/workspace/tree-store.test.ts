import assert from "node:assert/strict"
import test from "node:test"

import type { TreeData } from "@zero/contracts"
import type { TreeLoadResult } from "../api/page-data.ts"
import { isAbort } from "../api/http.ts"
import { createTreeStore, withRouteTree } from "./tree-store.ts"

function tree(fileCount: number, unscanned = false): TreeData {
  return { project: "/work", tree: [], fileCount, empty: fileCount === 0, error: "", warnings: [], unscanned }
}

interface Read {
  project: string
  scan: boolean
  signal: AbortSignal
  settle(result: TreeLoadResult): void
}

// harness records every read the store starts; the test settles them.
function harness(confirmed: ReadonlySet<string> = new Set()) {
  const reads: Read[] = []
  const store = createTreeStore({
    load: (project, scan, signal) => new Promise<TreeLoadResult>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      reads.push({ project, scan, signal, settle: resolve })
    }),
    scan: (project) => confirmed.has(project),
  })
  return { reads, store }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error("expected a rejection")
}

test("a project's tree is read once, joined while pending and once settled", async () => {
  const { reads, store } = harness()
  const loader = store.start("/work/zero")
  const workspace = store.start("/work/zero")
  assert.equal(reads.length, 1)
  assert.equal(store.settled("/work/zero"), null)
  reads[0]?.settle({ kind: "tree", tree: tree(3) })
  assert.deepEqual(await loader, await workspace)
  assert.deepEqual(store.settled("/work/zero"), { kind: "tree", tree: tree(3) })
  await store.start("/work/zero")
  assert.equal(reads.length, 1)
  assert.equal(store.settled("/work/other"), null)
})

test("another project aborts the pending read", async () => {
  const { reads, store } = harness()
  const first = store.start("/work/zero")
  void store.start("/work/site")
  assert.equal(reads.length, 2)
  assert.equal(reads[0]?.signal.aborted, true)
  assert.equal(isAbort(await rejection(first)), true)
  assert.equal(reads[1]?.signal.aborted, false)
  assert.equal(store.settled("/work/zero"), null)
})

test("a reread replaces the read, keeping nothing of the old one", async () => {
  const { reads, store } = harness()
  void store.start("/work/zero")
  reads[0]?.settle({ kind: "tree", tree: tree(1) })
  await Promise.resolve()
  const pending = store.reread("/work/zero")
  assert.equal(reads.length, 2)
  const newer = store.reread("/work/zero")
  assert.equal(reads[1]?.signal.aborted, true)
  assert.equal(isAbort(await rejection(pending)), true)
  reads[2]?.settle({ kind: "tree", tree: tree(2) })
  assert.deepEqual(await newer, { kind: "tree", tree: tree(2) })
  assert.deepEqual(store.settled("/work/zero"), { kind: "tree", tree: tree(2) })
})

test("a confirmed broad folder is read with scan", () => {
  const { reads, store } = harness(new Set(["/home/me"]))
  void store.start("/home/me")
  void store.start("/work/zero")
  assert.deepEqual(reads.map((read) => [read.project, read.scan]), [["/home/me", true], ["/work/zero", false]])
})

test("an unmounted workspace's settled tree is dropped, so the next reads afresh", async () => {
  const { reads, store } = harness()
  void store.start("/work/zero")
  reads[0]?.settle({ kind: "tree", tree: tree(1) })
  await Promise.resolve()
  const unmount = store.mount("/work/zero")
  assert.equal(store.mounted(), "/work/zero")
  unmount()
  assert.equal(store.mounted(), null)
  assert.equal(store.settled("/work/zero"), null)
  void store.start("/work/zero")
  assert.equal(reads.length, 2)
})

// A clock the test moves, and a page the test settles.
function route(store: ReturnType<typeof harness>["store"], project: string, preload = false, controller = new AbortController()) {
  let page = (_value: string) => {}
  const loaded = withRouteTree(store, { project, preload, signal: controller.signal },
    () => new Promise<string>((resolve) => { page = resolve }), () => 0, 20)
  return { loaded, page: (value: string) => page(value), controller }
}

test("a route starts its project's tree beside the page and waits for it within the budget", async () => {
  const { reads, store } = harness()
  const first = route(store, "/work/zero")
  assert.equal(reads.length, 1)
  first.page("page")
  await Promise.resolve()
  reads[0]?.settle({ kind: "tree", tree: tree(4) })
  assert.equal(await first.loaded, "page")
  assert.equal(store.waitedOut("/work/zero"), false)
})

test("a slow tree is waited out and marked so", async () => {
  const { reads, store } = harness()
  const slow = route(store, "/work/zero")
  slow.page("page")
  assert.equal(await slow.loaded, "page")
  assert.equal(store.waitedOut("/work/zero"), true)
  assert.equal(reads[0]?.signal.aborted, false)
})

test("preloads and navigations within the mounted project start no tree", async () => {
  const { reads, store } = harness()
  const preload = route(store, "/work/zero", true)
  preload.page("page")
  await preload.loaded
  assert.equal(reads.length, 0)

  store.mount("/work/zero")
  const within = route(store, "/work/zero")
  within.page("page")
  await within.loaded
  assert.equal(reads.length, 0)

  const none = route(store, "")
  none.page("page")
  await none.loaded
  assert.equal(reads.length, 0)

  const other = route(store, "/work/site")
  assert.deepEqual(reads.map((read) => read.project), ["/work/site"])
  other.controller.abort()
  other.page("page")
  await other.loaded
  // An aborted route did not wait anything out.
  assert.equal(store.waitedOut("/work/site"), false)
})
