import { isPageData, isTreeData, type PageData, type TreeData, type TreeNode } from "@zero/contracts"

import type { PageLoadResult } from "./page-contract.ts"

import { fetchJSON, RequestError, type RequestFailure } from "./http.ts"
import { projectUrl } from "./project-url.ts"

export { isPageLoadResult } from "./page-contract.ts"
export type { PageLoadResult } from "./page-contract.ts"

export const emptyPage: PageData = {
  roots: [],
  sessionKey: "",
  project: "",
  projectUnavailable: false,
  documentType: null,
  navigationSupported: false,
  binary: false,
  tooLarge: false,
  previewDisabled: false,
  searchExcluded: false,
  highlightDisabled: false,
  previewError: "",
  content: "",
  error: "",
  fileSize: 0,
  hasFile: false,
  rootName: "",
  repository: "",
  identity: "",
  projectKind: "folder",
  branch: "",
  worktrees: 0,
  selected: "",
  at: "",
  source: "",
}

interface LoadPageOptions {
  pathname: string
  project: string
  selected: string
  // at reads selected from that commit instead of the working tree.
  at?: string
  signal: AbortSignal
}

export async function loadPage({ pathname, project, selected, at = "", signal }: LoadPageOptions): Promise<PageLoadResult> {
  let endpoint = projectUrl("/api/page", project, pathname === "/view" ? selected : undefined)
  if (pathname === "/view" && at) endpoint += `&at=${at}`

  try {
    // Pages carry their own error, so any status with a page is a page.
    return { kind: "page", page: await fetchJSON(endpoint, { signal, anyStatus: true }, isPageData, pageError) }
  } catch (error: unknown) {
    if (error instanceof RequestError) return { kind: "failure", message: error.message }
    throw error
  }
}

// TreeLoadResult is a project's tree, read apart from its documents so the
// workspace shows before a large folder's scan (decision 0192).
export type TreeLoadResult = { kind: "tree"; tree: TreeData } | { kind: "failure"; message: string }

export async function loadTree(project: string, signal: AbortSignal): Promise<TreeLoadResult> {
  try {
    // Trees carry their own error, so any status with a tree is a tree.
    return { kind: "tree", tree: await fetchJSON(projectUrl("/api/tree", project), { signal, anyStatus: true }, isTreeData, treeError) }
  } catch (error: unknown) {
    if (error instanceof RequestError) return { kind: "failure", message: error.message }
    throw error
  }
}

function treeError(failure: RequestFailure): string {
  return failure.kind === "unreachable" || failure.kind === "malformed"
    ? "Could not load files."
    : "The server returned an invalid tree response."
}

function pageError(failure: RequestFailure): string {
  return failure.kind === "unreachable" || failure.kind === "malformed"
    ? "Could not load files."
    : "The server returned an invalid page response."
}

export function filePaths(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => node.isDir ? filePaths(node.children) : [node.path])
}

export function openDirectoryPaths(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.isDir && node.open ? [node.path] : []),
    ...openDirectoryPaths(node.children),
  ])
}
