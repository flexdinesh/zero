import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { isFeedback } from "../../packages/contracts/src/index.ts"
import { test } from "./live-test.ts"

import { copiedText, grantClipboard, recordClipboard } from "./clipboard.ts"
import { gitFixtureRoot, upperBranch } from "./git-fixture.ts"

// Review feedback threads (decision 0120). Each test serves its own copy of
// the git fixture, so its repository's feedback starts empty.
test.skip(() => !existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
test.use({ seed: gitFixtureRoot })

function reviewFile(page: Page, file: string) {
  return page.getByRole("main").getByRole("region", { name: file, exact: true })
}

function gutter(page: Page, file: string, side: "deletions" | "additions", line: number) {
  return reviewFile(page, file).locator(`.diff-view [data-${side}] [data-column-number="${line}"]`)
}

function thread(page: Page, number: number) {
  return page.getByRole("region", { name: new RegExp(`^Thread ${number}: `) })
}

async function expectFeedbackBadge(page: Page, count: number) {
  const activity = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Feedback/ })
  await expect(activity).toHaveAccessibleName(count === 0 ? "Feedback" : `Feedback, ${count} open thread${count === 1 ? "" : "s"}`)
  const badge = activity.locator(".activity-badge")
  if (count === 0) await expect(badge).toHaveCount(0)
  else await expect(badge).toHaveText(String(count))
}

async function feedbackId(request: APIRequestContext, origin: string, root: string): Promise<string> {
  const response = await request.get(`${origin}/api/feedback?project=${encodeURIComponent(root)}`)
  expect(response.ok()).toBe(true)
  const { id }: { id: string } = await response.json()
  return id
}

async function comment(page: Page, file: string, line: number, body: string) {
  await gutter(page, file, "additions", line).click()
  await page.keyboard.press("c")
  const composer = page.getByRole("textbox", { name: `Comment on ${file}:${line}` })
  await expect(composer).toBeFocused()
  await composer.fill(body)
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(composer).toHaveCount(0)
}

test("lines in a review take a comment, replies, an agent's answer, and resolve", async ({ page, request, live }) => {
  // A long walk through one review: WebKit takes most of the default 30 s.
  test.setTimeout(60_000)
  const project = encodeURIComponent(live.root)
  await page.goto(`${live.origin}/view?project=${project}&review=working#f=src/app.ts`)
  await expect(gutter(page, "src/app.ts", "additions", 1)).toBeVisible({ timeout: 20_000 })
  await expectFeedbackBadge(page, 0)

  // C opens the composer at the selection; submitting clears the selection.
  await comment(page, "src/app.ts", 1, "Name the **answer** after what it counts.")
  await expectFeedbackBadge(page, 1)
  const first = thread(page, 1)
  await expect(first).toHaveAccessibleName("Thread 1: Open, src/app.ts:1")
  await expect(first.locator("strong")).toHaveText("answer")
  await expect(first.locator(".feedback-message-author")).toHaveText("you")
  await expect(page).toHaveURL(/#f=src\/app\.ts$/)

  // The gutter's Comment button opens the same composer.
  await gutter(page, "src/app.ts", "additions", 4).click()
  await page.getByRole("button", { name: "Comment on Lines" }).click()
  await page.getByRole("textbox", { name: "Comment on src/app.ts:4" }).fill("Two spaces, as before.")
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await expect(thread(page, 2)).toHaveAccessibleName("Thread 2: Open, src/app.ts:4")
  await expectFeedbackBadge(page, 2)

  // Cancel keeps the draft for the same anchor in this session.
  await gutter(page, "src/app.ts", "additions", 3).click()
  await page.keyboard.press("c")
  await page.getByRole("textbox", { name: "Comment on src/app.ts:3" }).fill("Draft")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("textbox", { name: "Comment on src/app.ts:3" })).toHaveCount(0)
  await page.getByRole("button", { name: "Comment on Lines" }).click()
  await expect(page.getByRole("textbox", { name: "Comment on src/app.ts:3" })).toHaveValue("Draft")
  await page.getByRole("button", { name: "Cancel" }).click()

  // A failed reply keeps its text for another Cmd/Ctrl+Enter.
  const reply = page.getByRole("textbox", { name: "Reply to thread 1" })
  await reply.fill("Maybe `count`?")
  await page.route("**/api/feedback-messages", (route) =>
    route.fulfill({ status: 503, json: { error: "store busy" } }), { times: 1 })
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(first.getByRole("alert")).toHaveText("Couldn't send the reply: store busy.")
  await expect(reply).toHaveValue("Maybe `count`?")
  await reply.press("ControlOrMeta+Enter")
  await expect(first.getByText("Maybe count?", { exact: true })).toBeVisible()
  await expect(first.getByRole("alert")).toBeHidden()
  await expect(reply).toHaveValue("")
  await expectFeedbackBadge(page, 2)

  // An agent's reply arrives over the live stream.
  const id = await feedbackId(request, live.origin, live.root)
  expect(id).toMatch(/^fb-[a-z2-7]{6}$/)
  const answered = await request.post(`${live.origin}/api/feedback-messages`, {
    data: { project: live.root, id, thread: 1, body: "Renamed it to `count`.", author: "agent", name: "codex" },
  })
  expect(answered.ok()).toBe(true)
  await expect(first.locator(".feedback-message-author").last()).toHaveText("agent · codex")
  await expectFeedbackBadge(page, 2)

  // Resolve collapses the thread to one line; Show resolved comments hides it.
  await first.getByRole("button", { name: "Resolve" }).click()
  await expect(first).toHaveAccessibleName("Thread 1: Resolved, src/app.ts:1")
  await expectFeedbackBadge(page, 1)
  await expect(first.getByRole("button", { name: /Name the answer after what it counts\./ })).toBeVisible()
  await page.getByRole("button", { name: "View options" }).click()
  await page.getByRole("menuitemcheckbox", { name: "Show resolved comments" }).click()
  await page.keyboard.press("Escape")
  await expect(first).toHaveCount(0)
  await expect(thread(page, 2)).toBeVisible()
  await page.getByRole("button", { name: /^View options/ }).click()
  await page.getByRole("menuitemcheckbox", { name: "Show resolved comments" }).click()
  await page.keyboard.press("Escape")

  // A collapsed thread expands on click and reopens.
  await first.getByRole("button", { name: /after what it counts/ }).click()
  await first.getByRole("button", { name: "Reopen" }).click()
  await expect(first).toHaveAccessibleName("Thread 1: Open, src/app.ts:1")
  await expect(first.locator(".feedback-message-status").last()).toHaveText("reopened this")
  await expectFeedbackBadge(page, 2)

  // Delete removes a thread.
  await thread(page, 2).getByRole("button", { name: "More Thread Actions" }).click()
  await page.getByRole("menuitem", { name: "Delete thread" }).click()
  await expect(thread(page, 2)).toHaveCount(0)
  await expectFeedbackBadge(page, 1)

  // Threads persist across a reload.
  await page.reload()
  await expect(thread(page, 1)).toBeVisible({ timeout: 20_000 })
  await expectFeedbackBadge(page, 1)

  // A branch review with uncommitted changes shows them, and its Files rail
  // counts each file's open threads.
  await page.goto(`${live.origin}/view?project=${project}&review=branch&uncommitted=1#f=src/app.ts`)
  await expect(thread(page, 1)).toBeVisible({ timeout: 20_000 })
  const railFile = page.getByRole("complementary", { name: "Review files" }).getByRole("treeitem", { name: "app.ts", exact: true })
  await expect(railFile.getByTitle("1 open thread")).toBeAttached()
})

test("a whole-file comment keeps its draft when a failed write is retried", async ({ page, live }) => {
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&review=working#f=README.md`)
  const band = reviewFile(page, "README.md")
  await band.getByRole("button", { name: "Comment on File" }).click()
  const composer = page.getByRole("textbox", { name: "Comment on README.md" })
  await expect(composer).toBeFocused()
  await composer.fill("Split the install section.")
  await page.route("**/api/feedback-threads", (route) =>
    route.fulfill({ status: 503, json: { error: "store busy" } }), { times: 1 })
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(band.getByRole("alert")).toHaveText("Couldn't add the comment: store busy.")
  await expect(composer).toHaveValue("Split the install section.")
  await band.getByRole("button", { name: "Comment", exact: true }).click()
  await expect(thread(page, 1)).toHaveAccessibleName("Thread 1: Open, README.md")
  await expect(thread(page, 1)).toContainText("Split the install section.")
})

test("a live reply in another file preserves editing and scroll in an expanded diff gap", async ({ page, request, live }) => {
  const compare = { kind: "working" }
  for (const anchor of [
    { path: "README.md", body: "Explain installation." },
    { path: "large.txt", lines: [310, 311], body: "Keep these examples together." },
  ]) {
    const result = await request.post(`${live.origin}/api/feedback-threads`, {
      data: { project: live.root, compare, ...anchor },
    })
    expect(result.ok()).toBe(true)
  }
  const id = await feedbackId(request, live.origin, live.root)
  // Visit README so its file-level thread stays rendered when large.txt takes focus.
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&review=working#f=README.md`)
  const readme = reviewFile(page, "README.md")
  await expect(gutter(page, "README.md", "additions", 4)).toBeVisible()
  await expect(readme.getByText("Explain installation.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: /^Feedback/ }).click()
  await page.getByRole("option", { name: /^Thread 2, Open: Keep these examples together/ }).click()

  const gap = gutter(page, "large.txt", "additions", 310)
  await expect(gap).toBeInViewport({ timeout: 20_000 })
  const reply = thread(page, 2).getByRole("textbox", { name: "Reply to thread 2" })
  await reply.fill("The second example still needs context.")
  await expect(reply).toBeFocused()
  await expect(page.locator(".status-lines")).toHaveText("Ln 310–311")
  await expect(page.locator(".status-live")).toHaveAttribute("data-mode", "watching")
  const pane = page.getByRole("main")
  const top = await pane.evaluate((element) => element.scrollTop)
  expect(top).toBeGreaterThan(0)

  const answered = await request.post(`${live.origin}/api/feedback-messages`, {
    data: { project: live.root, id, thread: 1, body: "Added the installation steps.", author: "agent" },
  })
  expect(answered.ok()).toBe(true)
  await expect(readme.getByText("Added the installation steps.", { exact: true })).toBeVisible()
  await expect(reply).toBeFocused()
  await expect(reply).toHaveValue("The second example still needs context.")
  await expect(page.locator(".status-lines")).toHaveText("Ln 310–311")
  await expect(gap).toBeInViewport()
  const selected = reviewFile(page, "large.txt").locator(".diff-view [data-line][data-selected-line]")
  await expect(selected.filter({ hasText: "Line 309:" }).first()).toBeInViewport()
  await expect(selected.filter({ hasText: "Line 310:" }).first()).toBeInViewport()
  expect(await pane.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0)
})

for (const origin of ["Source", "committed changes"]) {
  test(`a comment submitted in ${origin} can finish while editing a different compare`, async ({ page, live }) => {
    const fromSource = origin === "Source"
    const file = fromSource ? "src/app.ts" : "docs/history.md"
    const review = fromSource ? "working" : "branch"
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&review=${review}#f=${file}`)
    if (fromSource) {
      await reviewFile(page, file).getByRole("button", { name: "Open File" }).click()
      await page.getByRole("textbox", { name: "TypeScript source" }).locator('[data-line="1"] .source-document-line-number').click()
    } else {
      await gutter(page, file, "additions", 1).click()
    }
    await page.keyboard.press("c")
    const first = page.getByRole("textbox", { name: `Comment on ${file}:1`, exact: true })
    await first.fill("Clarify the first line.")

    const pending = Promise.withResolvers<void>()
    await page.route("**/api/feedback-threads", async (route) => {
      await pending.promise
      await route.continue()
    }, { times: 1 })
    try {
      const sent = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/feedback-threads" && request.method() === "POST")
      await first.press("ControlOrMeta+Enter")
      const submitted = await sent
      if (fromSource) {
        await page.getByRole("tab", { name: "Uncommitted", exact: true }).click()
      } else {
        await page.getByRole("button", { name: /^Include uncommitted changes/ }).click()
      }
      const tab = page.getByRole("tab", { name: fromSource ? "Uncommitted" : "vs main + uncommitted", exact: true })
      await expect(tab).toHaveAttribute("aria-selected", "true")
      await gutter(page, file, "additions", 3).click()
      await page.keyboard.press("c")
      const next = page.getByRole("textbox", { name: `Comment on ${file}:3`, exact: true })
      await next.fill("Keep this draft on line three.")
      await expect(page).toHaveURL((url) => url.hash === `#f=${file}&R3`)

      const saved = page.waitForResponse((response) => response.request() === submitted)
      pending.resolve()
      await (await saved).finished()
      await expect(reviewFile(page, file).getByText("Clarify the first line.", { exact: true })).toBeVisible()
      await expect(tab).toHaveAttribute("aria-selected", "true")
      await expect(page.locator(".status-lines")).toHaveText("Ln 3")
      await expect(next).toBeFocused()
      await expect(next).toHaveValue("Keep this draft on line three.")
    } finally {
      pending.resolve()
    }
  })
}

test("Source lines take a comment that the Feedback view opens there", async ({ page, request, live }) => {
  const project = encodeURIComponent(live.root)
  await page.goto(`${live.origin}/view?project=${project}&path=src/app.ts`)
  const source = page.getByRole("textbox", { name: "TypeScript source" })
  const number = (line: number) => source.locator(`[data-line="${line}"] .source-document-line-number`)
  await number(3).click()
  await number(5).click({ modifiers: ["Shift"] })
  await expect(page).toHaveURL(/#L3-L5$/)

  // C opens the composer after the selection; submitting clears it.
  await page.keyboard.press("c")
  const composer = page.getByRole("textbox", { name: "Comment on src/app.ts:3-5" })
  await expect(composer).toBeFocused()
  await composer.fill("Return the **answer** directly.")
  await page.keyboard.press("ControlOrMeta+Enter")
  const first = thread(page, 1)
  await expect(first).toHaveAccessibleName("Thread 1: Open, src/app.ts:3-5")
  await expect(source.locator('[data-line="5"] + .source-annotation')).toContainText("Return the answer directly.")
  await expect(page).not.toHaveURL(/#L/)

  // A Source thread has no compare; it resolves against the working tree.
  const read = await request.get(`${live.origin}/api/feedback?project=${project}`)
  const { id, threads }: { id: string; threads: Array<{ anchor: { compare?: unknown; side: string } }> } = await read.json()
  expect(threads[0]?.anchor.compare).toBeUndefined()
  expect(threads[0]?.anchor.side).toBe("new")

  // The gutter's Comment sits beside Copy.
  await number(1).click()
  await source.getByRole("button", { name: "Comment on Lines" }).click()
  await page.getByRole("textbox", { name: "Comment on src/app.ts:1" }).fill("Name it after what it counts.")
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await expect(thread(page, 2)).toHaveAccessibleName("Thread 2: Open, src/app.ts:1")

  // An agent's reply arrives over the live stream; resolving collapses it.
  const answered = await request.post(`${live.origin}/api/feedback-messages`, {
    data: { project: live.root, id, thread: 2, body: "Renamed it.", status: "resolved", author: "agent" },
  })
  expect(answered.ok()).toBe(true)
  await expect(thread(page, 2)).toHaveAccessibleName("Thread 2: Resolved, src/app.ts:1")
  await expect(thread(page, 2).getByRole("button", { name: /Name it after what it counts\./ })).toBeVisible()

  // A snapshot shows no threads and takes no comments.
  const head = execFileSync("git", ["-C", live.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  await page.goto(`${live.origin}/view?project=${project}&path=src/app.ts&at=${head}#L1`)
  await expect(page.getByRole("textbox", { name: "TypeScript source" }).locator('[data-line="1"]')).toHaveClass(/selected/)
  await expect(page.getByRole("region", { name: /^Thread / })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Comment on Lines" })).toHaveCount(0)

  // The Feedback view opens a Source thread at its lines, zone showing.
  await page.goto(`${live.origin}/?project=${project}`)
  await page.getByRole("button", { name: /^Feedback/ }).click()
  const rows = page.locator(".feedback-view").getByRole("listbox", { name: "Threads" }).getByRole("option")
  await expect(rows.first()).toHaveAccessibleName(/^Thread 1, Open: Return the answer directly\., src\/app\.ts:3-5/)
  await rows.first().click()
  await expect(page).toHaveURL(/[?&]path=src%2Fapp\.ts.*#L3-L5$/)
  await expect(thread(page, 1)).toBeVisible()
  await expect(page.getByRole("textbox", { name: "TypeScript source" }).locator('[data-line="3"]')).toHaveClass(/selected/)
})

test("a live Source feedback refresh preserves the open composer's draft and editing", async ({ page, request, live }) => {
  const file = "src/app.ts"
  const created = await request.post(`${live.origin}/api/feedback-threads`, {
    data: { project: live.root, path: file, lines: [1, 1], body: "Name it after what it counts." },
  })
  expect(created.ok()).toBe(true)
  const id = await feedbackId(request, live.origin, live.root)
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=${file}`)
  const source = page.getByRole("textbox", { name: "TypeScript source" })
  const first = thread(page, 1)
  await expect(first).toBeVisible()
  await expect(page.locator(".status-live")).toHaveAttribute("data-mode", "watching")
  await source.locator('[data-line="3"] .source-document-line-number').click()
  await page.keyboard.press("c")
  const composer = page.getByRole("textbox", { name: `Comment on ${file}:3` })
  await expect(composer).toBeFocused()
  // Leave the caret inside the draft to detect a composer remount.
  const draft = "Explain the interfae."
  await page.keyboard.type(draft)
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("ArrowLeft")

  const reply = "Renamed it to count."
  const answered = await request.post(`${live.origin}/api/feedback-messages`, {
    data: { project: live.root, id, thread: 1, body: reply, author: "agent" },
  })
  expect(answered.ok()).toBe(true)
  await expect(first.getByText(reply, { exact: true })).toBeVisible()
  await expect(composer).toHaveValue(draft)
  await expect(composer).toBeFocused()

  await page.keyboard.press("c")
  await expect(composer).toHaveValue("Explain the interface.")
  await page.keyboard.press("Escape")
  await expect(composer).toHaveCount(0)
  await expect(page).toHaveURL(/#L3$/)
})

test("the Feedback view lists, filters, opens, and copies threads", async ({ page, request, live }) => {
  // This multi-navigation flow can exceed 30 s on WebKit in the full suite.
  test.setTimeout(60_000)
  await grantClipboard(page)
  await recordClipboard(page)
  const project = encodeURIComponent(live.root)
  await page.goto(`${live.origin}/view?project=${project}&review=working#f=src/app.ts`)
  await expect(gutter(page, "src/app.ts", "additions", 1)).toBeVisible({ timeout: 20_000 })
  await comment(page, "src/app.ts", 1, "Name the answer after what it counts.")
  await comment(page, "src/app.ts", 4, "Two spaces, as before.")
  const id = await feedbackId(request, live.origin, live.root)

  // Start somewhere without the review, so the agent's reply goes unseen.
  await page.goto(`${live.origin}/?project=${project}`)
  const answered = await request.post(`${live.origin}/api/feedback-messages`, {
    data: { project: live.root, id, thread: 2, body: "Fixed.", status: "resolved", author: "agent" },
  })
  expect(answered.ok()).toBe(true)
  const activity = page.getByRole("button", { name: "Feedback, 1 open thread" })
  await expect(activity).toBeVisible()
  await activity.click()

  const view = page.locator(".feedback-view")
  await expect(view.getByRole("button", { name: /^Branch: / })).toBeVisible()
  await expect(view.getByText(id, { exact: true })).toBeVisible()
  const rows = view.getByRole("listbox", { name: "Threads" }).getByRole("option")
  // Open is the default filter; Resolved lists the agent's resolved thread.
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAccessibleName(/^Thread 1, Open: Name the answer after what it counts\., src\/app\.ts:1/)
  await view.getByRole("button", { name: "Resolved", exact: true }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAccessibleName(/^Thread 2, Resolved, new reply: Two spaces, as before\./)
  await expect(view.locator(".feedback-meta-counts")).toContainText("1 new reply")
  await expectFeedbackBadge(page, 1)
  await view.getByRole("button", { name: "Awaiting agent", exact: true }).click()
  await expect(rows).toHaveCount(1)
  await expectFeedbackBadge(page, 1)
  await view.getByRole("button", { name: "All", exact: true }).click()
  await expect(rows).toHaveCount(2)
  await expectFeedbackBadge(page, 1)

  // Copy Prompt sends an agent to the CLI; the copy succeeds.
  const copyPrompt = view.getByRole("button", { name: "Copy Prompt" })
  await copyPrompt.click()
  await expect(copyPrompt).toHaveAttribute("data-status", "copied")
  await expect.poll(() => copiedText(page)).toContain(`Read the threads waiting on you: zero feedback show ${id}`)
  expect(await copiedText(page)).toContain(`in ${live.root}.`)

  // Copy as Markdown copies the filtered threads.
  await view.getByRole("button", { name: "More Feedback Actions" }).click()
  await page.getByRole("menuitem", { name: "Copy as Markdown" }).click()
  await expect(view.getByRole("status").filter({ hasText: "Threads copied as Markdown" })).toBeAttached()
  await expect.poll(() => copiedText(page)).toMatch(new RegExp(`^# Feedback ${id}\\n`))
  expect(await copiedText(page)).toContain("## Thread 2 · resolved · src/app.ts:4")

  // A row opens its thread in the review it was written in.
  await rows.first().click()
  await expect(page).toHaveURL(/[?&]review=working.*#f=src\/app\.ts&R1$/)
  await expect(thread(page, 1)).toBeVisible()
  // Expanded, the agent's reply is seen.
  await thread(page, 2).getByRole("button", { name: /Two spaces/ }).click()
  await expect(view.locator(".feedback-meta-counts")).not.toContainText("new reply")
  await expectFeedbackBadge(page, 1)

  // The fb route reveals the view at that feedback.
  await page.goto(`${live.origin}/view?project=${project}&fb=${id}`)
  await expect(page.getByRole("button", { name: /^Feedback/ })).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(".feedback-view").getByText(id, { exact: true })).toBeVisible()

  // Delete feedback confirms inline, then empties the view.
  await page.locator(".feedback-view").getByRole("button", { name: "More Feedback Actions" }).click()
  await page.getByRole("menuitem", { name: "Delete feedback" }).click()
  await page.getByRole("group", { name: "Delete feedback" }).getByRole("button", { name: "Delete" }).click()
  await expect(page.locator(".feedback-view")).toContainText("Select lines in a diff or file and press C to comment.")
  await expectFeedbackBadge(page, 0)
})

test("the Feedback badge catches a reply between its initial read and live subscription", async ({ page, request, live }) => {
  for (const body of ["Name the answer.", "Keep two spaces."]) {
    const created = await request.post(`${live.origin}/api/feedback-threads`, {
      data: { project: live.root, path: "src/app.ts", body },
    })
    expect(created.ok()).toBe(true)
  }
  const id = await feedbackId(request, live.origin, live.root)
  let releaseSubscription = () => {}
  const subscription = new Promise<void>((resolve) => { releaseSubscription = resolve })
  let held = false
  await page.route("**/api/events?*", async (route) => {
    held = true
    await subscription
    await route.continue()
  })
  try {
    await page.goto(`${live.origin}/?project=${encodeURIComponent(live.root)}`)
    await expectFeedbackBadge(page, 2)
    await expect.poll(() => held).toBe(true)

    // The real server announces this reply before the page can subscribe.
    const answered = await request.post(`${live.origin}/api/feedback-messages`, {
      data: { project: live.root, id, thread: 2, body: "Fixed.", status: "resolved", author: "agent" },
    })
    expect(answered.ok()).toBe(true)
    await expectFeedbackBadge(page, 2)

    releaseSubscription()
    await expect(page.locator(".status-live")).toHaveAttribute("data-mode", "watching")
    await expectFeedbackBadge(page, 1)
  } finally {
    releaseSubscription()
    await page.unroute("**/api/events?*")
  }
})

test("the Feedback badge follows the selected branch and reloads", async ({ page, request, live }) => {
  const project = encodeURIComponent(live.root)
  const current = await request.post(`${live.origin}/api/feedback-threads`, {
    data: { project: live.root, path: "src/app.ts", body: "Current branch comment." },
  })
  expect(current.ok()).toBe(true)
  for (const body of ["First branch comment.", "Second branch comment."]) {
    const created = await request.post(`${live.origin}/api/feedback-threads`, {
      data: { project: live.root, compare: { kind: "branch", base: "main", head: upperBranch, uncommitted: false }, path: "docs/changelog.md", body },
    })
    expect(created.ok()).toBe(true)
  }
  const read = await request.get(`${live.origin}/api/feedback?project=${project}&compare=branch&base=main&head=${upperBranch}`)
  expect(read.ok()).toBe(true)
  const { id }: { id: string } = await read.json()

  await page.goto(`${live.origin}/?project=${project}`)
  await expectFeedbackBadge(page, 1)
  await page.getByRole("button", { name: /^Feedback/ }).click()
  const view = page.locator(".feedback-view")
  await view.getByRole("button", { name: "Branch: feature", exact: true }).click()
  await page.getByRole("menuitemradio", { name: `${upperBranch} 2 open`, exact: true }).click()
  await page.keyboard.press("Escape")
  await expectFeedbackBadge(page, 2)
  await page.getByRole("button", { name: /^Explorer/ }).click()
  await expectFeedbackBadge(page, 2)

  // A reload without an fb route returns to the checkout's branch.
  await page.reload()
  await expectFeedbackBadge(page, 1)
  // An explicit document prevents workspace restoration from replacing the fb route.
  await page.goto(`${live.origin}/view?project=${project}&path=src/app.ts&fb=${id}`)
  await expect(view.getByRole("button", { name: `Branch: ${upperBranch}`, exact: true })).toBeVisible()
  await expectFeedbackBadge(page, 2)
  await page.reload()
  await expectFeedbackBadge(page, 2)

  // Resolved and declined threads both stop counting, even with unread replies.
  for (const { thread: number, status } of [{ thread: 1, status: "resolved" }, { thread: 2, status: "wontfix" }]) {
    const closed = await request.post(`${live.origin}/api/feedback-messages`, {
      data: { project: live.root, id, thread: number, status, body: "Handled.", author: "agent" },
    })
    expect(closed.ok()).toBe(true)
  }
  await expect(view.locator(".feedback-meta-counts")).toContainText("2 new replies")
  await expectFeedbackBadge(page, 0)
  await view.getByRole("button", { name: `Branch: ${upperBranch}`, exact: true }).click()
  await page.getByRole("menuitemradio", { name: "feature 1 open", exact: true }).click()
  await page.keyboard.press("Escape")
  await expectFeedbackBadge(page, 1)
})

test("the Feedback badge caps at 99+ while its label gives the full count", async ({ page, request, live }) => {
  const project = encodeURIComponent(live.root)
  const created = await request.post(`${live.origin}/api/feedback-threads`, {
    data: { project: live.root, path: "src/app.ts", body: "Keep the count clear." },
  })
  expect(created.ok()).toBe(true)
  const read = await request.get(`${live.origin}/api/feedback?project=${project}`)
  expect(read.ok()).toBe(true)
  const feedback: unknown = await read.json()
  if (!isFeedback(feedback)) throw new Error("Invalid feedback response")
  const first = feedback.threads[0]
  if (!first) throw new Error("Missing feedback thread")
  const threads = Array.from({ length: 100 }, (_, index) => ({ ...first, number: index + 1 }))
  await page.route("**/api/feedback?**", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    await route.fulfill({ json: { ...feedback, threads } })
  })
  await page.goto(`${live.origin}/?project=${project}`)
  const activity = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Feedback/ })
  await expect(activity).toHaveAccessibleName("Feedback, 100 open threads")
  await expect(activity.locator(".activity-badge")).toHaveText("99+")
})

test("narrowing Feedback to a file keeps every open thread in the badge", async ({ page, request, live }) => {
  const project = encodeURIComponent(live.root)
  const created = await request.post(`${live.origin}/api/feedback-threads`, {
    data: { project: live.root, path: "src/app.ts", lines: [1, 1], body: "Keep the answer clear." },
  })
  expect(created.ok()).toBe(true)
  const other = await request.post(`${live.origin}/api/feedback-threads`, {
    data: { project: live.root, path: "README.md", body: "Explain installation." },
  })
  expect(other.ok()).toBe(true)
  // Removing the anchored text exposes the file's outdated-thread action.
  writeFileSync(path.join(live.root, "src/app.ts"), "export const count = 3\n")
  await page.goto(`${live.origin}/view?project=${project}&review=working#f=src/app.ts`)
  await reviewFile(page, "src/app.ts").getByRole("button", { name: "1 outdated", exact: true }).click()
  const view = page.locator(".feedback-view")
  await expect(view.locator(".feedback-narrowed")).toContainText("Only src/app.ts")
  const rows = view.getByRole("listbox", { name: "Threads" }).getByRole("option")
  await expect(rows).toHaveCount(1)
  await expectFeedbackBadge(page, 2)
  await rows.first().click()
  const draft = view.getByRole("textbox", { name: "Reply to thread 1" })
  await draft.fill("Draft for the outdated thread")
  await page.getByRole("button", { name: "Explorer", exact: true }).click()
  await expect(draft).toBeHidden()
  const whileHidden = await request.post(`${live.origin}/api/feedback-threads`, {
    data: { project: live.root, path: "README.md", body: "Check that the examples still run." },
  })
  expect(whileHidden.ok()).toBe(true)
  await expectFeedbackBadge(page, 3)
  await page.getByRole("button", { name: /^Feedback,/ }).click()
  await expect(draft).toBeVisible()
  await expect(draft).toHaveValue("Draft for the outdated thread")
  await view.getByRole("button", { name: "Show Every File" }).click()
  await expect(rows).toHaveCount(3)
})

// A branch review takes code and screen comments into one feedback (decision
// 0176): the review places only the code thread, the Feedback view lists
// both, and the screenshot loads again in a browser opened afresh.
test("a branch review holds code and screen comments, and the screenshot outlives the browser", async ({ page, browser, request, live }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const project = encodeURIComponent(live.root)
  await page.goto(`${live.origin}/view?project=${project}&review=branch#f=docs/history.md`)
  await expect(gutter(page, "docs/history.md", "additions", 1)).toBeVisible({ timeout: 20_000 })
  await comment(page, "docs/history.md", 1, "Say when this changed.")
  await expectFeedbackBadge(page, 1)

  // A screenshot dropped on the Feedback view opens the composer.
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Feedback/ }).click()
  const view = page.locator(".feedback-view")
  const dataTransfer = await page.evaluateHandle(async () => {
    const canvas = document.createElement("canvas")
    canvas.width = 320
    canvas.height = 200
    const context = canvas.getContext("2d")
    if (!context) throw new Error("no 2d context")
    context.fillStyle = "#3366cc"
    context.fillRect(40, 40, 120, 60)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!blob) throw new Error("no PNG")
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], "shot.png", { type: "image/png" }))
    return transfer
  })
  await view.dispatchEvent("drop", { dataTransfer })
  const stage = page.getByRole("group", { name: /^Screenshot\. Drag to mark a region/ })
  await expect(stage).toBeVisible()
  await stage.focus()
  await page.keyboard.press("ArrowRight")
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("The badge clips at this width.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(stage).toHaveCount(0)
  await expectFeedbackBadge(page, 2)

  // One feedback, numbered in turn: the code thread under its file, the
  // screen thread under Screenshots.
  const rows = view.getByRole("listbox", { name: "Threads" })
  await expect(rows.getByRole("group", { name: "docs/history.md" }).getByRole("option", { name: /^Thread 1, Open: / })).toBeVisible()
  await expect(rows.getByRole("group", { name: "Screenshots" }).getByRole("option", { name: /^Thread 2, Open: / })).toBeVisible()
  // The review places the code thread and leaves the screenshot out.
  const main = page.getByRole("main")
  await expect(main.getByRole("region", { name: /^Thread 1: / })).toBeVisible()
  await expect(main.getByRole("region", { name: /^Thread 2: / })).toHaveCount(0)

  const read = await request.get(`${live.origin}/api/feedback?project=${project}`)
  expect(read.ok()).toBe(true)
  const stored: unknown = await read.json()
  if (!isFeedback(stored)) throw new Error("GET /api/feedback is not a feedback")
  const shot = stored.threads.find((each) => each.number === 2)?.visual
  if (!shot) throw new Error("thread 2 has no screenshot")
  expect(stored.threads.find((each) => each.number === 1)?.anchor?.path).toBe("docs/history.md")
  expect([shot.attachment.width, shot.attachment.height, shot.available]).toEqual([320, 200, true])

  // Close the browser that took it; a fresh one loads it from the server.
  await page.context().close()
  const context = await browser.newContext()
  try {
    const fresh = await context.newPage()
    await fresh.goto(`${live.origin}/?project=${project}`)
    await fresh.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Feedback/ }).click()
    await fresh.getByRole("option", { name: /^Thread 2, Open: / }).click()
    const image = fresh.locator(".feedback-inline img.visual-image")
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0)).toBe(320)
    const served = await request.get(`${live.origin}/api/feedback-attachment?project=${project}&id=${stored.id}&attachment=${shot.attachment.id}`)
    expect(served.headers()["content-type"]).toBe("image/png")
    expect(createHash("sha256").update(await served.body()).digest("hex")).toBe(shot.attachment.sha256)
  } finally {
    await context.close()
  }
})
