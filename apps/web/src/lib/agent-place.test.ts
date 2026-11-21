import assert from "node:assert/strict"
import test from "node:test"

import { agentWhere, localPlace, machineLabel, sandboxZero, takesHttp, whereToRun, zeroCommand, type AgentPlace } from "./agent-place.ts"

// A local server changes nothing; a remote one is named by its host; a
// sandbox runs zero from its install directory (decision 0187).
test("where an agent runs follows the server's place", () => {
  assert.deepEqual([machineLabel(localPlace), agentWhere(localPlace), whereToRun(localPlace), zeroCommand(localPlace), takesHttp(localPlace)], ["", "", "", "zero", true])

  const remote: AgentPlace = { place: "remote", host: "devbox" }
  assert.deepEqual([machineLabel(remote), agentWhere(remote), zeroCommand(remote), takesHttp(remote)], ["devbox", "on devbox", "zero", false])
  assert.equal(whereToRun(remote), "Run this on devbox, the machine that serves this project: the files and zero are there, not on the reviewer's computer.\n")
  const unnamed: AgentPlace = { place: "remote", host: "" }
  assert.deepEqual([machineLabel(unnamed), agentWhere(unnamed)], ["the remote machine", "on the remote machine"])

  const sandbox: AgentPlace = { place: "sandbox", host: "3f2a9c1d7e4b" }
  assert.deepEqual([machineLabel(sandbox), agentWhere(sandbox), zeroCommand(sandbox), takesHttp(sandbox)], ["sandbox 3f2a9c1d7e4b", "in the sandbox", sandboxZero, false])
  assert.equal(machineLabel({ place: "sandbox", host: "" }), "the sandbox")
  assert.ok(whereToRun(sandbox).includes("docker exec <container>"))
})
