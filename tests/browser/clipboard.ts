import type { Page } from "@playwright/test"

// Playwright's WebKit has no clipboard permissions to grant, so a test's setup
// would abort there before its body runs.
export async function grantClipboard(page: Page): Promise<void> {
  if (page.context().browser()?.browserType().name() === "webkit") return
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
}

// WebKit denies readText without clipboard-read permission, but a trusted paste
// still reads the native clipboard. Restore focus and the document selection.
export async function readClipboard(page: Page): Promise<string> {
  if (page.context().browser()?.browserType().name() !== "webkit") {
    return page.evaluate(() => navigator.clipboard.readText())
  }
  const probe = await page.evaluateHandle(() => {
    const focused = document.activeElement
    const selection = window.getSelection()
    const anchorNode = selection?.anchorNode
    const anchorOffset = selection?.anchorOffset ?? 0
    const focusNode = selection?.focusNode
    const focusOffset = selection?.focusOffset ?? 0
    const field = document.createElement("textarea")
    field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0"
    field.setAttribute("aria-hidden", "true")
    document.body.append(field)
    field.focus({ preventScroll: true })
    return { field, focused, anchorNode, anchorOffset, focusNode, focusOffset }
  })
  try {
    await page.keyboard.press("ControlOrMeta+v")
    return await probe.evaluate(({ field }) => field.value)
  } finally {
    try {
      await probe.evaluate(({ field, focused, anchorNode, anchorOffset, focusNode, focusOffset }) => {
        field.remove()
        if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
        const selection = window.getSelection()
        if (anchorNode && focusNode) selection?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
        else selection?.removeAllRanges()
      })
    } finally {
      await probe.dispose()
    }
  }
}

// recordClipboard keeps the text the page last copied, through the
// Clipboard API or the selection fallback, for copiedText to read in every
// engine: Playwright's WebKit grants no clipboard-read, so readText fails
// there. Call it before the page loads.
export async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = (text: string) => Reflect.set(window, "__zeroCopied", text)
    const clipboard = navigator.clipboard
    if (clipboard) {
      const write = clipboard.writeText.bind(clipboard)
      clipboard.writeText = (text: string) => {
        record(text)
        return write(text)
      }
    }
    document.addEventListener("copy", () => {
      const field = document.activeElement
      if (field instanceof HTMLTextAreaElement) record(field.value.slice(field.selectionStart, field.selectionEnd))
    }, true)
  })
}

// copiedText is the text the page last copied, as recordClipboard saw it.
export function copiedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const text: unknown = Reflect.get(window, "__zeroCopied")
    return typeof text === "string" ? text : ""
  })
}
