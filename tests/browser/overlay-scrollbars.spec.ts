import { expect, type Locator, type Page } from "@playwright/test"

import { test } from "./live-test.ts"
import { rootParam } from "./fixture-root.ts"
import { apiOrigin } from "./ports.ts"

type Axis = "x" | "y"

test.use({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" })

function bar(page: Page, axis: Axis) {
  return page.locator(`.ui-scrollbar[data-axis='${axis}']`)
}

async function openApp(page: Page, url = `${apiOrigin}/?project=${rootParam}`) {
  await page.goto(url)
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
  await expect(page.locator(".ui-scrollbars")).toHaveCount(1)
}

// Target ownership is observable through lane placement and actual scrolling.
async function expectLaneEdge(page: Page, axis: Axis, target: Locator) {
  await expect(bar(page, axis)).toHaveAttribute("data-visible", "")
  await expect.poll(async () => {
    const [lane, area] = await Promise.all([bar(page, axis).boundingBox(), target.boundingBox()])
    if (!lane || !area) return Infinity
    return axis === "y"
      ? Math.max(Math.abs(lane.x + lane.width - area.x - area.width), Math.abs(lane.y - area.y))
      : Math.max(Math.abs(lane.y + lane.height - area.y - area.height), Math.abs(lane.x - area.x))
  }).toBeLessThan(1)
}

async function dragThumb(page: Page, axis: Axis) {
  const thumb = await bar(page, axis).locator(".ui-scrollbar-thumb").boundingBox()
  if (!thumb) throw new Error("Scrollbar thumb is not laid out")
  const x = thumb.x + thumb.width / 2
  const y = thumb.y + thumb.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  try {
    await page.mouse.move(x + (axis === "x" ? 40 : 0), y + (axis === "y" ? 40 : 0), { steps: 4 })
  } finally {
    await page.mouse.up()
  }
}

async function offsets(target: Locator) {
  return target.evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }))
}

const axes: Axis[] = ["y", "x"]
for (const innerAxis of axes) {
  test(`nearest ${innerAxis} scroller and outer opposite axis are selected independently`, async ({ page }) => {
    await openApp(page)
    await page.evaluate((axis) => {
      const outer = document.createElement("div")
      outer.id = "outer-scroll"
      outer.style.cssText = "position:fixed;left:260px;top:100px;width:480px;height:260px;overflow:auto;scrollbar-width:none"
      const surface = document.createElement("div")
      surface.style.cssText = "width:1100px;height:800px;padding:32px;box-sizing:border-box"
      const inner = document.createElement("div")
      inner.id = "inner-scroll"
      inner.style.cssText = `width:240px;height:180px;overflow-x:${axis === "x" ? "auto" : "hidden"};overflow-y:${axis === "y" ? "auto" : "hidden"};scrollbar-width:none`
      const content = document.createElement("div")
      content.style.cssText = axis === "y" ? "width:240px;height:900px" : "width:900px;height:180px"
      inner.append(content)
      surface.append(inner)
      outer.append(surface)
      document.body.append(outer)
    }, innerAxis)

    const outer = page.locator("#outer-scroll")
    const inner = page.locator("#inner-scroll")
    const outerAxis = innerAxis === "y" ? "x" : "y"
    await inner.hover({ position: { x: 60, y: 60 } })
    await expectLaneEdge(page, innerAxis, inner)
    await expectLaneEdge(page, outerAxis, outer)

    await dragThumb(page, innerAxis)
    await expect.poll(async () => (await offsets(inner))[innerAxis]).toBeGreaterThan(0)
    expect(await offsets(outer)).toEqual({ x: 0, y: 0 })
    const innerAfterDrag = await offsets(inner)
    expect(innerAfterDrag[outerAxis]).toBe(0)

    // Re-enter the inner area after leaving it for its lane.
    await inner.hover({ position: { x: 60, y: 60 } })
    await expectLaneEdge(page, outerAxis, outer)
    await dragThumb(page, outerAxis)
    await expect.poll(async () => (await offsets(outer))[outerAxis]).toBeGreaterThan(0)
    expect((await offsets(outer))[innerAxis]).toBe(0)
    expect(await offsets(inner)).toEqual(innerAfterDrag)
  })
}

// boundingBox includes the unclipped track. Read its visible portion too,
// then verify the clipped portion cannot intercept pointer input.
async function visibleLane(page: Page, axis: Axis) {
  return bar(page, axis).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const values = getComputedStyle(element).clipPath.match(/-?\d*\.?\d+px/g)?.map(Number.parseFloat)
    if (!values || values.length < 1 || values.length > 4) throw new Error("Expected an inset scrollbar clip")
    const [top, right = top, bottom = top, left = right] = values
    return { left: rect.left + left, top: rect.top + top, right: rect.right - right, bottom: rect.bottom - bottom }
  })
}

test("nested clipping keeps both lanes within every ancestor's visible bounds", async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const outer = document.createElement("div")
    outer.id = "outer-clip"
    outer.style.cssText = "position:fixed;left:260px;top:100px;width:400px;height:260px;overflow:hidden"
    const inner = document.createElement("div")
    inner.id = "inner-clip"
    inner.style.cssText = "position:absolute;left:40px;top:30px;width:500px;height:300px;overflow:hidden"
    const scroller = document.createElement("div")
    scroller.id = "clipped-scroll"
    scroller.style.cssText = "position:absolute;left:-60px;top:-40px;width:600px;height:400px;overflow:auto;scrollbar-width:none"
    const content = document.createElement("div")
    content.style.cssText = "width:1200px;height:900px"
    scroller.append(content)
    inner.append(scroller)
    outer.append(inner)
    document.body.append(outer)
  })
  await page.mouse.move(450, 245)
  const [outer, inner] = await Promise.all([
    page.locator("#outer-clip").boundingBox(), page.locator("#inner-clip").boundingBox(),
  ])
  if (!outer || !inner) throw new Error("Nested clips are not laid out")
  const region = {
    left: Math.max(outer.x, inner.x), top: Math.max(outer.y, inner.y),
    right: Math.min(outer.x + outer.width, inner.x + inner.width),
    bottom: Math.min(outer.y + outer.height, inner.y + inner.height),
  }

  for (const axis of axes) {
    await expect(bar(page, axis)).toHaveAttribute("data-visible", "")
    const lane = await bar(page, axis).boundingBox()
    if (!lane) throw new Error("Clipped lane is not laid out")
    const expected = axis === "y"
      ? { ...region, left: region.right - lane.width }
      : { ...region, top: region.bottom - lane.height }
    await expect.poll(() => visibleLane(page, axis)).toEqual(expected)

    const hits = await page.evaluate(({ axis, region }) => {
      const x = axis === "y" ? region.right - 2 : (region.left + region.right) / 2
      const y = axis === "x" ? region.bottom - 2 : (region.top + region.bottom) / 2
      const at = (x: number, y: number) => document.elementFromPoint(x, y)?.closest(".ui-scrollbar")?.getAttribute("data-axis") ?? null
      return {
        inside: at(x, y),
        before: axis === "y" ? at(x, region.top - 5) : at(region.left - 5, y),
        after: axis === "y" ? at(x, region.bottom + 5) : at(region.right + 5, y),
      }
    }, { axis, region })
    expect(hits.inside).toBe(axis)
    expect(hits.before).not.toBe(axis)
    expect(hits.after).not.toBe(axis)
  }
})

test("a composed pointer path discovers both axes inside a shadow root", async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const host = document.createElement("div")
    host.id = "shadow-host"
    host.style.cssText = "position:fixed;left:260px;top:100px;width:480px;height:260px"
    const root = host.attachShadow({ mode: "open" })
    const scroller = document.createElement("div")
    scroller.id = "shadow-scroll"
    scroller.style.cssText = "margin:32px;width:320px;height:180px;overflow:auto;scrollbar-width:none"
    const content = document.createElement("div")
    content.style.cssText = "width:900px;height:900px"
    scroller.append(content)
    root.append(scroller)
    document.body.append(host)
  })
  const scroller = page.locator("#shadow-scroll")
  await scroller.hover({ position: { x: 60, y: 60 } })
  await expectLaneEdge(page, "y", scroller)
  await expectLaneEdge(page, "x", scroller)

  await dragThumb(page, "y")
  await expect.poll(async () => (await offsets(scroller)).y).toBeGreaterThan(0)
  const vertical = (await offsets(scroller)).y
  await scroller.hover({ position: { x: 60, y: 60 } })
  await expectLaneEdge(page, "x", scroller)
  await dragThumb(page, "x")
  await expect.poll(async () => (await offsets(scroller)).x).toBeGreaterThan(0)
  expect((await offsets(scroller)).y).toBe(vertical)
  expect(await offsets(page.locator("#shadow-host"))).toEqual({ x: 0, y: 0 })
})

test("Settings owns the scrollbar while open and returns it to the document after closing", async ({ page, live }) => {
  await page.setViewportSize({ width: 1280, height: 480 })
  const query = new URLSearchParams({ project: live.root, path: "long.md" })
  await openApp(page, `${live.origin}/view?${query}`)
  const main = page.getByRole("main")
  await expect(main.getByText("Line 300 of the long document.")).toBeAttached()
  await main.hover({ position: { x: 100, y: 100 } })
  await expectLaneEdge(page, "y", main)
  await dragThumb(page, "y")
  await expect.poll(async () => (await offsets(main)).y).toBeGreaterThan(0)
  const pageBeforeSettings = await offsets(main)

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(dialog).toBeVisible()
  const list = dialog.locator(".settings-list")
  await expect.poll(() => list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
  await list.hover({ position: { x: 60, y: 60 } })
  await expectLaneEdge(page, "y", list)
  await expect(dialog.locator(":scope > .ui-scrollbars")).toHaveCount(1)
  await dragThumb(page, "y")
  await expect.poll(async () => (await offsets(list)).y).toBeGreaterThan(0)
  expect(await offsets(main)).toEqual(pageBeforeSettings)
  await dialog.getByRole("button", { name: "Close settings" }).click()
  await expect(dialog).toBeHidden()
  await main.hover({ position: { x: 100, y: 100 } })
  await expectLaneEdge(page, "y", main)
  await expect(page.locator("body > .ui-scrollbars")).toHaveCount(1)
  await dragThumb(page, "y")
  await expect.poll(async () => (await offsets(main)).y).toBeGreaterThan(pageBeforeSettings.y)
})
