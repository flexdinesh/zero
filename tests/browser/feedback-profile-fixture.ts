import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { expect, type Page } from "@playwright/test"
import type { Feedback, FeedbackMessage, FeedbackThread } from "../../packages/contracts/src/index.ts"

export const paths = Array.from({ length: 64 }, (_, index) => `review-${String(index).padStart(2, "0")}.txt`)
export const target = "review-00.txt"
export const replyText = "Measured reply to the first file."
const createdAt = "2026-01-01T00:00:00Z"
const updatedAt = "2026-01-01T00:01:00Z"

// All diffs, file lists, stats and virtualized renderers come from the live
// binary. Only feedback transport is controlled, freshly decoded on each GET.
export function createChangedFiles(root: string) {
  function writeFiles(side: string) {
    for (const file of paths) {
      const lines = Array.from({ length: 8 }, (_, index) => `${file} line ${index + 1} ${side}\n`)
      writeFileSync(path.join(root, file), lines.join(""))
    }
  }
  writeFiles("old")
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env })
  git("add", "--", ...paths)
  git("-c", "user.name=zero", "-c", "user.email=zero@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Feedback fixture")
  writeFiles("new")
}

function message(number: number, body: string, time: string): FeedbackMessage {
  return { number, body, bodyHTML: `<p>${body}</p>`, author: "user", createdAt: time }
}

function threadsFor(file: string, index: number): FeedbackThread[] {
  return Array.from({ length: 4 }, (_, slot) => {
    const number = 4 * index + slot + 1
    const side = slot === 1 ? "old" : "new"
    const range = slot === 0 ? {} : { lines: [2 * slot, 2 * slot] }
    const resolved = slot === 1 && index % 2 === 0
    return {
      number, status: resolved ? "resolved" : "open", awaiting: resolved ? "none" : "agent",
      anchor: { path: file, side, ...range, compare: { kind: "working", uncommitted: false } },
      location: { path: file, side, state: slot === 3 ? "outdated" : "anchored", ...(slot === 3 ? {} : range) },
      messages: [message(1, `Comment ${number} on ${file}.`, createdAt)], createdAt, updatedAt: createdAt,
    }
  })
}

export async function serveFeedback(page: Page, project: string) {
  const feedback: Feedback = { id: "fb-abcdef", project, branch: "main", threads: paths.flatMap(threadsFor), createdAt, updatedAt: createdAt }
  let wrote = false
  await page.route("**/api/feedback?*", (route) => route.fulfill({ json: feedback }))
  await page.route("**/api/feedback-messages", async (route) => {
    const thread = feedback.threads[0]
    const payload: unknown = route.request().postDataJSON()
    expect(payload).toEqual({ project, id: feedback.id, thread: 1, body: replyText })
    if (!thread || wrote) throw new Error("Expected one reply to the first file")
    wrote = true
    thread.messages.push(message(2, replyText, updatedAt))
    thread.updatedAt = feedback.updatedAt = updatedAt
    await route.fulfill({ json: thread })
  })
}

export function region(page: Page, file: string) {
  return page.locator(`[data-review-path="${file}"]`)
}

export async function warmReview(page: Page) {
  await expect(page.locator(".review-file")).toHaveCount(paths.length, { timeout: 30_000 })
  await page.locator("main").evaluate((element) => element.dispatchEvent(new WheelEvent("wheel")))
  for (const file of paths) {
    const section = region(page, file)
    await section.evaluate((element) => element.scrollIntoView({ block: "start" }))
    await expect(section.locator(".diff-view")).toBeAttached({ timeout: 20_000 })
  }
  await region(page, target).evaluate((element) => element.scrollIntoView({ block: "start" }))
  await expect(page.locator(".review-file .diff-view")).toHaveCount(paths.length)
  const first = region(page, target)
  await expect(first.getByRole("button", { name: "1 outdated" })).toBeAttached()
  await expect(first.locator('[data-status="resolved"].feedback-thread')).toBeAttached()
  await first.locator('.diff-view [data-additions] [data-column-number="3"]').click()
  await expect(first.getByRole("button", { name: "Comment on Lines" })).toBeAttached()
}
