import type { TreeData } from "@zero/contracts"
import { useCallback, useEffect, useState } from "react"

import { isAbort } from "../api/http.ts"
import { loadTree } from "../api/page-data.ts"

// treeStartDelay caps how long the tree waits for the live stream's first
// status. Read while live updates follow the project, its index is kept for
// the documents opened next (decision 0192).
const treeStartDelay = 1_000

export interface ProjectTree {
  // tree is the project's latest tree, or null until the first arrives.
  tree: TreeData | null
  // failure explains why the tree could not be read; a kept tree stays.
  failure: string
  // start reads the tree now: the live stream's first status calls it.
  start(): void
  // refresh rereads the tree, keeping the current one meanwhile.
  refresh(): void
}

// useProjectTree reads a project's file tree apart from its documents, so the
// workspace shows before a large folder's scan (decision 0192). Mount it
// once per project.
export function useProjectTree(project: string): ProjectTree {
  const [tree, setTree] = useState<TreeData | null>(null)
  const [failure, setFailure] = useState("")
  const [started, setStarted] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (started) return
    const timer = setTimeout(() => setStarted(true), treeStartDelay)
    return () => clearTimeout(timer)
  }, [started])

  useEffect(() => {
    if (!project || !started) return
    const controller = new AbortController()
    loadTree(project, controller.signal).then((result) => {
      if (result.kind === "tree") {
        setTree(result.tree)
        setFailure("")
      } else {
        setFailure(result.message)
      }
    }, (error: unknown) => {
      if (!isAbort(error)) setFailure("Could not load files.")
    })
    return () => controller.abort()
  }, [project, started, version])

  const start = useCallback(() => setStarted(true), [])
  const refresh = useCallback(() => setVersion((current) => current + 1), [])
  return { tree, failure, start, refresh }
}
