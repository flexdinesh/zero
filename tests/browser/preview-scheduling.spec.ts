import { writeFileSync } from "node:fs"
import path from "node:path"

import { expect, type Locator, type Page } from "@playwright/test"

import { copiedText, grantClipboard, recordClipboard } from "./clipboard.ts"
import { test } from "./live-test.ts"

const fixture = "/test-fixtures/preview-scheduling.html"

// The real worker protocol, with replies held until the test releases them.
// No main-thread lexer is substituted: spans can appear only after a reply.
async function controlHighlightWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Request {
      requestId: number
      source: string
      worker: ControlledHighlightWorker
    }
    const requests: Request[] = []
    const sources: string[] = []
    Reflect.set(window, "__previewHighlightSources", sources)

    class ControlledHighlightWorker extends EventTarget {
      postMessage(message: unknown): void {
        if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "highlight") return
        if (!("requestId" in message) || typeof message.requestId !== "number") return
        if (!("source" in message) || typeof message.source !== "string") return
        requests.push({ requestId: message.requestId, source: message.source, worker: this })
        sources.push(message.source)
      }

      // Retain this event target so an already posted reply can still arrive
      // after cleanup. The consumer must reject stale results itself.
      terminate(): void {}
    }

    Object.defineProperty(window, "Worker", { configurable: true, value: ControlledHighlightWorker })
    window.addEventListener("preview-highlight-reply", (event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return
      const request = requests.find((entry) => entry.source === event.detail)
      if (!request) throw new Error(`No pending highlight for ${event.detail}`)
      const escaped = request.source.replace(/\n$/, "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      request.worker.dispatchEvent(new MessageEvent("message", {
        data: { type: "highlighted", requestId: request.requestId, lines: [`<span class="hl-keyword">${escaped}</span>`] },
      }))
    })
  })
}

function highlightSources(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sources: unknown = Reflect.get(window, "__previewHighlightSources")
    if (!Array.isArray(sources) || !sources.every((source: unknown) => typeof source === "string")) {
      throw new Error("Highlight worker recorder unavailable")
    }
    return sources.filter((source: unknown): source is string => typeof source === "string")
  })
}

async function replyToHighlight(page: Page, source: string): Promise<void> {
  await page.evaluate((value) => {
    window.dispatchEvent(new CustomEvent("preview-highlight-reply", { detail: value }))
  }, source)
}

// Flush actual layout/IntersectionObserver delivery, without waiting for a
// worker or using an arbitrary timeout to decide whether work was scheduled.
async function layoutSettled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function preferPreview(page: Page, project: string): Promise<void> {
  await page.addInitScript((root) => sessionStorage.setItem(`zero-preview:${root}`, "1"), project)
}

async function expectDiagramFits(svg: Locator, frame: Locator): Promise<void> {
  const content = await svg.boundingBox()
  const container = await frame.boundingBox()
  if (!content || !container) throw new Error("Diagram has no layout")
  expect(content.width).toBeGreaterThan(0)
  expect(content.height).toBeGreaterThan(0)
  expect(content.x).toBeGreaterThanOrEqual(container.x - 1)
  expect(content.x + content.width).toBeLessThanOrEqual(container.x + container.width + 1)
}

test("Markdown fences stay plain offscreen and highlight in a worker when scrolled near", async ({ page, live }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  const first = 'const visible = "ready";'
  const last = 'const distant = "scrolled into view";'
  const spacer = Array.from({ length: 60 }, (_, index) => `Paragraph ${index}. Keep the next fence outside the viewport.\n`).join("\n")
  writeFileSync(path.join(live.root, "scheduling.md"), `# Fence scheduling\n\n\`\`\`javascript\n${first}\n\`\`\`\n\n${spacer}\n\`\`\`javascript\n${last}\n\`\`\`\n`)
  await preferPreview(page, live.root)
  const workerURLs: string[] = []
  page.on("worker", (worker) => workerURLs.push(worker.url()))
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=scheduling.md`)
  const firstCode = page.locator("article .code-block").filter({ hasText: first }).locator("code")
  const lastBlock = page.locator("article .code-block").filter({ hasText: last })
  await expect(firstCode.locator(".hl-keyword")).toBeVisible()
  expect(workerURLs.some((url) => /highlight-worker/.test(url)), "even a small preview fence must use a worker").toBe(true)
  const position = await lastBlock.boundingBox()
  if (!position) throw new Error("Offscreen fence missing")
  expect(position.y).toBeGreaterThan(900)
  await expect(lastBlock.locator('code [class^="hl-"]')).toHaveCount(0)
  await expect(lastBlock.locator("code")).toHaveText(`${last}\n`)

  await lastBlock.scrollIntoViewIfNeeded()
  await expect(lastBlock.locator(".hl-keyword")).toBeVisible()
  await expect(lastBlock.locator("code")).toHaveText(`${last}\n`)
  expect(workerURLs.filter((url) => /highlight-worker/.test(url)), "fences share one highlight worker").toHaveLength(1)
})

test("plain fences copy without loading Highlights or starting a worker", async ({ page }) => {
  await grantClipboard(page)
  await recordClipboard(page)
  const highlightLoads: string[] = []
  const workerURLs: string[] = []
  page.on("request", (request) => {
    if (/@pierre_highlights|@pierre\/highlights|highlights.*\.wasm/.test(request.url())) highlightLoads.push(request.url())
  })
  page.on("worker", (worker) => workerURLs.push(worker.url()))
  await page.goto(`${fixture}?mode=plain`)
  await expect(page.getByRole("heading", { name: "Plain fences" })).toBeVisible()
  const blocks = page.locator("article .code-block")
  for (const [index, source] of ["unlabeled", "text", "plain", "plaintext", "txt"].entries()) {
    const block = blocks.nth(index)
    await block.getByRole("button", { name: /^Copy .*code$/ }).click()
    await expect(block.getByRole("status")).toHaveText("Copied")
    expect(await copiedText(page)).toBe(`${source} <source>\n`)
  }
  await layoutSettled(page)
  expect(highlightLoads).toEqual([])
  expect(workerURLs).toEqual([])
  await expect(blocks.locator('code [class^="hl-"]')).toHaveCount(0)
})

test("Worker-unavailable preview preserves plain code, copy, and document navigation", async ({ page, live }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await grantClipboard(page)
  await recordClipboard(page)
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", { configurable: true, get: () => { throw new Error("Worker unavailable") } })
  })
  await preferPreview(page, live.root)
  const source = 'const readable = "<plain & safe>";\n'
  writeFileSync(path.join(live.root, "no-worker.md"), `# Worker fallback\n\n\`\`\`javascript\n${source}\`\`\`\n\n[Continue to guide](docs/guide.md)\n`)
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=no-worker.md`)
  const block = page.locator("article .code-block")
  await expect(block.locator("code")).toHaveText(source)
  await block.getByRole("button", { name: /^Copy .*code$/ }).click()
  await expect(block.getByRole("status")).toHaveText("Copied")
  expect(await copiedText(page)).toBe(source)
  await expect(block.locator('code [class^="hl-"]')).toHaveCount(0)
  await page.getByRole("link", { name: "Continue to guide" }).click()
  await expect(page.getByRole("heading", { name: "Guide", exact: true })).toBeVisible()
  await expect(page.getByRole("tab", { name: "guide.md" })).toHaveAttribute("aria-selected", "true")
  expect(errors).toEqual([])
})

test("blocked fence work stays bounded, prioritizes visible code, and permits immediate copy", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await grantClipboard(page)
  await recordClipboard(page)
  await controlHighlightWorker(page)
  await page.goto(`${fixture}?mode=queue`)
  const first = "const first = 1;\n"
  const visible = "const visible = 3;\n"
  const near = "const near = 2;\n"
  await expect.poll(() => highlightSources(page)).toEqual([first])
  await layoutSettled(page)
  expect(await highlightSources(page), "all other fences wait while the worker is busy").toEqual([first])
  const visibleBlock = page.getByRole("region", { name: "Visible fence" })
  await visibleBlock.getByRole("button", { name: /^Copy .*code$/ }).click()
  await expect(visibleBlock.getByRole("status")).toHaveText("Copied")
  expect(await copiedText(page)).toBe(visible)
  await expect(visibleBlock.locator('code [class^="hl-"]')).toHaveCount(0)

  await replyToHighlight(page, first)
  await expect.poll(() => highlightSources(page)).toEqual([first, visible])
  await replyToHighlight(page, visible)
  await expect(visibleBlock.locator(".hl-keyword")).toHaveText(visible)
  await expect.poll(() => highlightSources(page)).toEqual([first, visible, near])
  await replyToHighlight(page, near)
  await expect(page.getByRole("region", { name: "Near fence" }).locator(".hl-keyword")).toHaveText(near)
  await layoutSettled(page)
  expect(await highlightSources(page), "the far fence never joins the queue").toEqual([first, visible, near])
})

for (const change of ["replacement", "unmount", "navigation"]) {
  test(`late fence replies cannot overwrite ${change}`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await controlHighlightWorker(page)
    await page.goto(fixture)
    const original = 'const original = "before";\n'
    await expect.poll(() => highlightSources(page)).toContain(original)
    let expected = 'const replacement = "after";\n'
    if (change === "navigation") {
      await page.getByRole("link", { name: "Next document" }).click()
      await expect(page.getByLabel("Navigation")).toHaveText("/view?path=next.md")
      await expect(page.getByRole("heading", { name: "Next preview" })).toBeVisible()
      expected = 'const next = "destination";\n'
    } else if (change === "unmount") {
      await page.getByRole("button", { name: "Toggle preview" }).click()
      await expect(page.locator("article")).toHaveCount(0)
      await replyToHighlight(page, original)
      await page.getByRole("button", { name: "Replace content" }).click()
      await page.getByRole("button", { name: "Toggle preview" }).click()
    } else {
      await page.getByRole("button", { name: "Replace content" }).click()
      await expect(page.getByRole("heading", { name: "Replacement preview" })).toBeVisible()
    }
    // Release the old request while its replacement can still be queued.
    await replyToHighlight(page, original)
    await layoutSettled(page)
    await expect(page.locator("article code")).toHaveText(expected)
    await expect(page.locator("article")).not.toContainText(original.trim())
    await expect.poll(() => highlightSources(page)).toContain(expected)
    await replyToHighlight(page, expected)
    await expect(page.locator("article code .hl-keyword")).toHaveText(expected)
    // A duplicate late message must not corrupt an already highlighted page.
    await replyToHighlight(page, original)
    await layoutSettled(page)
    await expect(page.locator("article code")).toHaveText(expected)
    expect(errors).toEqual([])
  })
}

test("Mermaid retains and fits its SVG throughout resize, then lays out at the final width after quiet", async ({ page }) => {
  await page.goto(`${fixture}?mode=mermaid`)
  const frame = page.locator("article .mermaid-frame")
  const svg = frame.locator(".mermaid-svg > svg.ondine")
  await expect(svg).toBeVisible({ timeout: 15_000 })
  const original = await svg.elementHandle()
  if (!original) throw new Error("Initial diagram missing")
  const originalMarkup = await svg.evaluate((element) => element.outerHTML)
  await page.clock.install({ time: new Date("2026-11-18T00:00:00Z") })
  await page.clock.pauseAt(new Date("2026-11-18T00:00:01Z"))
  const pane = page.getByRole("main", { name: "Preview fixture" })
  for (const width of [620, 520, 420, 320]) {
    await pane.evaluate((element, value) => { element.style.width = `${value}px` }, width)
    await expect.poll(() => frame.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(width)
    // Deliver resize/animation frames, stopping well before the quiet period.
    await page.clock.runFor(50)
    expect(await original.evaluate((element) => element.isConnected), "continuous resize must retain the displayed SVG node").toBe(true)
    await expectDiagramFits(svg, frame)
  }
  await page.clock.runFor(99)
  expect(await original.evaluate((element) => element.isConnected)).toBe(true)
  // The final positive width gets its own layout once resizing stays quiet.
  await page.clock.runFor(100)
  await expect.poll(() => svg.evaluate((element) => element.outerHTML)).not.toBe(originalMarkup)
  await expect(svg).toContainText(/Review the final\s*result/)
  await expectDiagramFits(svg, frame)
})

test("inline Mermaid resizing preserves expanded view state and Escape returns focus", async ({ page }) => {
  await page.goto(`${fixture}?mode=mermaid`)
  const frame = page.locator("article .mermaid-frame")
  const inlineSVG = frame.locator(".mermaid-svg > svg.ondine")
  await expect(inlineSVG).toBeVisible({ timeout: 15_000 })
  const expand = frame.getByRole("button", { name: "Expand diagram" })
  await expand.click()
  const dialog = page.getByRole("dialog", { name: "Mermaid diagram" })
  await expect(dialog).toBeVisible()
  const expandedSVG = await dialog.locator(".mermaid-viewer-content svg").elementHandle()
  if (!expandedSVG) throw new Error("Expanded diagram missing")
  await dialog.getByRole("button", { name: "Zoom in" }).click()
  const zoom = await dialog.getByRole("status").textContent()
  const viewer = dialog.locator(".mermaid-viewer")
  const box = await viewer.boundingBox()
  if (!box) throw new Error("Expanded viewer missing")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 3 })
  await page.mouse.up()
  const content = dialog.locator(".mermaid-viewer-content")
  const transform = await content.evaluate((element) => element.style.transform)
  const initialMarkup = await inlineSVG.evaluate((element) => element.outerHTML)
  await page.getByRole("main", { name: "Preview fixture" }).evaluate((element) => { element.style.width = "320px" })
  await expect.poll(() => inlineSVG.evaluate((element) => element.outerHTML)).not.toBe(initialMarkup)
  await expectDiagramFits(inlineSVG, frame)
  expect(await expandedSVG.evaluate((element) => element.isConnected)).toBe(true)
  await expect(dialog.getByRole("status")).toHaveText(zoom ?? "")
  expect(await content.evaluate((element) => element.style.transform)).toBe(transform)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(expand).toBeFocused()
  await expect(inlineSVG).toBeVisible()
})
