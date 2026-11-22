import assert from "node:assert/strict"
import test from "node:test"

import type { ProjectsResponse } from "@zero/contracts"
import { enterTarget, holdsLast, projectListSections } from "./project-list.ts"

const response: ProjectsResponse = {
  sessionKey: "/work",
  presence: false,
  manageRoots: false,
  place: "local",
  host: "",
  roots: [{ path: "/work", name: "work", isRepo: false }],
  projects: [
    { id: "/work", name: "work", path: "/work", kind: "folder", group: "", root: "/work", branch: "", repository: "", identity: "", available: true },
    { id: "/work/app", name: "app", path: "/work/app", kind: "repo", group: "/work/app", root: "/work", branch: "main", repository: "app", identity: "", available: true },
    { id: "/work/app-fix", name: "app-fix", path: "/work/app-fix", kind: "worktree", group: "/work/app", root: "/work", branch: "fix", repository: "app", identity: "", available: true },
    { id: "/work/notes", name: "notes", path: "/work/notes", kind: "repo", group: "/work/notes", root: "/work", branch: "main", repository: "notes", identity: "", available: true },
  ],
  warnings: [],
}

test("sections group repositories, carry several worktrees for expansion, and drop Browse", () => {
  const sections = projectListSections(response, [], "/work/app-fix", "")
  const rows = sections.flatMap((section) => section.rows)
  assert.equal(rows.length, 3)
  assert.deepEqual(new Set(rows.map((entry) => entry.row.name)), new Set(["work", "app", "notes"]))
  const app = rows.find((entry) => entry.row.name === "app")
  assert.equal(app?.row.current, true)
  assert.equal(app?.worktrees.length, 2)
  assert.equal(app?.worktrees.find((member) => member.name === "main")?.current, false)
  assert.equal(app?.worktrees.find((member) => member.name === "fix")?.current, true)
  assert.deepEqual(rows.find((entry) => entry.row.name === "notes")?.worktrees, [])
})

test("a query flattens projects into ranked matches without expansion", () => {
  const sections = projectListSections(response, [], "/work", "fix")
  assert.deepEqual(sections.map((section) => section.rows.map((entry) => [entry.row.name, entry.worktrees.length])), [[["fix", 0]]])
  assert.deepEqual(projectListSections(response, [], "/work", "zzz"), [])
})

test("the last opened project marks its row or the repository that collapses it", () => {
  const rows = projectListSections(response, [], "", "").flatMap((section) => section.rows)
  const app = rows.find((entry) => entry.row.name === "app")
  const notes = rows.find((entry) => entry.row.name === "notes")
  assert.ok(app && notes)
  assert.equal(holdsLast(app, "/work/app-fix"), true)
  assert.equal(holdsLast(notes, "/work/notes"), true)
  assert.equal(holdsLast(notes, "/work/app-fix"), false)
  assert.equal(holdsLast(notes, ""), false)
})

test("Enter opens the last opened project, else the first row that opens", () => {
  const all = projectListSections(response, [], "", "")
  assert.equal(enterTarget(all, "/work/app-fix", ""), "/work/app-fix")
  assert.equal(enterTarget(all, "", ""), "/work")
  assert.equal(enterTarget(all, "/gone", ""), "/work")
  // A filter opens its first match, whatever was last opened.
  assert.equal(enterTarget(projectListSections(response, [], "", "notes"), "/work/app-fix", "notes"), "/work/notes")
  assert.equal(enterTarget([], "/work", ""), "")
})

test("an identity lists only its repository's checkouts and shows the identity", () => {
  const zero = "github.com/flexdinesh/zero"
  const withIdentity: ProjectsResponse = {
    ...response,
    projects: response.projects.map((project) => project.group === "/work/app" ? { ...project, identity: zero } : project),
  }
  // A remembered folder outside the identity does not show as opened.
  const rows = projectListSections(withIdentity, ["/work/notes/sub", "/work/app-fix"], "", "", zero).flatMap((section) => section.rows)
  assert.deepEqual(rows.map((entry) => [entry.row.name, entry.row.identity, entry.row.id]), [["app", zero, "/work/app-fix"]])
  assert.deepEqual(rows[0]?.worktrees.map((member) => [member.name, member.identity]), [["main", ""], ["fix", ""]])
  // Without one, every project lists and rows carry their identity.
  const all = projectListSections(withIdentity, [], "", "").flatMap((section) => section.rows)
  assert.deepEqual(all.map((entry) => [entry.row.name, entry.row.identity]), [["work", ""], ["app", zero], ["notes", ""]])
})

test("the filter matches a row's identity", () => {
  const withIdentity: ProjectsResponse = {
    ...response,
    projects: response.projects.map((project) => project.id === "/work/notes" ? { ...project, identity: "gitlab.com/me/journal" } : project),
  }
  const rows = projectListSections(withIdentity, [], "", "gitlab.com/me").flatMap((section) => section.rows)
  assert.deepEqual(rows.map((entry) => entry.row.id), ["/work/notes"])
})
