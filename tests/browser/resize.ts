import { expect, type Locator, type Page } from "@playwright/test"

export async function resizeBox(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("Resize target is not laid out")
  return box
}

export async function dragWithoutSelection(page: Page, separator: Locator, delta: { x: number; y: number }, y?: number) {
  const box = await resizeBox(separator)
  const start = { x: box.x + box.width / 2, y: y ?? box.y + box.height / 2 }
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  try {
    await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 8 })
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("")
  } finally {
    await page.mouse.up()
  }
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("")
}

// Real text drags catch a resize guard that remains active after pointerup.
// Use a word's Range geometry so font metrics and syntax spans do not matter.
export async function selectContent(page: Page, content: Locator) {
  await content.scrollIntoViewIfNeeded()
  const word = await content.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text)) continue
      const match = /[A-Za-z]{5,}/.exec(node.data)
      if (!match) continue
      const range = document.createRange()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      const box = range.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) return { text: match[0], x: box.x, y: box.y + box.height / 2, width: box.width }
    }
    throw new Error("No visible word to select")
  })
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.mouse.move(word.x + 0.5, word.y)
  await page.mouse.down()
  await page.mouse.move(word.x + word.width - 0.5, word.y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(word.text)
}

// Keep a real captured mouse pointer active; inject only browser lifecycle
// events and other pointers, which Playwright's mouse cannot produce.
export async function exerciseResizeLifecycle(page: Page, separator: Locator, region: Locator, axis: "x" | "y", content: Locator, direction = 1) {
  const size = async () => {
    const box = await resizeBox(region)
    return axis === "x" ? box.width : box.height
  }
  const delta = { x: axis === "x" ? direction * 12 : 0, y: axis === "y" ? direction * 12 : 0 }
  const begin = async () => {
    const box = await resizeBox(separator)
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await separator.evaluate((element) => {
      element.addEventListener("pointerdown", (event) => {
        if (event instanceof PointerEvent) element.setAttribute("data-test-pointer", String(event.pointerId))
      }, { once: true })
    })
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    const pointerId = Number(await separator.getAttribute("data-test-pointer"))
    return { ...point, pointerId }
  }

  const initial = await size()
  const box = await resizeBox(separator)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down({ button: "right" })
  await page.mouse.move(box.x + box.width / 2 + delta.x, box.y + box.height / 2 + delta.y)
  await page.mouse.up({ button: "right" })
  expect(await size()).toBeCloseTo(initial, 1)

  const secondary = { pointerId: 100, pointerType: "touch", isPrimary: false, button: 0, buttons: 1, clientX: box.x, clientY: box.y }
  await separator.dispatchEvent("pointerdown", secondary)
  await separator.dispatchEvent("pointermove", { ...secondary, clientX: box.x + 100, clientY: box.y + 100 })
  await separator.dispatchEvent("pointerup", secondary)
  expect(await size(), "secondary pointer cannot start a drag").toBeCloseTo(initial, 1)

  const active = await begin()
  const foreign = { pointerId: active.pointerId + 100, pointerType: "touch", button: 0, buttons: 1, clientX: active.x, clientY: active.y }
  for (const isPrimary of [false, true]) {
    await separator.dispatchEvent("pointerdown", { ...foreign, isPrimary })
    await separator.dispatchEvent("pointermove", { ...foreign, isPrimary, clientX: active.x + 100, clientY: active.y + 100 })
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) await separator.dispatchEvent(event, { ...foreign, isPrimary })
    expect(await size()).toBeCloseTo(initial, 1)
  }
  await page.mouse.move(active.x + delta.x, active.y + delta.y)
  await page.mouse.up()
  expect(Math.abs(await size() - initial)).toBeGreaterThan(2)

  for (const interruption of ["pointercancel", "lostpointercapture", "blur"]) {
    const start = await begin()
    const before = await size()
    await page.mouse.move(start.x + delta.x, start.y + delta.y)
    await expect.poll(size).not.toBeCloseTo(before, 1)
    const interruptedSize = await size()
    if (interruption === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    else if (interruption === "lostpointercapture") {
      await separator.evaluate((element, pointerId) => element.releasePointerCapture(pointerId), start.pointerId)
    } else await separator.dispatchEvent(interruption, { pointerId: start.pointerId, pointerType: "mouse", isPrimary: true })
    await page.mouse.move(start.x + delta.x * 2, start.y + delta.y * 2)
    await page.mouse.up()
    // Reenter without pressing: lost capture must not leave stale drag state.
    await separator.hover()
    const resting = await resizeBox(separator)
    await page.mouse.move(resting.x + resting.width / 2 + (axis === "x" ? 1 : 0),
      resting.y + resting.height / 2 + (axis === "y" ? 1 : 0))
    expect(await size(), `${interruption} must end the drag`).toBeCloseTo(interruptedSize, 1)
    await selectContent(page, content)
    await dragWithoutSelection(page, separator, delta)
    expect(Math.abs(await size() - interruptedSize), `drag after ${interruption}`).toBeGreaterThan(2)
  }
}
