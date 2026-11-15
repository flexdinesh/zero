import assert from "node:assert/strict"
import test from "node:test"

import type { Diagnostics } from "@zero/contracts"

import { buildReport, clientFacts, redact, systemInfo, type ReportInput } from "./report.ts"

const server: Diagnostics = {
  version: "1.4.0", commit: "0123456789abcdef", buildDate: "2026-11-01", os: "linux", arch: "amd64",
  installMethod: "script", mode: "daemon", protocol: 1, uptimeSeconds: 3725, roots: 2, exposure: "",
  home: "/home/u", logsKept: true, logFile: "~/.local/state/zero/logs/daemon.log",
  logLines: ["level=INFO msg=\"zero daemon listening\""], crashLines: [],
}

const input: ReportInput = {
  server,
  serverError: "",
  desktop: null,
  client: { app: "browser", connection: "local", userAgent: "Mozilla/5.0" },
  uiErrors: [{ at: "2026-11-15T10:00:00.000Z", message: "GET /api/page (500): Couldn't open /home/u/src/a.go." }],
}

test("redact replaces the home directory only where it starts a path", () => {
  assert.equal(redact("/home/u/src and /home/u", "/home/u/"), "~/src and ~")
  assert.equal(redact("/home/user/src", "/home/u"), "/home/user/src")
  assert.equal(redact("/home/u/x", ""), "/home/u/x")
})

test("clientFacts reads the desktop connection from its host and a browser's from loopback", () => {
  assert.equal(clientFacts("local", "local", true, "UA").connection, "local")
  assert.equal(clientFacts("r-0123456789ab", "r-0123456789ab", true, "UA").connection, "remote")
  assert.equal(clientFacts("s-0123456789ab", "s-0123456789ab", true, "UA").connection, "sandbox")
  assert.deepEqual(clientFacts("127.0.0.1:7070", "127.0.0.1", false, "UA"), { app: "browser", connection: "local", userAgent: "UA" })
  assert.equal(clientFacts("box.tailnet.ts.net", "box.tailnet.ts.net", false, "UA").connection, "remote")
})

test("systemInfo states the server, client, and desktop builds without log lines", () => {
  const text = systemInfo({ ...input, desktop: { version: "1.4.0", commit: "abc", logDir: "~/logs", logLines: ["secret line"], crashLines: [] } })
  assert.match(text, /zero 1\.4\.0 0123456789ab 2026-11-01, linux\/amd64/)
  assert.match(text, /daemon \(protocol 1\), up 1h 2m, 2 roots/)
  assert.match(text, /Install: script/)
  assert.match(text, /Desktop app: 1\.4\.0 abc/)
  assert.doesNotMatch(text, /listening|secret line/)
})

test("systemInfo says why the server is missing", () => {
  assert.match(systemInfo({ ...input, server: null, serverError: "the server didn't respond" }), /Server: unavailable \(the server didn't respond\)/)
})

test("buildReport carries every log section and redacts this window's errors", () => {
  const text = buildReport(input)
  assert.match(text, /### Server log\n\nNewest lines of ~\/\.local\/state\/zero\/logs\/daemon\.log\./)
  assert.match(text, /zero daemon listening/)
  assert.match(text, /Couldn't open ~\/src\/a\.go\./)
  assert.doesNotMatch(text, /\/home\/u/)
  assert.doesNotMatch(text, /crash output/)
})

test("buildReport says when a server keeps no log", () => {
  assert.match(buildReport({ ...input, server: { ...server, logsKept: false, logFile: "", logLines: [] } }), /This server keeps no log file\./)
})

test("log fences outlast backticks inside the lines", () => {
  const text = buildReport({ ...input, server: { ...server, logLines: ["a ``` b"] } })
  assert.match(text, /````text\na ``` b\n````/)
})
