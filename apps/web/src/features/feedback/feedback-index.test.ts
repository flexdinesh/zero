import assert from "node:assert/strict"
import test from "node:test"

import type { Feedback, FeedbackCompare, FeedbackThread } from "@zero/contracts"
import { emptyFeedbackFile, indexFeedback, type FeedbackIndex } from "./feedback-index.ts"

const date = "2026-11-10T09:12:00Z"

function thread(number: number, path = "a.go"): FeedbackThread {
  return {
    number, status: "open", awaiting: "agent", createdAt: date, updatedAt: date,
    anchor: { path, side: "new", lines: [1, 1], text: ["package main"], before: [], after: [""], blob: "abc", language: "go" },
    location: { state: "anchored", path, side: "new", lines: [1, 1] },
    messages: [{ number: 1, author: "user", body: "Comment", bodyHTML: "<p>Comment</p>", createdAt: date }],
  }
}

function feedback(...threads: FeedbackThread[]): Feedback {
  return { id: "fb-3k2q8m", project: "/project", branch: "main", createdAt: date, updatedAt: date, threads }
}

function file(index: FeedbackIndex, path = "a.go") {
  return index.files.get(path) ?? emptyFeedbackFile
}

test("inline threads follow server order across sides, while rail and outdated counts include file-level threads", () => {
  const old = thread(4)
  old.location.side = "old"
  const closed = thread(3)
  closed.status = "wontfix"
  const wholeFile = thread(2)
  delete wholeFile.anchor.lines
  delete wholeFile.location.lines
  const outdated = thread(1)
  outdated.location = { path: "a.go", side: "old", state: "outdated" }
  const resolved = thread(5)
  resolved.status = "resolved"
  resolved.location = { path: "b.go", side: "new", state: "outdated" }
  const index = indexFeedback(feedback(old, resolved, closed, wholeFile, outdated))
  assert.deepEqual(file(index), { all: [old, closed, wholeFile], open: [old, wholeFile], outdatedAll: 1, outdatedOpen: 1 })
  assert.deepEqual(index.counts, new Map([["a.go", 3]]))
  assert.equal(file(index, "b.go").outdatedAll, 1)
  assert.equal(file(index, "b.go").outdatedOpen, 0)
  assert.equal(file(index, "b.go").all, file(index, "missing").open)
  assert.equal(file(index, "b.go").open, emptyFeedbackFile.all)
})

test("re-decoded siblings retain identity even when another thread changes or server order changes", () => {
  const initial = feedback(thread(1), thread(2), thread(3, "b.go"))
  const first = indexFeedback(initial)
  const decoded = structuredClone(initial)
  const equal = indexFeedback(decoded, first)
  assert.equal(equal, first)
  assert.equal(file(equal), file(first))
  assert.equal(file(equal).all, file(equal).open)
  assert.equal(equal.counts, first.counts)

  const [one, two, three] = decoded.threads
  const reordered = indexFeedback(feedback(two, three, one), equal)
  assert.notEqual(file(reordered).all, file(equal).all)
  assert.equal(file(reordered).all[0], initial.threads[1])
  assert.equal(file(reordered).all[1], initial.threads[0])
  assert.equal(file(reordered, "b.go"), file(first, "b.go"))
  assert.equal(reordered.counts, first.counts)

  const edited = structuredClone(two)
  edited.messages[0].bodyHTML = "<p>Rendered differently</p>"
  const changed = indexFeedback(feedback(edited, three, one), reordered)
  assert.equal(changed.feedback.threads[1], file(first, "b.go").all[0])
  assert.equal(file(changed).all[0], edited)
  assert.equal(file(changed).all[1], initial.threads[0])
  assert.equal(file(changed, "b.go"), file(first, "b.go"))
  assert.equal(changed.counts, first.counts)
})

test("a moved or renamed thread follows its resolved lines and path at the same timestamp", () => {
  const original = thread(1)
  const first = indexFeedback(feedback(original))
  const moved = structuredClone(original)
  moved.location = { ...moved.location, state: "moved", lines: [20, 20] }
  const second = indexFeedback(feedback(moved), first)
  assert.equal(file(second).open[0], moved)
  assert.equal(second.counts, first.counts)

  const renamed = structuredClone(moved)
  renamed.location.path = "renamed.go"
  const third = indexFeedback(feedback(renamed), second)
  assert.equal(third.files.has(original.anchor.path), false)
  assert.equal(file(third, "renamed.go").open[0], renamed)
  assert.deepEqual(third.counts, new Map([["renamed.go", 1]]))
  assert.deepEqual(first.counts, new Map([["a.go", 1]]))
})

test("resolving, editing and deleting a sibling preserve the unchanged open list", () => {
  const one = thread(1)
  const two = thread(2)
  const first = indexFeedback(feedback(one, two))
  const resolved = structuredClone(two)
  resolved.status = "resolved"
  const second = indexFeedback(feedback(one, resolved), first)
  assert.deepEqual(file(second).open, [one])
  assert.deepEqual(file(second).all, [one, resolved])
  assert.equal(second.counts.get("a.go"), 1)

  const reply = structuredClone(resolved)
  reply.messages.push({ ...reply.messages[0], author: "agent", number: 2 })
  const third = indexFeedback(feedback(structuredClone(one), reply), second)
  assert.equal(file(third).open, file(second).open)
  assert.equal(file(third).all[1], reply)
  assert.equal(third.counts, second.counts)

  const fourth = indexFeedback(feedback(one), third)
  assert.equal(file(fourth).all, file(third).open)
  assert.equal(file(fourth).open, file(fourth).all)
  const deleted = indexFeedback(feedback(), fourth)
  assert.equal(deleted.files.size, 0)
  assert.equal(deleted.counts.size, 0)
  const restored = structuredClone(one)
  assert.equal(file(indexFeedback(feedback(restored), deleted)).all[0], restored)
})

test("outdated transitions change counts independently of visible lists", () => {
  const one = thread(1)
  const two = thread(2)
  const first = indexFeedback(feedback(one, two))
  const outdated = structuredClone(two)
  outdated.location = { state: "outdated", path: two.location.path, side: two.location.side }
  const second = indexFeedback(feedback(one, outdated), first)
  assert.deepEqual(file(second), { all: [one], open: [one], outdatedAll: 1, outdatedOpen: 1 })
  assert.equal(second.counts, first.counts)
  const resolved = structuredClone(outdated)
  resolved.status = "resolved"
  const third = indexFeedback(feedback(one, resolved), second)
  assert.equal(file(third).all, file(second).all)
  assert.notEqual(file(third), file(second))
  assert.equal(file(third).outdatedAll, 1)
  assert.equal(file(third).outdatedOpen, 0)
  assert.equal(third.counts.get("a.go"), 1)
})

test("each contract field participates in thread identity", () => {
  const original = thread(1)
  const compare: FeedbackCompare = { kind: "branch", base: "main", head: "next", uncommitted: false }
  original.anchor.compare = compare
  const first = indexFeedback(feedback(original))
  const edits: Record<string, (t: FeedbackThread) => void> = {
    number: t => { t.number++ },
    status: t => { t.status = "resolved" },
    awaiting: t => { t.awaiting = "user" },
    createdAt: t => { t.createdAt = "2026-11-11T09:12:00Z" },
    updatedAt: t => { t.updatedAt = "2026-11-11T09:12:00Z" },
    "anchor.path": t => { t.anchor.path = "before.go" },
    "anchor.side": t => { t.anchor.side = "old" },
    "anchor.lines": t => { t.anchor.lines = [2, 2] },
    "anchor.text": t => { t.anchor.text = ["package test"] },
    "anchor.before": t => { delete t.anchor.before },
    "anchor.after": t => { t.anchor.after = [] },
    "anchor.blob": t => { t.anchor.blob = "def" },
    "anchor.language": t => { t.anchor.language = "text" },
    "anchor.compare": t => { delete t.anchor.compare },
    "compare.kind": t => { t.anchor.compare = { ...compare, kind: "working" } },
    "compare.base": t => { t.anchor.compare = { ...compare, base: "dev" } },
    "compare.head": t => { t.anchor.compare = { ...compare, head: "feature" } },
    "compare.uncommitted": t => { t.anchor.compare = { ...compare, uncommitted: true } },
    "compare.commit": t => { t.anchor.compare = { ...compare, commit: "abc" } },
    "compare.from": t => { t.anchor.compare = { ...compare, from: "abc" } },
    "compare.to": t => { t.anchor.compare = { ...compare, to: "def" } },
    "location.path": t => { t.location.path = "after.go" },
    "location.state": t => { t.location.state = "moved" },
    "location.side": t => { t.location.side = "old" },
    "location.lines": t => { t.location.lines = [2, 2] },
    "messages.length": t => { t.messages.push({ ...t.messages[0], number: 2 }) },
    "message.number": t => { t.messages[0].number++ },
    "message.author": t => { t.messages[0].author = "agent" },
    "message.name": t => { t.messages[0].name = "Codex" },
    "message.status": t => { t.messages[0].status = "open" },
    "message.body": t => { t.messages[0].body += "!" },
    "message.bodyHTML": t => { t.messages[0].bodyHTML = "<p>Changed</p>" },
    "message.createdAt": t => { t.messages[0].createdAt = "2026-11-11T09:12:00Z" },
  }
  for (const [field, edit] of Object.entries(edits)) {
    const changed = structuredClone(original)
    edit(changed)
    const next = indexFeedback(feedback(changed), first)
    assert.equal(file(next, changed.location.path).all[0], changed, field)
  }
})

test("equal threads in another feedback ID or project start a fresh index", () => {
  const original = feedback(thread(1))
  const first = indexFeedback(original)
  for (const scope of [{ id: "fb-123456" }, { project: "/another-worktree" }]) {
    const decoded = { ...structuredClone(original), ...scope }
    const next = indexFeedback(decoded, first)
    assert.equal(file(next).all[0], decoded.threads[0])
    assert.notEqual(file(next), file(first))
    assert.notEqual(next.counts, first.counts)
  }
})
