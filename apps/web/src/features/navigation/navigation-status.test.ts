import assert from "node:assert/strict"
import test from "node:test"

import type { LanguageServerStatus, NavigationStatus } from "@zero/contracts"
import { navigationStatusQuery, pollsServer, sameNavigationStatus } from "./navigation-status.ts"

const gopls: LanguageServerStatus = {
  name: "gopls",
  language: "Go",
  state: "stopped",
  message: "",
  install: [],
  docs: "",
  memory: 0,
  idleMinutes: 10,
  capabilities: null,
}

function status(overrides: Partial<LanguageServerStatus>, enabled = true): NavigationStatus {
  return { supported: true, enabled, eligible: true, reason: "", server: { ...gopls, ...overrides } }
}

test("status polls only while a server starts or runs", () => {
  assert.equal(pollsServer(null), false)
  assert.equal(pollsServer(status({ state: "ready" })), true)
  assert.equal(pollsServer(status({ state: "starting" })), true)
  assert.equal(pollsServer(status({ state: "stopped" })), false)
  assert.equal(pollsServer(status({ state: "ready" }, false)), false)
})

test("status queries ask for a refresh only on Check again", () => {
  assert.equal(navigationStatusQuery("/p", "a.go", false), "project=%2Fp&path=a.go")
  assert.equal(navigationStatusQuery("/p", "a.go", true), "project=%2Fp&path=a.go&refresh=1")
})

test("navigation equality retains all status and server information", () => {
  const original = status({ state: "ready", capabilities: { definition: true, references: true },
    install: [{ label: "npm", command: "npm install", docs: "https://example.test", prerequisites: ["node", "npm"] }] })
  assert.equal(sameNavigationStatus(original, structuredClone(original)), true)
  assert.equal(sameNavigationStatus(null, null), true)
  assert.equal(sameNavigationStatus(original, null), false)
  assert.equal(sameNavigationStatus(null, original), false)
  for (const change of [
    { supported: false }, { enabled: false }, { eligible: false }, { reason: "Blocked" }, { server: null },
  ]) assert.equal(sameNavigationStatus(original, { ...original, ...change }), false)
  const server = original.server
  assert.ok(server)
  const changes: Partial<LanguageServerStatus>[] = [
    { name: "other" }, { language: "other" }, { state: "starting" }, { state: "failed" }, { state: "stopped" },
    { message: "Failed" }, { docs: "https://other.test" }, { memory: 100 }, { idleMinutes: 5 },
    { capabilities: null }, { capabilities: { definition: false, references: true } },
    { capabilities: { definition: true, references: false } }, { install: [] },
    { install: [{ label: "other", command: "npm install", docs: "https://example.test", prerequisites: ["node", "npm"] }] },
    { install: [{ label: "npm", command: "other", docs: "https://example.test", prerequisites: ["node", "npm"] }] },
    { install: [{ label: "npm", command: "npm install", docs: "other", prerequisites: ["node", "npm"] }] },
    { install: [{ label: "npm", command: "npm install", docs: "https://example.test", prerequisites: ["npm", "node"] }] },
    { install: [{ label: "npm", command: "npm install", docs: "https://example.test" }] },
  ]
  for (const change of changes) assert.equal(sameNavigationStatus(original, { ...original, server: { ...server, ...change } }), false)
})
