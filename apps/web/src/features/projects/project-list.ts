import type { ProjectsResponse } from "@zero/contracts"

import { projectSections, type ProjectRow } from "./project-picker.ts"

// Pure list logic for ProjectList.tsx, which Welcome (decision 0052) and
// the choose-project page (decision 0153) render.

export interface ProjectListSection {
  title: string
  rows: ProjectListEntry[]
}

export interface ProjectListEntry {
  row: ProjectRow
  // worktrees lists a repository's members when it has several, else none.
  worktrees: ProjectRow[]
}

// projectListSections are the picker's sections without its Browse actions:
// a query flattens them into ranked matches; otherwise each repository with
// several worktrees carries them for inline expansion.
export function projectListSections(response: ProjectsResponse, remembered: readonly string[], current: string, query: string): ProjectListSection[] {
  const filtering = query.trim() !== ""
  return projectSections(response, remembered, current, query).flatMap((section): ProjectListSection[] => {
    const rows = section.rows.flatMap((row): ProjectListEntry[] => {
      if (row.kind !== "project") return []
      const members = !filtering && row.worktrees > 1
        ? projectSections(response, remembered, current, "", row.group).flatMap((group) => group.rows)
          .flatMap((member) => member.kind === "project" ? [member] : [])
        : []
      return [{ row, worktrees: members }]
    })
    return rows.length ? [{ title: section.title, rows }] : []
  })
}

// holdsLast reports whether an entry stands for the last opened project: the
// row itself, or one of the worktrees it collapses.
export function holdsLast(entry: ProjectListEntry, last: string): boolean {
  return last !== "" && (entry.row.id === last || entry.worktrees.some((member) => member.id === last))
}

// enterTarget is the project Enter in the filter opens: the last opened one
// while the filter is empty and it is listed, else the first row that opens.
export function enterTarget(sections: readonly ProjectListSection[], last: string, query: string): string {
  const entries = sections.flatMap((section) => section.rows)
  if (!query.trim() && entries.some((entry) => holdsLast(entry, last))) return last
  return entries.find((entry) => !entry.row.disabled)?.row.id ?? ""
}
