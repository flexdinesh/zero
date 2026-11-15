import {
  isDirectoriesResponse, isOpenedRoot, isProjectsResponse, isRemovedRoot,
  type DirectoriesResponse, type OpenedRoot, type ProjectsResponse, type RemovedRoot,
} from "@zero/contracts"

import { deleteJSON, failureReason, fetchJSON, postJSON } from "./http.ts"
import { within } from "../features/projects/project-picker.ts"
import { lastProject, type WorkspaceMemory } from "../workspace/workspace-memory.ts"

export function fetchProjects(signal?: AbortSignal): Promise<ProjectsResponse> {
  return fetchJSON("/api/projects", { signal }, isProjectsResponse, (failure) => `Couldn't list projects: ${failureReason(failure)}.`)
}

// Server reasons for folders are full sentences.
export function fetchDirectories(path: string, signal?: AbortSignal): Promise<DirectoriesResponse> {
  return fetchJSON(`/api/directories?${new URLSearchParams({ path }).toString()}`, { signal }, isDirectoriesResponse,
    (failure) => failure.kind === "rejected" ? failure.error : "Could not read that folder.")
}

// openRoot asks the server to serve a folder on its host (decision 0146);
// its refusals are full sentences.
export function openRoot(path: string, signal?: AbortSignal): Promise<OpenedRoot> {
  return postJSON("/api/roots", { path }, { signal }, isOpenedRoot,
    (failure) => failure.kind === "rejected" ? failure.error : `Couldn't open the folder: ${failureReason(failure)}.`)
}

// removeRoot asks the server to stop serving a root (decision 0146).
export function removeRoot(root: string, signal?: AbortSignal): Promise<RemovedRoot> {
  return deleteJSON(`/api/roots?${new URLSearchParams({ path: root }).toString()}`, { signal }, isRemovedRoot,
    (failure) => failure.kind === "rejected" ? failure.error : `Couldn't stop serving the folder: ${failureReason(failure)}.`)
}

// Landing is what a URL without a project shows (decision 0153): the only
// project there is, or the choice among them.
export type Landing =
  | { kind: "open"; project: string }
  | { kind: "choose" }

// defaultProject is the first served root, always listed as a project.
export function defaultProject(projects: ProjectsResponse): string {
  return projects.roots[0]?.path ?? ""
}

// landing opens the one available project and otherwise asks: a link that
// names no project never opens one the user did not choose.
export function landing(projects: ProjectsResponse): Landing {
  const available = projects.projects.filter((project) => project.available)
  const only = available.length === 1 ? available[0] : undefined
  return only ? { kind: "open", project: only.id } : { kind: "choose" }
}

// lastOpened is the project last opened in this session while a served root
// still holds it, or "" (decision 0153).
export function lastOpened(projects: ProjectsResponse, memory: WorkspaceMemory): string {
  const last = lastProject(memory, projects.sessionKey)
  if (!last) return ""
  const listed = projects.projects.some((project) => project.available && project.id === last)
  return listed || projects.roots.some((root) => within(last, root.path)) ? last : ""
}
