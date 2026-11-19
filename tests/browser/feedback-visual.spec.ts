import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { test } from "./live-test.ts"

import { gitFixtureRoot } from "./git-fixture.ts"

// Visual threads in Zero (decisions 0176, 0182): a pasted screenshot takes a
// region and a comment, or is cancelled; a visual thread opens its screen
// tab, which shows the stored screenshot and the agent's replies beside
// code threads in the same feedback. Each test serves its own copy of the
// git fixture, so its repository's feedback starts empty.
test.skip(() => !existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
test.use({ seed: gitFixtureRoot })

// The contract fixture's screenshot: 612 × 288.
const screenshot = readFileSync(path.join(import.meta.dirname, "../../testdata/api/default/feedback-attachment.png"))

async function paste(page: Page) {
  await page.locator(".feedback-view").evaluate((view, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], "screen.png", { type: "image/png" }))
    view.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, screenshot.toString("base64"))
}

interface Live {
  root: string
  origin: string
}

async function feedbackId(request: APIRequestContext, live: Live): Promise<string> {
  const response = await request.get(`${live.origin}/api/feedback?project=${encodeURIComponent(live.root)}`)
  expect(response.ok()).toBe(true)
  const { id }: { id: string } = await response.json()
  return id
}

// startVisual uploads the screenshot and opens a visual thread on it, as
// the composer does.
async function startVisual(request: APIRequestContext, live: Live, body: string, id?: string): Promise<number> {
  const upload = await request.post(`${live.origin}/api/feedback-attachments?project=${encodeURIComponent(live.root)}`, {
    data: screenshot, headers: { "Content-Type": "image/png", Origin: live.origin },
  })
  expect(upload.ok()).toBe(true)
  const { id: attachment }: { id: string } = await upload.json()
  const created = await request.post(`${live.origin}/api/feedback-threads`, {
    data: {
      project: live.root, ...(id ? { id } : {}), body,
      visual: {
        attachment, rect: { x: 96, y: 96, width: 420, height: 96 },
        page: { url: "https://staging.acme.test/settings", title: "Settings", viewport: { width: 612, height: 288, deviceScaleFactor: 1 }, scroll: { x: 0, y: 0 } },
      },
    },
    headers: { Origin: live.origin },
  })
  expect(created.ok()).toBe(true)
  const { number }: { number: number } = await created.json()
  return number
}

async function startCode(request: APIRequestContext, live: Live, body: string): Promise<void> {
  const created = await request.post(`${live.origin}/api/feedback-threads`, {
    data: { project: live.root, path: "src/app.ts", side: "new", lines: [1, 1], body },
    headers: { Origin: live.origin },
  })
  expect(created.ok()).toBe(true)
}

function screenTabButton(page: Page, id: string, number: number) {
  return page.locator(`[data-tab="screen:${id}:${number}"]`)
}

test("a pasted screenshot takes a region and a comment, or cancels, and Send opens its screen tab", async ({ page, request, live }) => {
  test.setTimeout(60_000)
  await startCode(request, live, "Name the answer after what it counts.")
  const id = await feedbackId(request, live)
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&fb=${id}`)
  const view = page.locator(".feedback-view")
  const rows = view.getByRole("listbox", { name: "Threads" }).getByRole("option")
  await expect(rows).toHaveCount(1)
  const dialog = page.getByRole("dialog", { name: "New screen comment" })

  // Escape closes an untouched composer.
  await paste(page)
  await expect(dialog).toBeVisible()
  const stage = dialog.getByRole("group", { name: /^Screenshot\. Drag to mark a region/ })
  await expect(stage).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()

  // A written comment asks before Cancel drops it; nothing is sent.
  await paste(page)
  await expect(stage).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(dialog.locator(".screen-readout")).toContainText("Region")
  await dialog.getByRole("textbox", { name: "Comment" }).fill("Too tight.")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await dialog.getByRole("group", { name: "Discard this comment?" }).getByRole("button", { name: "Discard" }).click()
  await expect(dialog).toBeHidden()
  await expect(rows).toHaveCount(1)

  // A dragged rectangle hands focus to the comment; Send opens the thread's
  // screen tab as the preview tab, with the screenshot marked.
  await paste(page)
  const box = await stage.boundingBox()
  if (!box) throw new Error("the stage has no box")
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 4 })
  await page.mouse.up()
  const field = dialog.getByRole("textbox", { name: "Comment" })
  await expect(field).toBeFocused()
  await field.fill("Save overlaps the card edge.")
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`[?&]fb=${id}&thread=2$`))
  const tab = screenTabButton(page, id, 2)
  await expect(tab).toHaveAttribute("aria-selected", "true")
  await expect(tab).toHaveAttribute("data-preview", "true")
  await expect(tab).toContainText("#2 · Screenshot")
  const main = page.getByRole("main")
  await expect(main.getByRole("region", { name: "Screenshot" }).locator("img.visual-image")).toHaveJSProperty("naturalWidth", 612)
  await expect(main.locator(".visual-mark")).toBeVisible()
  await expect(main.getByText("Save overlaps the card edge.")).toBeVisible()

  // Code threads list first, screenshots after them.
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAccessibleName(/^Thread 1, Open: Name the answer/)
  await expect(rows.nth(1)).toHaveAccessibleName(/^Thread 2, Open: Save overlaps the card edge\., #2 · open · Screenshot/)
})

test("a screen tab shows the agent's reply beside the stored screenshot, and keyboard rows open code and screens", async ({ page, request, live }) => {
  test.setTimeout(60_000)
  await startCode(request, live, "Name the answer after what it counts.")
  const id = await feedbackId(request, live)
  const shot = await startVisual(request, live, "Save overlaps the card edge.", id)
  const other = await startVisual(request, live, "The empty state has no action.", id)
  const answered = await request.post(`${live.origin}/api/feedback-messages`, {
    data: { project: live.root, id, thread: shot, body: "Moved Save inside the card padding.", status: "resolved", author: "agent" },
  })
  expect(answered.ok()).toBe(true)

  const project = encodeURIComponent(live.root)
  await page.goto(`${live.origin}/view?project=${project}&fb=${id}`)
  const view = page.locator(".feedback-view")
  await view.getByRole("button", { name: "All", exact: true }).click()
  const rows = view.getByRole("listbox", { name: "Threads" }).getByRole("option")
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(1)).toHaveAccessibleName(new RegExp(`^Thread ${shot}, Resolved, new reply: `))

  // Arrow keys walk from the code row into the screenshots; Enter opens one.
  await rows.nth(0).focus()
  await page.keyboard.press("ArrowDown")
  await expect(rows.nth(1)).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`[?&]fb=${id}&thread=${shot}$`))
  const main = page.getByRole("main")
  // A resolved thread shows its whole conversation: the agent's answer.
  await expect(main.getByText("Moved Save inside the card padding.")).toBeVisible()
  await expect(main.getByRole("button", { name: "Reopen" })).toBeVisible()
  await expect(main.locator(".screen-tab-url")).toHaveText("staging.acme.test/settings")
  await expect(main.getByRole("button", { name: /^Open page/ })).toBeVisible()
  await expect(rows.nth(1)).not.toHaveAccessibleName(/new reply/)

  // The next screenshot replaces the preview tab in place.
  await rows.nth(2).click()
  await expect(page).toHaveURL(new RegExp(`[?&]thread=${other}$`))
  await expect(screenTabButton(page, id, shot)).toHaveCount(0)
  await expect(screenTabButton(page, id, other)).toHaveAttribute("data-preview", "true")

  // Replying keeps the tab, and the next one opens beside it.
  const reply = main.getByRole("textbox", { name: `Reply to thread ${other}` })
  await reply.fill("Add a New project button.")
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(main.getByText("Add a New project button.")).toBeVisible()
  await expect(screenTabButton(page, id, other)).not.toHaveAttribute("data-preview", "true")
  await rows.nth(1).click()
  await expect(screenTabButton(page, id, other)).toBeVisible()
  await expect(screenTabButton(page, id, shot)).toHaveAttribute("aria-selected", "true")

  // A reload reopens the tab with the original screenshot, Actual size
  // shows it at the page's size.
  await page.reload()
  await expect(screenTabButton(page, id, shot)).toHaveAttribute("aria-selected", "true")
  const image = main.getByRole("region", { name: "Screenshot" }).locator("img.visual-image")
  await expect(image).toHaveJSProperty("naturalWidth", 612)
  await main.getByRole("button", { name: "Actual size" }).click()
  await expect.poll(() => image.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(612)

  // Enter on the code row opens its file, as before.
  await rows.nth(0).focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/[?&]path=src(?:%2F|\/)app\.ts.*#L1$/)

  // A deleted thread says so in its tab.
  await page.goto(`${live.origin}/view?project=${project}&fb=${id}&thread=${other}`)
  await expect(main.getByText("Add a New project button.")).toBeVisible()
  const removed = await request.delete(`${live.origin}/api/feedback-threads?project=${project}&id=${id}&thread=${other}`, {
    headers: { Origin: live.origin },
  })
  expect(removed.ok()).toBe(true)
  await page.reload()
  await expect(main.getByText(`Thread ${other} was deleted.`)).toBeVisible()
  await main.getByRole("button", { name: "Close tab" }).click()
  await expect(screenTabButton(page, id, other)).toHaveCount(0)
})
