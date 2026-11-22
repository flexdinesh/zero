import assert from "node:assert/strict"
import test from "node:test"

import type { ProjectsResponse } from "@zero/contracts"
import { landing, lastOpened } from "./projects-data.ts"
import { emptyMemory, forgetProject, rememberProject } from "../workspace/workspace-memory.ts"

const sessionKey = "/work\n/home"
const projects: ProjectsResponse = {
  sessionKey,
  presence: false,
  manageRoots: false,
  place: "local",
  host: "",
  roots: [{ path: "/work", name: "work", isRepo: false }, { path: "/home", name: "home", isRepo: false }],
  projects: [
    { id: "/work", name: "work", path: "/work", kind: "folder", group: "", root: "/work", branch: "", repository: "", available: true },
    { id: "/work/api", name: "api", path: "/work/api", kind: "repo", group: "", root: "/work", branch: "main", repository: "api", available: true },
    { id: "/home", name: "home", path: "/home", kind: "folder", group: "", root: "/home", branch: "", repository: "", available: true },
  ],
  warnings: [],
}

test("a URL without a project asks when there is a choice, even with one remembered", () => {
  assert.deepEqual(landing(projects), { kind: "choose" })
})

test("a URL without a project opens the only available project", () => {
  const rootOnly: ProjectsResponse = { ...projects, roots: projects.roots.slice(0, 1), projects: projects.projects.slice(0, 1) }
  assert.deepEqual(landing(rootOnly), { kind: "open", project: "/work" })
  const oneAvailable: ProjectsResponse = {
    ...projects,
    projects: projects.projects.map((project) => ({ ...project, available: project.id === "/work/api" })),
  }
  assert.deepEqual(landing(oneAvailable), { kind: "open", project: "/work/api" })
})

test("with no available project, the URL asks so the problems show", () => {
  assert.deepEqual(landing({ ...projects, projects: [] }), { kind: "choose" })
})

test("serving no folder keeps the workspace's no-folder state", () => {
  assert.deepEqual(landing({ ...projects, roots: [], projects: [] }), { kind: "none" })
})

test("last opened is the project remembered under the session key", () => {
  const memory = rememberProject(rememberProject(emptyMemory, sessionKey, "/work/api", [], null), "daemon", "/home", [], null)
  assert.equal(lastOpened({ ...projects, sessionKey: "daemon" }, memory), "/home")
  assert.equal(lastOpened(projects, memory), "/work/api")
  assert.equal(lastOpened(projects, emptyMemory), "")
})

test("last opened keeps a folder opened by hand within a served root", () => {
  assert.equal(lastOpened(projects, rememberProject(emptyMemory, sessionKey, "/work/notes/2026", [], null)), "/work/notes/2026")
  assert.equal(lastOpened(projects, rememberProject(emptyMemory, sessionKey, "/elsewhere", [], null)), "")
})

test("a forgotten project is not last opened", () => {
  const memory = forgetProject(rememberProject(emptyMemory, sessionKey, "/work/api", [], null), "/work/api")
  assert.equal(lastOpened(projects, memory), "")
})
