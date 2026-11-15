import { expect, test, type Page } from "@playwright/test"

import { copiedText, grantClipboard, recordClipboard } from "./clipboard.ts"

// openReport runs Help: Report a Problem… from the command palette.
async function openReport(page: Page) {
  // The palette shortcut listens once the workspace has rendered.
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Shift+P")
  const palette = page.getByRole("dialog", { name: "Command palette" })
  await palette.getByRole("combobox", { name: "Command" }).fill("report a problem")
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Report a Problem" })
  await expect(dialog).toBeVisible()
  return dialog
}

test("Report a Problem shows the redacted report, copies it, and links a new issue", async ({ page }) => {
  await grantClipboard(page)
  await recordClipboard(page)
  // Record the issue link instead of leaving for GitHub.
  await page.addInitScript(() => {
    window.open = (url) => {
      Reflect.set(window, "__zeroOpened", String(url))
      return null
    }
  })
  await page.goto("/")

  const dialog = await openReport(page)
  const preview = dialog.getByLabel("Problem report", { exact: true })
  await expect(preview).toContainText("## zero problem report")
  await expect(preview).toContainText("Mode: browser")
  await expect(preview).toContainText("Client: browser, local connection")
  await expect(preview).toContainText("This server keeps no log file.")
  await expect(preview).toContainText("### Recent errors in this window")

  await dialog.getByRole("button", { name: "Copy report" }).click()
  await expect.poll(() => copiedText(page)).toContain("## zero problem report")

  await dialog.getByRole("button", { name: "Open GitHub issue" }).click()
  const opened = await page.evaluate(() => String(Reflect.get(window, "__zeroOpened")))
  const url = new URL(opened)
  expect(`${url.origin}${url.pathname}`).toBe("https://github.com/flexdinesh/zero/issues/new")
  expect(url.searchParams.get("body")).toContain("Mode: browser")
  expect(url.searchParams.get("body")).not.toContain("### Recent errors")

  await dialog.getByRole("button", { name: "Close problem report" }).click()
  await expect(dialog).toBeHidden()
})

test("the Welcome tab opens Report a Problem", async ({ page }) => {
  // A first landing opens Welcome.
  await page.goto("/")
  await page.getByRole("main").getByRole("button", { name: "Report a problem…" }).click()
  await expect(page.getByRole("dialog", { name: "Report a Problem" })).toBeVisible()
})
