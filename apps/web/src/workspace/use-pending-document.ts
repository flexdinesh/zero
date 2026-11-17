import { useRouterState } from "@tanstack/react-router"
import type { PageData } from "@zero/contracts"

import { emptyPage } from "../api/page-data.ts"
import { legacyCompare, routeCompare } from "../features/source-control/compare.ts"
import { routeStep, routeWalkthrough } from "../features/walkthrough/walkthrough-steps.ts"
import { routeAt } from "./workspace-tabs.ts"

interface PendingDocument {
  path: string
  at: string
  preview: boolean
}

// Keep the project's tree and identity while the destination's file metadata
// and content are unknown. Old content must never appear under its new tab.
export function pendingDocumentPage(page: PageData, document: PendingDocument): PageData {
  return {
    ...emptyPage,
    roots: page.roots, sessionKey: page.sessionKey, project: page.project, rootName: page.rootName,
    repository: page.repository, projectKind: page.projectKind, branch: page.branch, worktrees: page.worktrees,
    tree: page.tree, fileCount: page.fileCount, warnings: page.warnings,
    selected: document.path, at: document.at,
  }
}

// Same-project file navigation can show its tab before its loader finishes.
// Project switches still wait for the destination's page before remounting.
export function usePendingDocument(project: string) {
  return useRouterState({ structuralSharing: true, select: (state) => {
    const search = state.location.search
    if (!state.isLoading || state.location.pathname !== "/view" || search.project !== project
      || typeof search.path !== "string" || !search.path || legacyCompare(search) || routeCompare(search)) return null
    return {
      path: search.path,
      at: routeAt(search.path, search.at) ?? "",
      preview: routeWalkthrough(search.wt) !== undefined && routeStep(search.step) !== undefined,
    }
  } })
}
