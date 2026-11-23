import type { TreeData } from "@zero/contracts"
import { useCallback, useEffect, useRef, useState } from "react"

import { isAbort } from "../api/http.ts"
import type { TreeLoadResult } from "../api/page-data.ts"
import { treeStore, type TreeStore } from "./tree-store.ts"
import { readMemory, rememberScan, scanConfirmed, updateMemory } from "./workspace-memory.ts"

export interface ProjectTree {
  // tree is the project's latest tree, or null until the first arrives.
  tree: TreeData | null
  // failure explains why the tree could not be read; a kept tree stays.
  failure: string
  // waited reports that the route waited out its first-paint budget for
  // this tree: its skeleton shows at once, continuing the frame's.
  waited: boolean
  // scanConfirmed reports that this browser asked to scan the project's
  // broad folder (decision 0194).
  scanConfirmed: boolean
  // refresh rereads the tree, keeping the current one meanwhile.
  refresh(): void
  // scan confirms scanning the project's broad folder, remembered in this
  // browser, and reads its tree.
  scan(): void
}

interface TreeState {
  tree: TreeData | null
  failure: string
}

function stateOf(result: TreeLoadResult | null): TreeState {
  if (result === null) return { tree: null, failure: "" }
  return result.kind === "tree" ? { tree: result.tree, failure: "" } : { tree: null, failure: result.message }
}

// useProjectTree reads a project's file tree apart from its documents, so the
// workspace shows before a large folder's scan (decision 0192). The route
// loader starts the read beside the page; a tree it already has mounts with
// the workspace (decision 0193). Mount it once per project.
export function useProjectTree(project: string, store: TreeStore = treeStore): ProjectTree {
  const [state, setState] = useState<TreeState>(() => stateOf(store.settled(project)))
  const [waited] = useState(() => store.waitedOut(project))
  const [confirmed, setConfirmed] = useState(() => scanConfirmed(readMemory(), project))
  const live = useRef(true)

  const take = useCallback((read: Promise<TreeLoadResult>) => {
    read.then((result) => {
      if (!live.current) return
      // A failed reread keeps the tree it had; the tree it has is kept as is.
      setState((current) => result.kind === "tree"
        ? current.tree === result.tree && !current.failure ? current : { tree: result.tree, failure: "" }
        : { tree: current.tree, failure: result.message })
    }, (error: unknown) => {
      if (live.current && !isAbort(error)) setState((current) => ({ tree: current.tree, failure: "Could not load files." }))
    })
  }, [])

  useEffect(() => {
    live.current = true
    if (!project) return
    const unmount = store.mount(project)
    // Join the loader's read, settled or pending, or read now when the
    // route started none.
    take(store.start(project))
    return () => {
      live.current = false
      unmount()
    }
  }, [project, store, take])

  const refresh = useCallback(() => {
    if (project) take(store.reread(project))
  }, [project, store, take])
  const scan = useCallback(() => {
    if (!project) return
    updateMemory((memory) => rememberScan(memory, project))
    setConfirmed(true)
    // The unscanned tree gives way to the loading one.
    setState({ tree: null, failure: "" })
    take(store.reread(project))
  }, [project, store, take])
  return { tree: state.tree, failure: state.failure, waited, scanConfirmed: confirmed, refresh, scan }
}
