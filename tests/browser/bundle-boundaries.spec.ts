import { writeFileSync } from "node:fs"
import { createServer, request as forwardRequest } from "node:http"
import path from "node:path"

import { expect, type Locator, type Page } from "@playwright/test"
import { test } from "./live-test.ts"

const reviewChunk = "ReviewDocument"
const projectChunk = "ProjectPickerBody"
const settingsChunk = "SettingsDialogBody"
const reportChunk = "ReportProblemDialogBody"
const chunkPath = new RegExp(`^/assets/(${[reviewChunk, projectChunk, settingsChunk, reportChunk].join("|")})-[\\w-]{8,}\\.js$`)

function chunkName(url: URL, origin: string): string | undefined {
  return url.origin === origin ? chunkPath.exec(url.pathname)?.[1] : undefined
}

function recordChunks(page: Page, origin: string) {
  const requested = new Set<string>()
  page.on("request", (request) => {
    const name = chunkName(new URL(request.url()), origin)
    if (name) requested.add(name)
  })
  return requested
}

async function holdChunk(page: Page, matches: (url: URL) => boolean) {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route(matches, async (route) => {
    await held
    await route.continue()
  }, { times: 1 })
  return release
}

async function finishChunk(page: Page, matches: (url: URL) => boolean, release: () => void) {
  const finished = page.waitForEvent("requestfinished", (request) => matches(new URL(request.url())))
  release()
  await finished
}

const settingsButton = (page: Page) => page.getByRole("button", { name: "Settings", exact: true })
const settingsSearch = (dialog: Locator) => dialog.getByRole("searchbox", { name: "Search settings" })
const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true })
const openSettings = (page: Page) => page.keyboard.press("ControlOrMeta+,")

async function openReport(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+P")
  const palette = page.getByRole("dialog", { name: "Command palette" })
  const input = palette.getByRole("combobox", { name: "Command" })
  await input.fill("report a problem")
  await expect(palette.getByRole("option", { name: /Report a Problem/ })).toBeVisible()
  await input.press("Enter")
}

const reviewTab = (page: Page) => page.getByRole("tab", { name: "Uncommitted", exact: true })
const reviewFile = (page: Page) => page.getByRole("main").getByRole("region", { name: "review.txt", exact: true })
const addedLine = "Bundle boundary anchor"

function writeReviewFile(root: string) {
  writeFileSync(path.join(root, "review.txt"), `First line\n${addedLine}\nThird line\n`)
}

function directReviewURL(origin: string, root: string) {
  return `${origin}/view?project=${encodeURIComponent(root)}&review=working#f=review.txt&R2`
}

// Exercise WebKit's real HTTP cache across reload. Intercepted requests can
// retain a failed resource even after Playwright removes its route handler.
const recoveryTest = test.extend<{ recovery: { origin: string; restore(): void }; unavailableChunk: string }>({
  unavailableChunk: ["", { option: true }],
  recovery: async ({ live, unavailableChunk }, use) => {
    let unavailable = true
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", live.origin)
      if (unavailable && chunkName(url, live.origin) === unavailableChunk) {
        response.writeHead(503, { "cache-control": "no-store" })
        response.end("Chunk unavailable")
        return
      }
      const upstream = forwardRequest(url, { method: request.method, headers: request.headers }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers)
        result.pipe(response)
      })
      upstream.on("error", (error) => response.destroy(error))
      response.on("close", () => upstream.destroy())
      request.pipe(upstream)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing recovery server address")
      await use({ origin: `http://127.0.0.1:${address.port}`, restore: () => { unavailable = false } })
    } finally {
      server.close()
      server.closeAllConnections()
    }
  },
})

async function expectReviewAnchor(page: Page, url: string) {
  await expect(page).toHaveURL(url)
  await expect(reviewTab(page)).toHaveAttribute("aria-selected", "true")
  await expect(reviewFile(page).getByText(addedLine, { exact: true })).toBeInViewport()
  await expect(page.getByRole("button", { name: "Copy review.txt:2", exact: true })).toBeVisible()
}

async function retryAndReload(page: Page, scope: Locator, restore: () => void) {
  const reload = scope.getByRole("button", { name: "Reload page", exact: true })
  await expect(reload).toBeHidden()
  const documentStart = await page.evaluate(() => performance.timeOrigin)
  await scope.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(reload).toBeVisible()
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStart)

  // Keep the server response failing through Retry, then restore the chunk.
  restore()
  await Promise.all([page.waitForEvent("domcontentloaded"), reload.click()])
}

test("cold Welcome defers chunks until the dialog shortcuts and command run", async ({ page, live }) => {
  const requested = recordChunks(page, live.origin)
  await page.goto(`${live.origin}/?project=${encodeURIComponent(live.root)}`)
  await expect(page.getByRole("tab", { name: "Welcome", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("main").getByRole("heading", { name: "Zero", level: 1 })).toBeVisible()
  expect([...requested]).toEqual([])

  const dialogs = [
    {
      chunk: projectChunk,
      name: "Switch project",
      open: (page: Page) => page.keyboard.press("ControlOrMeta+o"),
      ready: async (dialog: Locator) => {
        await expect(dialog.getByRole("option", { name: /^repository\b/ })).toBeVisible()
        await expect(dialog.getByRole("combobox", { name: "Switch project" })).toBeFocused()
      },
    },
    {
      chunk: settingsChunk,
      name: "Settings",
      open: openSettings,
      ready: async (dialog: Locator) => {
        await expect(dialog.getByRole("combobox", { name: "Appearance: Theme" })).toBeVisible()
        await expect(settingsSearch(dialog)).toBeFocused()
      },
    },
    {
      chunk: reportChunk,
      name: "Report a Problem",
      open: openReport,
      ready: async (dialog: Locator) => {
        await expect(dialog.getByLabel("Problem report", { exact: true })).toContainText("## zero problem report")
      },
    },
  ]
  const used: string[] = []
  const focus = settingsButton(page)
  for (const { chunk, name, open, ready } of dialogs) {
    const matches = (url: URL) => chunkName(url, live.origin) === chunk
    const release = await holdChunk(page, matches)
    const dialog = page.getByRole("dialog", { name, exact: true })
    try {
      await focus.focus()
      await open(page)
      used.push(chunk)
      await expect.poll(() => [...requested]).toEqual(used)
      await expect(dialog.getByRole("status")).toHaveText(/\S/)
      expect(await dialog.evaluate((element) => element.matches("dialog:modal"))).toBe(true)

      if (chunk === settingsChunk) {
        await page.keyboard.press("Escape")
        await expect(dialog).toBeHidden()
        await expect(focus).toBeFocused()
      }
      await finishChunk(page, matches, release)
      if (chunk === settingsChunk) {
        await expect(dialog).toBeHidden()
        await expect(focus).toBeFocused()
        await open(page)
      }

      await ready(dialog)
      await page.keyboard.press("Escape")
      await expect(dialog).toBeHidden()
      await expect(focus).toBeFocused()
      expect([...requested]).toEqual(used)
    } finally {
      release()
    }
  }
})

test("cold Source defers review and can switch tabs while the first review loads", async ({ page, live }) => {
  writeReviewFile(live.root)
  const requested = recordChunks(page, live.origin)
  const sourceURL = `${live.origin}/view?project=${encodeURIComponent(live.root)}&path=review.txt`
  await page.goto(sourceURL)
  const source = page.getByRole("textbox", { name: /source$/ })
  const mark = source.getByRole("button", { name: /^Added lines? / })
  await expect(source).toContainText(addedLine)
  await expect(mark).toBeVisible()
  expect([...requested]).toEqual([])

  const matches = (url: URL) => chunkName(url, live.origin) === reviewChunk
  const release = await holdChunk(page, matches)
  const sourceTab = page.getByRole("tab", { name: "review.txt", exact: true })
  try {
    await mark.click()
    await expect.poll(() => [...requested]).toEqual([reviewChunk])
    await expect(reviewTab(page)).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("main").getByRole("status")).toBeVisible()

    await sourceTab.click()
    await expect(sourceTab).toHaveAttribute("aria-selected", "true")
    await expect(source).toContainText(addedLine)
    await finishChunk(page, matches, release)
    await expect(page).toHaveURL(sourceURL)
    await expect(sourceTab).toHaveAttribute("aria-selected", "true")
    await expect(reviewFile(page)).toBeHidden()
  } finally {
    release()
  }

  await reviewTab(page).click()
  await expect(reviewFile(page).getByText(addedLine, { exact: true })).toBeVisible()
  expect([...requested]).toEqual([reviewChunk])
})

test("a cold direct review applies its line anchor when the chunk finishes loading", async ({ page, live }) => {
  writeReviewFile(live.root)
  const url = directReviewURL(live.origin, live.root)
  const matches = (url: URL) => chunkName(url, live.origin) === reviewChunk
  const release = await holdChunk(page, matches)
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await expect(reviewTab(page)).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("main").getByRole("status")).toBeVisible()
    await finishChunk(page, matches, release)
  } finally {
    release()
  }
  await expectReviewAnchor(page, url)
})

recoveryTest.describe("review recovery", () => {
  recoveryTest.use({ unavailableChunk: reviewChunk })
  recoveryTest("a direct review recovers its line anchor after the chunk fails and the page reloads", async ({ page, live, recovery }) => {
    writeReviewFile(live.root)
    const url = directReviewURL(recovery.origin, live.root)
    await page.goto(url)
    await expect(reviewTab(page)).toHaveAttribute("aria-selected", "true")

    await retryAndReload(page, page.getByRole("main"), recovery.restore)
    await expectReviewAnchor(page, url)
  })
})

recoveryTest.describe("Settings recovery", () => {
  recoveryTest.use({ unavailableChunk: settingsChunk })
  recoveryTest("Settings can be opened with its shortcut after a chunk failure and reload", async ({ page, live, recovery }) => {
    await page.goto(`${recovery.origin}/?project=${encodeURIComponent(live.root)}`)
    const focus = settingsButton(page)
    await focus.focus()
    await openSettings(page)
    const dialog = settingsDialog(page)
    await retryAndReload(page, dialog, recovery.restore)

    await focus.focus()
    await openSettings(page)
    await expect(dialog.getByRole("combobox", { name: "Appearance: Theme" })).toBeVisible()
    await expect(settingsSearch(dialog)).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(focus).toBeFocused()
  })
})
