import assert from "node:assert/strict"
import test from "node:test"

import { ISSUES_URL, issueUrl, MAX_ISSUE_URL } from "./issue-url.ts"

test("the issue link carries the system facts and asks for the report", () => {
  const url = new URL(issueUrl("- Server: zero 1.4.0"))
  assert.equal(`${url.origin}${url.pathname}`, ISSUES_URL)
  const body = url.searchParams.get("body") ?? ""
  assert.match(body, /## System\n\n- Server: zero 1\.4\.0/)
  assert.match(body, /Paste the report/)
})

test("the issue link drops facts until it fits", () => {
  const system = Array.from({ length: 400 }, (_, i) => `- line ${i} ${"x".repeat(20)}`).join("\n")
  const url = issueUrl(system)
  assert.ok(url.length <= MAX_ISSUE_URL)
  const body = new URL(url).searchParams.get("body") ?? ""
  assert.match(body, /- line 0 /)
  assert.doesNotMatch(body, /- line 399 /)
})
