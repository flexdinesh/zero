import assert from "node:assert/strict"
import test from "node:test"

import type { ProjectsResponse } from "@zero/contracts"
import { checkoutsOf, landing, lastOpened, repoLanding } from "./projects-data.ts"
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
    { id: "/work", name: "work", path: "/work", kind: "folder", group: "", root: "/work", branch: "", repository: "", identity: "", available: true },
    { id: "/work/api", name: "api", path: "/work/api", kind: "repo", group: "", root: "/work", branch: "main", repository: "api", identity: "", available: true },
    { id: "/home", name: "home", path: "/home", kind: "folder", group: "", root: "/home", branch: "", repository: "", identity: "", available: true },
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

// Two checkouts of one repository and another repository, as two computers
// might lay them out (decision 0188).
const zero = "github.com/flexdinesh/zero"
const repos: ProjectsResponse = {
  ...projects,
  projects: [
    ...projects.projects,
    { id: "/work/zero", name: "zero", path: "/work/zero", kind: "repo", group: "/work/zero", root: "/work", branch: "main", repository: "zero", identity: zero, available: true },
    { id: "/work/zero-fix", name: "zero-fix", path: "/work/zero-fix", kind: "worktree", group: "/work/zero", root: "/work", branch: "fix", repository: "zero", identity: zero, available: true },
    { id: "/home/site", name: "site", path: "/home/site", kind: "repo", group: "", root: "/home", branch: "main", repository: "site", identity: "github.com/me/site", available: true },
    { id: "", name: "gone", path: "/elsewhere/site", kind: "worktree", group: "/home/site", root: "", branch: "old", repository: "site", identity: "github.com/me/site", available: false },
  ],
}

test("checkoutsOf lists the available checkouts of an identity, forgiving case", () => {
  assert.deepEqual(checkoutsOf(repos, zero), ["/work/zero", "/work/zero-fix"])
  assert.deepEqual(checkoutsOf(repos, " GitHub.com/me/Site "), ["/home/site"])
  assert.deepEqual(checkoutsOf(repos, "github.com/none/here"), [])
  assert.deepEqual(checkoutsOf(repos, ""), [])
})

test("repo= opens its one checkout, asks among several, and reports none", () => {
  assert.deepEqual(repoLanding(repos, "", "github.com/me/site"), { kind: "open", project: "/home/site" })
  assert.deepEqual(repoLanding(repos, "", zero), { kind: "choose" })
  assert.deepEqual(repoLanding(repos, "", "github.com/none/here"), { kind: "missing" })
})

test("a link's project opens when it holds the identity, none, or is unlisted within a root", () => {
  assert.deepEqual(repoLanding(repos, "/work/zero-fix", zero), { kind: "open", project: "/work/zero-fix" })
  assert.deepEqual(repoLanding(repos, "/work/api", zero), { kind: "open", project: "/work/api" })
  assert.deepEqual(repoLanding(repos, "/work/docs", zero), { kind: "open", project: "/work/docs" })
})

test("a link's project that is another repository here gives way to the identity", () => {
  assert.deepEqual(repoLanding(repos, "/home/site", zero), { kind: "choose" })
  assert.deepEqual(repoLanding(repos, "/work/zero", "github.com/me/site"), { kind: "open", project: "/home/site" })
  assert.deepEqual(repoLanding(repos, "/elsewhere/zero", "github.com/me/site"), { kind: "open", project: "/home/site" })
  assert.deepEqual(repoLanding(repos, "/home/site", "github.com/none/here"), { kind: "missing" })
})
