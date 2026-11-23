// Browser memory of project workspaces. Projects are absolute paths, so each
// project's tabs and folder expansion are shared by sessions that serve it; the last
// project is kept per session key (/api/projects sessionKey). Pure functions return new values;
// readMemory/writeMemory are the only storage access and never throw.

import { isRecord } from "../api/http.ts"
import { includesTab, offeredTab, parseStoredTab, sameTab, storedTab, welcomeTab, type StoredTab, type TabFeatures, type WorkspaceTab } from "./workspace-tabs.ts"

export const MEMORY_STORAGE_KEY = "zero-workspaces-v2"

const maxProjects = 100
const maxSessions = 20

export interface ProjectMemory {
  // Tabs are stored as plain paths (documents), {diff: path}, or
  // {commit: hash, path}; "" is no active tab.
  tabs: StoredTab[]
  active: StoredTab
  // Absent uses the server's initial expansion; [] remembers all collapsed.
  expanded?: string[]
  // scan records that this browser asked to scan the project's broad
  // folder (home and the like), so its tree loads (decision 0194).
  scan?: true
}

export interface WorkspaceMemory {
  // last maps a session key to the project last open in that session.
  last: Record<string, string>
  projects: Record<string, ProjectMemory>
}

export const emptyMemory: WorkspaceMemory = { last: {}, projects: {} }

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry: unknown) => typeof entry === "string") : []
}

function storedTabs(value: unknown): StoredTab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    const tab = parseStoredTab(entry)
    return tab ? [storedTab(tab)] : []
  })
}

function parseProject(value: unknown): ProjectMemory | null {
  if (!isRecord(value)) return null
  const active = parseStoredTab(value.active)
  return {
    tabs: storedTabs(value.tabs),
    active: active ? storedTab(active) : "",
    ...(Array.isArray(value.expanded) ? { expanded: stringArray(value.expanded) } : {}),
    ...(value.scan === true ? { scan: true } : {}),
  }
}

function entries(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value).filter(([key]) => key !== "__proto__") : []
}

// parseMemory keeps every well-formed entry of untrusted stored data.
export function parseMemory(value: unknown): WorkspaceMemory {
  if (!isRecord(value)) return emptyMemory
  const last: Record<string, string> = {}
  for (const [key, project] of entries(value.last)) {
    if (typeof project === "string") last[key] = project
  }
  const projects: Record<string, ProjectMemory> = {}
  for (const [id, entry] of entries(value.projects)) {
    const project = parseProject(entry)
    if (project) projects[id] = project
  }
  return { last, projects }
}

export function lastProject(memory: WorkspaceMemory, key: string): string {
  return Object.hasOwn(memory.last, key) ? memory.last[key] ?? "" : ""
}

export function projectMemory(memory: WorkspaceMemory, project: string): ProjectMemory | undefined {
  return Object.hasOwn(memory.projects, project) ? memory.projects[project] : undefined
}

// Re-inserting moves an entry to the end, so object order is least recent first.
function withEntry<T>(record: Record<string, T>, key: string, value: T, max: number): Record<string, T> {
  const { [key]: _previous, ...rest } = record
  return { ...Object.fromEntries(Object.entries(rest).slice(-(max - 1))), [key]: value }
}

export function rememberProject(memory: WorkspaceMemory, key: string, project: string, tabs: readonly WorkspaceTab[], active: WorkspaceTab | null): WorkspaceMemory {
  return {
    last: withEntry(memory.last, key, project, maxSessions),
    projects: withEntry(memory.projects, project, {
      ...projectMemory(memory, project),
      tabs: tabs.map(storedTab),
      active: active && includesTab(tabs, active) ? storedTab(active) : "",
    }, maxProjects),
  }
}

// Folder and tab updates preserve one another, including when saved by
// different components during the same render.
export function rememberExpanded(memory: WorkspaceMemory, project: string, expanded: readonly string[]): WorkspaceMemory {
  return {
    ...memory,
    projects: withEntry(memory.projects, project, {
      tabs: [],
      active: "",
      ...projectMemory(memory, project),
      expanded: [...new Set(expanded)],
    }, maxProjects),
  }
}

// rememberScan records that the project's broad folder may be scanned.
export function rememberScan(memory: WorkspaceMemory, project: string): WorkspaceMemory {
  return {
    ...memory,
    projects: withEntry(memory.projects, project, {
      tabs: [],
      active: "",
      ...projectMemory(memory, project),
      scan: true,
    }, maxProjects),
  }
}

// scanConfirmed reports whether this browser asked to scan the project's
// broad folder.
export function scanConfirmed(memory: WorkspaceMemory, project: string): boolean {
  return projectMemory(memory, project)?.scan === true
}

// forgetProject drops a project's workspace; a forgotten last project
// no longer reopens on landing.
export function forgetProject(memory: WorkspaceMemory, project: string): WorkspaceMemory {
  const { [project]: _forgotten, ...projects } = memory.projects
  const last = Object.fromEntries(Object.entries(memory.last).filter(([, id]) => id !== project))
  return { last, projects }
}

// rememberedProjects lists remembered project IDs, most recent first.
export function rememberedProjects(memory: WorkspaceMemory): string[] {
  return Object.keys(memory.projects).reverse()
}

export interface RestoredTabs {
  tabs: WorkspaceTab[]
  active: WorkspaceTab | null
}

// restoreTabs keeps remembered documents that still exist in the fresh tree.
// Diff and commit tabs restore regardless: a deleted file has a diff but no
// tree entry. Browser and screen tabs restore only where the window offers
// them (decision 0184).
// files is the project's tree, or null before it loads: documents are then
// kept unchecked until missingTabs drops the removed ones (decision 0192).
export function restoreTabs(memory: ProjectMemory | undefined, files: ReadonlySet<string> | null, features: TabFeatures): RestoredTabs {
  const tabs: WorkspaceTab[] = []
  for (const entry of memory?.tabs ?? []) {
    const tab = parseStoredTab(entry)
    // Snapshots read git, not the tree; they restore whatever the tree holds.
    if (tab && offeredTab(tab, features) && (tab.kind !== "document" || tab.at || files === null || files.has(tab.path)) && !includesTab(tabs, tab)) tabs.push(tab)
  }
  const remembered = parseStoredTab(memory?.active)
  const active = tabs.find((tab) => sameTab(tab, remembered)) ?? null
  return { tabs, active }
}

// missingTabs are the working-tree documents among tabs that the tree no
// longer holds, but active, which stays to say its file is gone.
export function missingTabs(tabs: readonly WorkspaceTab[], files: ReadonlySet<string>, active: WorkspaceTab | null): WorkspaceTab[] {
  return tabs.filter((tab) => tab.kind === "document" && !tab.at && !files.has(tab.path) && !sameTab(tab, active))
}

// startupTab is the tab a project opens on when its route names none: the
// remembered active tab, else Welcome when nothing was restored and Welcome
// shows on startup (decision 0052), else none.
export function startupTab(routed: WorkspaceTab | null, restored: RestoredTabs, welcome: boolean): WorkspaceTab | null {
  if (routed) return null
  if (restored.active) return restored.active
  return welcome && restored.tabs.length === 0 ? welcomeTab() : null
}

// Only restore directories still present in the fresh project tree. Keep an
// absent preference distinct from the explicit all-collapsed state.
export function restoreExpanded(memory: ProjectMemory | undefined, directories: ReadonlySet<string>): string[] | undefined {
  return memory?.expanded?.filter((path, index, all) => directories.has(path) && all.indexOf(path) === index)
}

export function readMemory(): WorkspaceMemory {
  try {
    const raw = window.localStorage.getItem(MEMORY_STORAGE_KEY)
    return raw ? parseMemory(JSON.parse(raw)) : emptyMemory
  } catch {
    return emptyMemory
  }
}

export function writeMemory(memory: WorkspaceMemory) {
  try {
    window.localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(memory))
  } catch {
    // Storage is a convenience; a blocked or full store keeps the session usable.
  }
}

// updateMemory applies a change to the latest stored memory, so concurrent
// browser tabs only overwrite the entries they changed.
export function updateMemory(change: (memory: WorkspaceMemory) => WorkspaceMemory) {
  writeMemory(change(readMemory()))
}
