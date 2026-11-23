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

// Landing is what a URL without a project shows (decisions 0153, 0191): the
// choice among the projects, or, serving no folder, the workspace's
// no-folder state.
export type Landing =
  | { kind: "choose" }
  | { kind: "none" }

// defaultProject is the first served root, always listed as a project.
export function defaultProject(projects: ProjectsResponse): string {
  return projects.roots[0]?.path ?? ""
}

// landing always asks: a link that names no project opens nothing the user
// did not choose, not even the only project (decision 0191), so a large
// folder is never scanned implicitly.
export function landing(projects: ProjectsResponse): Landing {
  return projects.roots.length === 0 ? { kind: "none" } : { kind: "choose" }
}

// repoKey is a repo= link value as identities are compared: links carry
// identities as the server normalizes them ("github.com/owner/repo",
// lowercase), so only case and surrounding space are forgiven.
export function repoKey(repo: string): string {
  return repo.trim().toLowerCase()
}

// checkoutsOf lists the available projects whose repository has the
// identity.
export function checkoutsOf(projects: ProjectsResponse, repo: string): string[] {
  const key = repoKey(repo)
  if (!key) return []
  return projects.projects.filter((project) => project.available && project.identity === key).map((project) => project.id)
}

// RepoLanding is where a link that names a repository identity lands
// (repo=, decision 0188): a checkout to open, or the choice among several,
// or none on this server.
export type RepoLanding =
  | { kind: "open"; project: string }
  | { kind: "choose" }
  | { kind: "missing" }

// repoLanding resolves a link's repo= and optional project=. The project
// opens when this server serves it and its repository has the link's
// identity or none (a folder, or no remote); one that is another repository
// here, as on a computer with another layout, gives way to the identity.
// Otherwise one checkout of the identity opens, several ask.
export function repoLanding(projects: ProjectsResponse, project: string, repo: string): RepoLanding {
  const key = repoKey(repo)
  if (project) {
    const listed = projects.projects.find((candidate) => candidate.available && candidate.id === project)
    const opens = listed
      ? listed.identity === "" || listed.identity === key
      : projects.roots.some((root) => within(project, root.path))
    if (opens) return { kind: "open", project }
  }
  const [only, ...others] = checkoutsOf(projects, key)
  if (only === undefined) return { kind: "missing" }
  return others.length === 0 ? { kind: "open", project: only } : { kind: "choose" }
}

// lastOpened is the project last opened in this session while a served root
// still holds it, or "" (decision 0153).
export function lastOpened(projects: ProjectsResponse, memory: WorkspaceMemory): string {
  const last = lastProject(memory, projects.sessionKey)
  if (!last) return ""
  const listed = projects.projects.some((project) => project.available && project.id === last)
  return listed || projects.roots.some((root) => within(last, root.path)) ? last : ""
}
