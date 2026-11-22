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
// several worktrees carries them for inline expansion. An identity keeps
// only that repository's checkouts (decision 0188).
export function projectListSections(response: ProjectsResponse, remembered: readonly string[], current: string, query: string, identity = ""): ProjectListSection[] {
  const filtering = query.trim() !== ""
  const listed = identity ? onlyIdentity(response, identity) : response
  // Folders opened by hand are not checkouts of the identity; remembered
  // checkouts still pick the worktree a repository row opens.
  const opened = identity ? remembered.filter((id) => listed.projects.some((project) => project.id === id)) : remembered
  return projectSections(listed, opened, current, query).flatMap((section): ProjectListSection[] => {
    const rows = section.rows.flatMap((row): ProjectListEntry[] => {
      // Unreadable roots are no checkout of the identity.
      if (row.kind !== "project" || (identity && row.problem !== "")) return []
      const members = !filtering && row.worktrees > 1
        ? projectSections(listed, opened, current, "", row.group).flatMap((group) => group.rows)
          .flatMap((member) => member.kind === "project" ? [member] : [])
        : []
      return [{ row, worktrees: members }]
    })
    return rows.length ? [{ title: section.title, rows }] : []
  })
}

// onlyIdentity keeps the projects of one repository identity.
function onlyIdentity(response: ProjectsResponse, identity: string): ProjectsResponse {
  return { ...response, projects: response.projects.filter((project) => project.identity === identity) }
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
