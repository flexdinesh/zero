import assert from "node:assert/strict"
import test from "node:test"

import { availableCommands, commands, matchCommands, type Command } from "./commands.ts"

const sample: readonly Command[] = [
  { id: "a", category: "Settings", title: "Theme", action: { kind: "open-setting", setting: "theme" } },
  { id: "b", category: "Settings", title: "Font Size", action: { kind: "open-setting", setting: "fontSize" } },
]

test("typing welcome finds the Welcome tab and its startup setting", () => {
  assert.deepEqual(matchCommands(commands, "welcome").map((match) => match.command.id), ["settings.showWelcome", "help.welcome"])
})

test("typing blame finds the line blame command and its setting", () => {
  assert.deepEqual(matchCommands(commands, "blame").map((match) => match.command.id), ["settings.inlineBlame", "sourceControl.showLineBlame"])
})

test("the palette offers notification settings only where they exist", () => {
  const ids = (list: readonly Command[]) => list.map((command) => command.id)
  assert.deepEqual(availableCommands(true, true, true, true), commands)
  assert.ok(ids(availableCommands(true, true, true, true)).includes("settings.notifyCommits"))
  assert.ok(!ids(availableCommands(false, false, false, false)).some((id) => id.startsWith("settings.notify")))
  assert.ok(ids(availableCommands(false, false, false, false)).includes("settings.theme"))
  assert.ok(ids(availableCommands(false, false, false, false)).includes("help.welcome"))
})

test("the palette offers the Browser's Open Location only where the desktop app hosts the Browser", () => {
  const ids = (list: readonly Command[]) => list.map((command) => command.id)
  assert.ok(ids(availableCommands(true, false, true, false)).includes("browser.openLocation"))
  assert.ok(!ids(availableCommands(true, false, false, false)).includes("browser.openLocation"))
  // New Tab needs an app that keeps a page per tab (decision 0195).
  assert.ok(ids(availableCommands(true, false, true, true)).includes("browser.newTab"))
  assert.ok(!ids(availableCommands(true, false, true, false)).includes("browser.newTab"))
  assert.ok(!ids(availableCommands(true, false, false, true)).includes("browser.newTab"))
})

test("the active tab’s wrap toggle comes before the default setting when searching", () => {
  const wrap = (canWrap: boolean) => matchCommands(availableCommands(false, canWrap, false, false), "wrap").map(({ command }) => command.id)
  assert.deepEqual(wrap(true), ["editor.toggleWordWrap", "settings.wordWrap"])
  assert.deepEqual(wrap(false), ["settings.wordWrap"])
})

test("an empty query lists every command in order", () => {
  assert.deepEqual(matchCommands(sample, " ").map((match) => match.command.id), ["a", "b"])
})

test("every term must match the category or title, ignoring case", () => {
  assert.deepEqual(matchCommands(sample, "size").map((match) => match.command.id), ["b"])
  assert.deepEqual(matchCommands(sample, "SETTINGS font").map((match) => match.command.id), ["b"])
  assert.deepEqual(matchCommands(sample, "settings").map((match) => match.command.id), ["a", "b"])
  assert.deepEqual(matchCommands(sample, "font color"), [])
})

test("matches report highlight ranges in title and category", () => {
  const [match] = matchCommands(sample, "set size font")
  assert.deepEqual(match?.category, [{ start: 0, end: 3 }])
  assert.deepEqual(match?.title, [{ start: 0, end: 4 }, { start: 5, end: 9 }])
})

test("title word-prefix matches rank first", () => {
  assert.deepEqual(matchCommands(sample, "t").map((match) => match.command.id), ["a", "b"])
  assert.deepEqual(matchCommands(sample, "s").map((match) => match.command.id), ["b", "a"])
})

test("typing theme finds the Color Theme pick and the Theme setting", () => {
  assert.deepEqual(matchCommands(commands, "theme").map((match) => match.command.id), ["preferences.colorTheme", "settings.theme"])
})

test("Show File History is a Source Control command", () => {
  const [match] = matchCommands(commands, "file history")
  assert.equal(match?.command.id, "sourceControl.showFileHistory")
  assert.deepEqual(match?.command.action, { kind: "show-file-history" })
})

test("Go Back, Go Forward, and Recent Locations are Navigation commands", () => {
  assert.deepEqual(matchCommands(commands, "go back").map((match) => match.command.action), [{ kind: "go-back" }])
  assert.deepEqual(matchCommands(commands, "go forward").map((match) => match.command.action), [{ kind: "go-forward" }])
  const [recent] = matchCommands(commands, "recent")
  assert.equal(recent?.command.category, "Navigation")
  assert.deepEqual(recent?.command.action, { kind: "recent-locations" })
  assert.equal(recent?.command.shortcut, undefined)
})

test("typing report finds Report a Problem in Help on every client", () => {
  assert.deepEqual(matchCommands(commands, "report problem").map((match) => match.command.id), ["help.reportProblem"])
  assert.ok(availableCommands(false, false, false, false).some((command) => command.id === "help.reportProblem"))
})
