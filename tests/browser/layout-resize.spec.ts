import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect, type Locator, type Page } from "@playwright/test"

import { gitFixtureRoot } from "./git-fixture.ts"
import { test } from "./live-test.ts"
import { gitApiOrigin } from "./ports.ts"
import { beginResize, resizeBox } from "./resize.ts"

test.skip(() => !existsSync(path.join(gitFixtureRoot, ".git")), "git is not installed")
test.use({ seed: gitFixtureRoot })

type Target = { kind: "panes"; label: string; title: string; above: "working" | "commits" } | { kind: "rail"; label: string }
type Drag = Awaited<ReturnType<typeof beginResize>>

const targets: Target[] = [
  { kind: "panes", label: "Resize Uncommitted and Commits", title: "Uncommitted", above: "working" },
  { kind: "panes", label: "Resize Commits and Branches", title: "Commits", above: "commits" },
  { kind: "rail", label: "Resize review files" },
]

function sourceControl(page: Page) {
  return page.getByRole("region", { name: "Source Control", exact: true })
}

function rail(page: Page) {
  return page.getByRole("complementary", { name: "Review files" })
}

function separator(page: Page, target: Target) {
  return page.getByRole("separator", { name: target.label, exact: true })
}

function region(page: Page, target: Target) {
  return target.kind === "rail" ? rail(page) : sourceControl(page).getByRole("region", { name: target.title, exact: true })
}

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function openLayout(page: Page, origin = gitApiOrigin, root = gitFixtureRoot) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${origin}/view?project=${encodeURIComponent(root)}&review=branch&uncommitted=1#f=src/app.ts`)
  // Keys reach the workspace once its page loads (decision 0192).
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Shift+g")
  await expect(sourceControl(page).getByRole("listbox", { name: "Uncommitted changes" })).toBeVisible()
  await expect(sourceControl(page).getByRole("listbox", { name: "Commits", exact: true }).getByRole("option").first()).toBeVisible()
  await expect(sourceControl(page).getByRole("listbox", { name: "Branches", exact: true }).getByRole("option").first()).toBeVisible()
  await expect(rail(page).getByRole("treeitem", { name: "app.ts", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "src/app.ts", exact: true }).locator(".diff-view [data-line-type]").first()).toBeVisible()
  await frames(page)
}

async function trackWrites(page: Page, key = "zero-source-control") {
  await page.evaluate((trackedKey) => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === trackedKey) {
        const root = document.documentElement
        root.dataset.layoutWrites = String(Number(root.dataset.layoutWrites ?? 0) + 1)
      }
      return original.call(this, key, value)
    }
    document.documentElement.dataset.layoutWrites = "0"
  }, key)
}

async function writes(page: Page) {
  return Number(await page.evaluate(() => document.documentElement.dataset.layoutWrites ?? "0"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected saved layout object")
  return value
}

async function savedLayout(page: Page) {
  const raw = await page.evaluate(() => localStorage.getItem("zero-source-control"))
  // Reading defaults does not itself persist a preference.
  if (raw === null) return record({ weights: { working: 0.35, commits: 0.45, branches: 0.2 }, railWidth: 16 })
  const value: unknown = JSON.parse(raw)
  return record(value)
}

async function preference(page: Page, target: Target) {
  const layout = await savedLayout(page)
  const value = target.kind === "rail" ? layout.railWidth : record(layout.weights)[target.above]
  if (typeof value !== "number") throw new Error("Expected numeric resize preference")
  return value
}

// Capture the conversion before a geometry interruption, independently of the
// implementation's drag session. Pane weights sum to one in this fixture.
async function preferencePerPixel(page: Page, target: Target) {
  if (target.kind === "panes") return 1 / (await resizeBox(sourceControl(page).locator(".scm-panes"))).height
  return 1 / await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
}

function point(target: Target, drag: Drag, growth: number) {
  return { clientX: drag.x - (target.kind === "rail" ? growth : 0), clientY: drag.y + (target.kind === "panes" ? growth : 0) }
}

async function move(targetSeparator: Locator, target: Target, drag: Drag, growth: number) {
  await targetSeparator.dispatchEvent("pointermove", {
    ...point(target, drag, growth), pointerId: drag.pointerId, pointerType: "mouse", isPrimary: true, buttons: 1,
  })
}

async function size(page: Page, target: Target) {
  const box = await resizeBox(region(page, target))
  return target.kind === "rail" ? box.width : box.height
}

for (const target of targets) {
  test(`${target.label}: preview has no storage writes; one changed commit survives reload`, async ({ page }) => {
    await openLayout(page)
    const sash = separator(page, target)
    const initial = await size(page, target)
    const initialPreference = await preference(page, target)
    const unit = await preferencePerPixel(page, target)
    await trackWrites(page)
    const drag = await beginResize(page, sash)
    const destination = point(target, drag, 64)
    await page.mouse.move(destination.clientX, destination.clientY, { steps: 12 })
    await expect.poll(() => size(page, target)).toBeGreaterThan(initial + 40)
    const preview = await size(page, target)
    expect(await writes(page)).toBe(0)
    await page.mouse.up()
    await expect.poll(() => writes(page)).toBe(1)
    const saved = await preference(page, target)
    expect(saved).toBeCloseTo(initialPreference + 64 * unit, 6)
    const aria = await sash.getAttribute("aria-valuenow")
    await page.reload()
    await expect(sash).toHaveAttribute("aria-valuenow", aria ?? "missing")
    await expect.poll(() => size(page, target)).toBeCloseTo(preview, 0)
    expect(await preference(page, target)).toBe(saved)
    await frames(page)
    await trackWrites(page)
    await beginResize(page, sash)
    await page.mouse.up()
    await frames(page)
    expect(await writes(page), "a click without a changed preference does not persist").toBe(0)
  })

  test(`${target.label}: release flushes the latest sample before RAF; active keys are ignored`, async ({ page }) => {
    await openLayout(page)
    const sash = separator(page, target)
    const before = await sash.getAttribute("aria-valuenow")
    const initial = await preference(page, target)
    const unit = await preferencePerPixel(page, target)
    await trackWrites(page)
    const drag = await beginResize(page, sash)
    const beforeRelease = await sash.evaluate((element, { drag, rail }) => {
      for (const growth of [16, 48, 81]) {
        element.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true, pointerId: drag.pointerId, pointerType: "mouse", isPrimary: true, buttons: 1,
          clientX: drag.x - (rail ? growth : 0), clientY: drag.y + (rail ? 0 : growth),
        }))
      }
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: rail ? "ArrowLeft" : "ArrowDown" }))
      const value = element.getAttribute("aria-valuenow")
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: drag.pointerId, isPrimary: true }))
      return value
    }, { drag, rail: target.kind === "rail" })
    expect(beforeRelease, "pending moves must wait for a frame").toBe(before)
    await page.mouse.up()
    await expect.poll(() => writes(page)).toBe(1)
    expect(await preference(page, target)).toBeCloseTo(initial + 81 * unit, 6)
    await expect(sash).toBeFocused()
    await sash.press(target.kind === "rail" ? "ArrowRight" : "ArrowUp")
    await expect.poll(() => writes(page)).toBe(2)
    expect(await preference(page, target)).toBeLessThan(initial + 81 * unit)
    await sash.dblclick()
    await expect.poll(() => writes(page)).toBe(3)
    expect(await preference(page, target)).toBeCloseTo(initial, 6)
  })

  test(`${target.label}: clamps preserve ${target.kind === "rail" ? "the original pointer origin" : "every incremental pointer delta"}`, async ({ page }) => {
    await openLayout(page)
    const sash = separator(page, target)
    const initial = await size(page, target)
    await trackWrites(page)
    const drag = await beginResize(page, sash)
    await move(sash, target, drag, 24)
    await expect.poll(() => size(page, target)).toBeGreaterThan(initial + 10)
    const restored = await size(page, target)
    if (target.kind === "rail") {
      for (const [growth, limit] of [[10000, 32], [-10000, 12]]) {
        await move(sash, target, drag, growth)
        await expect(sash).toHaveAttribute("aria-valuenow", String(limit))
        await move(sash, target, drag, 24)
        await expect.poll(() => size(page, target)).toBeCloseTo(restored, 0)
        expect(await writes(page)).toBe(0)
      }
    } else {
      for (const direction of [1, -1]) {
        await move(sash, target, drag, direction * 10000)
        await expect(sash).toHaveAttribute("aria-valuenow", direction === 1 ? "85" : "15")
        await move(sash, target, drag, direction * 10100)
        await expect(sash).toHaveAttribute("aria-valuenow", direction === 1 ? "85" : "15")
        await move(sash, target, drag, direction * 10092)
        await expect.poll(async () => Number(await sash.getAttribute("aria-valuenow"))).toBeGreaterThan(15)
        await expect.poll(async () => Number(await sash.getAttribute("aria-valuenow"))).toBeLessThan(85)
        // A single task must still consume intermediate clamp positions before
        // its one visual frame. Retaining only the last delta would stay clamped.
        await sash.evaluate((element, { drag, direction }) => {
          for (const growth of [10000, 10100, 10092]) element.dispatchEvent(new PointerEvent("pointermove", {
            bubbles: true, pointerId: drag.pointerId, isPrimary: true, buttons: 1,
            clientX: drag.x, clientY: drag.y + direction * growth,
          }))
        }, { drag, direction })
        await expect.poll(async () => Number(await sash.getAttribute("aria-valuenow"))).toBeGreaterThan(15)
        await expect.poll(async () => Number(await sash.getAttribute("aria-valuenow"))).toBeLessThan(85)
        expect(await writes(page)).toBe(0)
      }
    }
    await page.mouse.up()
    await expect.poll(() => writes(page)).toBe(1)
  })

  test(`${target.label}: geometry and accessible values coalesce together across frames`, async ({ page }) => {
    await openLayout(page)
    const sash = separator(page, target)
    const initial = await size(page, target)
    const initialValue = await sash.getAttribute("aria-valuenow")
    await trackWrites(page)
    const drag = await beginResize(page, sash)
    await page.clock.install({ time: new Date("2026-11-18T00:00:00Z") })
    await page.clock.pauseAt(new Date("2026-11-18T00:00:01Z"))
    for (const growth of [16, 32, 48]) await move(sash, target, drag, growth)
    expect(await size(page, target)).toBeCloseTo(initial, 1)
    await expect(sash).toHaveAttribute("aria-valuenow", initialValue ?? "missing")
    expect(await writes(page)).toBe(0)
    await page.clock.runFor(16)
    const first = await size(page, target)
    const firstValue = await sash.getAttribute("aria-valuenow")
    expect(first).toBeGreaterThan(initial + 20)
    expect(firstValue).not.toBe(initialValue)
    for (const growth of [56, 64, 80]) await move(sash, target, drag, growth)
    expect(await size(page, target)).toBeCloseTo(first, 1)
    await expect(sash).toHaveAttribute("aria-valuenow", firstValue ?? "missing")
    expect(await writes(page)).toBe(0)
    await page.clock.runFor(16)
    expect(await size(page, target)).toBeGreaterThan(first + 15)
    expect(await sash.getAttribute("aria-valuenow")).not.toBe(firstValue)
    expect(await writes(page)).toBe(0)
    await page.mouse.up()
    expect(await writes(page)).toBe(1)
  })

  test(`${target.label}: double click finishes the pending drag before resetting`, async ({ page }) => {
    await openLayout(page)
    const sash = separator(page, target)
    const initial = await preference(page, target)
    await trackWrites(page)
    const drag = await beginResize(page, sash)
    await sash.evaluate((element, { drag, rail }) => {
      element.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: drag.pointerId, isPrimary: true, buttons: 1,
        clientX: drag.x - (rail ? 48 : 0), clientY: drag.y + (rail ? 0 : 48),
      }))
      element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
      element.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: drag.pointerId, isPrimary: true, buttons: 1,
        clientX: drag.x - (rail ? 96 : 0), clientY: drag.y + (rail ? 0 : 96),
      }))
    }, { drag, rail: target.kind === "rail" })
    await page.mouse.up()
    await frames(page)
    expect(await writes(page)).toBe(2)
    expect(await preference(page, target)).toBeCloseTo(initial, 6)
  })

  test(`${target.label}: foreign ends cannot commit; interruption and duplicate ends commit once`, async ({ page }) => {
    await openLayout(page)
    const sash = separator(page, target)
    await trackWrites(page)
    for (const [index, interruption] of ["pointercancel", "lostpointercapture", "blur"].entries()) {
      const initial = await preference(page, target)
      const unit = await preferencePerPixel(page, target)
      const drag = await beginResize(page, sash)
      await move(sash, target, drag, 24)
      // The other pointer may neither alter preview nor finish this owner.
      for (const event of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
        await sash.dispatchEvent(event, { ...point(target, drag, 120), pointerId: drag.pointerId + 100, isPrimary: true, buttons: 1 })
      }
      await expect.poll(() => writes(page)).toBe(index)
      if (interruption === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")))
      else if (interruption === "lostpointercapture") await sash.evaluate((element, id) => element.releasePointerCapture(id), drag.pointerId)
      else await sash.dispatchEvent("pointercancel", { pointerId: drag.pointerId, isPrimary: true })
      for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
        await sash.dispatchEvent(event, { pointerId: drag.pointerId, isPrimary: true })
      }
      await move(sash, target, drag, 120)
      await page.mouse.up()
      await frames(page)
      expect(await writes(page)).toBe(index + 1)
      expect(await preference(page, target)).toBeCloseTo(initial + 24 * unit, 6)
    }
  })

  test(`${target.label}: completion merges current unrelated preferences`, async ({ page }) => {
    await openLayout(page)
    const sash = separator(page, target)
    const initial = await preference(page, target)
    const unit = await preferencePerPixel(page, target)
    await trackWrites(page)
    const drag = await beginResize(page, sash)
    await move(sash, target, drag, 32)
    await sourceControl(page).getByRole("button", { name: "View as Tree" }).press("Enter")
    await rail(page).getByRole("button", { name: "Hide viewed files" }).press("Enter")
    await expect.poll(() => writes(page)).toBe(2)
    expect(await preference(page, target), "unrelated updates must not persist the preview").toBe(initial)
    await move(sash, target, drag, 48)
    await page.mouse.up()
    await expect.poll(() => writes(page)).toBe(3)
    expect(await preference(page, target)).toBeCloseTo(initial + 48 * unit, 6)
    expect(await savedLayout(page)).toMatchObject({ changesView: "tree", railHideViewed: true })
    await page.reload()
    await expect(sourceControl(page).getByRole("button", { name: "View as List" })).toBeVisible()
    await expect(rail(page).getByRole("button", { name: "Hide viewed files" })).toHaveAttribute("aria-pressed", "true")
  })

  for (const interruption of ["viewport", "font", "geometry"]) {
    test(`${target.label}: ${interruption} change saves original geometry and permits a fresh drag`, async ({ page }) => {
      await openLayout(page)
      const sash = separator(page, target)
      const initial = await preference(page, target)
      const unit = await preferencePerPixel(page, target)
      await trackWrites(page)
      const drag = await beginResize(page, sash)
      await move(sash, target, drag, 48)
      if (interruption === "viewport") await page.setViewportSize({ width: 1280, height: 900 })
      else if (interruption === "font") await page.evaluate(() => document.documentElement.style.setProperty("--font-size-base", "15px"))
      else if (target.kind === "rail") await page.getByRole("separator", { name: "Resize file tree" }).press("ArrowRight")
      else {
        await sourceControl(page).locator(".scm-panes").evaluate((element) => {
          element.style.maxHeight = `${element.getBoundingClientRect().height - 80}px`
        })
      }
      await expect.poll(() => writes(page)).toBe(1)
      expect(await preference(page, target)).toBeCloseTo(initial + 48 * unit, 6)
      await move(sash, target, drag, 100)
      await page.mouse.up()
      await frames(page)
      expect(await writes(page)).toBe(1)
      const finished = await preference(page, target)
      const newUnit = await preferencePerPixel(page, target)
      const fresh = await beginResize(page, sash)
      await move(sash, target, fresh, -16)
      await page.mouse.up()
      await expect.poll(() => writes(page)).toBe(2)
      expect(await preference(page, target)).toBeCloseTo(finished - 16 * newUnit, 6)
    })
  }

  test(`${target.label}: mobile transition finishes before pointer release and retains the preference`, async ({ page }) => {
    await openLayout(page)
    const sash = separator(page, target)
    const initial = await preference(page, target)
    const unit = await preferencePerPixel(page, target)
    await trackWrites(page)
    const drag = await beginResize(page, sash)
    await move(sash, target, drag, 48)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => preference(page, target)).toBeCloseTo(initial + 48 * unit, 6)
    await expect(sash).toBeHidden()
    const saved = await writes(page)
    await page.mouse.up()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(sash).toBeVisible()
    await frames(page)
    expect(await writes(page)).toBe(saved)
    const fresh = await beginResize(page, sash)
    await move(sash, target, fresh, -16)
    await page.mouse.up()
    await expect.poll(() => writes(page)).toBe(saved + 1)
  })

  if (target.kind === "panes") {
    test(`${target.label}: pane visibility change finishes before adopting the new split`, async ({ page }) => {
      await openLayout(page)
      const sash = separator(page, target)
      const initial = await preference(page, target)
      const unit = await preferencePerPixel(page, target)
      const closedTitle = target.above === "working" ? "Branches" : "Uncommitted"
      await trackWrites(page)
      const drag = await beginResize(page, sash)
      await move(sash, target, drag, 48)
      await sourceControl(page).getByRole("region", { name: closedTitle, exact: true }).getByRole("button", { name: new RegExp(`^${closedTitle}`) }).press("Enter")
      await expect.poll(() => preference(page, target)).toBeCloseTo(initial + 48 * unit, 6)
      await move(sash, target, drag, 100)
      await page.mouse.up()
      await frames(page)
      const settledWrites = await writes(page)
      const finished = await preference(page, target)
      const fresh = await beginResize(page, sash)
      await move(sash, target, fresh, -24)
      await page.mouse.up()
      await expect.poll(() => writes(page)).toBe(settledWrites + 1)
      expect(await preference(page, target)).toBeLessThan(finished)
      expect(record((await savedLayout(page)).collapsed)[target.above === "working" ? "branches" : "working"]).toBe(true)
    })
  }
}

test("hiding Source Control commits the latest pane preview", async ({ page }) => {
  await openLayout(page)
  const target = targets.find((entry) => entry.kind === "panes")
  if (!target) throw new Error("Missing pane resize target")
  const sash = separator(page, target)
  const initial = await preference(page, target)
  const unit = await preferencePerPixel(page, target)
  await trackWrites(page)
  const drag = await beginResize(page, sash)
  await move(sash, target, drag, 48)
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Source Control/ }).press("Enter")
  await expect(sourceControl(page)).toBeHidden()
  await expect.poll(() => writes(page)).toBe(1)
  expect(await preference(page, target)).toBeCloseTo(initial + 48 * unit, 6)
  await page.mouse.up()
  await frames(page)
  expect(await writes(page)).toBe(1)
  await page.keyboard.press("ControlOrMeta+Shift+g")
  await expect(sash).toBeVisible()
  const fresh = await beginResize(page, sash)
  await move(sash, target, fresh, -16)
  await page.mouse.up()
  await expect.poll(() => writes(page)).toBe(2)
})

test("Activity hiding the kept review commits its final rail width before pointer release", async ({ page }) => {
  await openLayout(page)
  // Keys reach the workspace once its page loads (decision 0192).
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+p")
  const field = page.getByRole("dialog", { name: "Go to file" }).getByRole("combobox", { name: "Go to file" })
  await field.fill("src/app.ts")
  await field.press("Enter")
  const source = page.getByRole("tab", { name: "app.ts", exact: true })
  const review = page.getByRole("tab", { name: "vs main + uncommitted", exact: true })
  await expect(source).toHaveAttribute("aria-selected", "true")
  await review.press("Enter")
  const target: Target = { kind: "rail", label: "Resize review files" }
  const sash = separator(page, target)
  const initial = await preference(page, target)
  const unit = await preferencePerPixel(page, target)
  await trackWrites(page)
  const drag = await beginResize(page, sash)
  await move(sash, target, drag, 48)
  await source.press("Enter")
  await expect(rail(page)).toBeHidden()
  await expect.poll(() => preference(page, target)).toBeCloseTo(initial + 48 * unit, 6)
  expect(await writes(page)).toBe(1)
  await page.mouse.up()
  await frames(page)
  expect(await writes(page)).toBe(1)
  await review.press("Enter")
  await expect(sash).toBeVisible()
  const fresh = await beginResize(page, sash)
  await move(sash, target, fresh, -16)
  await page.mouse.up()
  await expect.poll(() => writes(page)).toBe(2)
})

for (const interruption of ["viewport", "font", "hidden"]) test(`sidebar ${interruption} change finishes before pointer release`, async ({ page }) => {
  await openLayout(page)
  const sash = page.getByRole("separator", { name: "Resize file tree", exact: true })
  const initial = Number(await sash.getAttribute("aria-valuenow"))
  await trackWrites(page, "zero-sidebar-width")
  const drag = await beginResize(page, sash)
  await sash.dispatchEvent("pointermove", { pointerId: drag.pointerId, isPrimary: true, buttons: 1, clientX: drag.x + 48 })
  if (interruption === "viewport") await page.setViewportSize({ width: 390, height: 844 })
  else if (interruption === "font") await page.evaluate(() => document.documentElement.style.setProperty("--font-size-base", "15px"))
  else await page.keyboard.press("ControlOrMeta+b")
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zero-sidebar-width"))).toBe(String(initial + 48))
  expect(await writes(page)).toBe(1)
  await page.mouse.up()
  if (interruption === "viewport") await page.setViewportSize({ width: 1440, height: 1000 })
  else if (interruption === "hidden") await page.keyboard.press("ControlOrMeta+b")
  await expect(sash).toHaveAttribute("aria-valuenow", String(initial + 48))
  await frames(page)
  expect(await writes(page)).toBe(1)
  await sash.press("ArrowRight")
  await expect(sash).toHaveAttribute("aria-valuenow", String(initial + 64))
  expect(await writes(page)).toBe(2)
})

test("a sidebar click preserves a wider preference constrained by the current viewport", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("zero-sidebar-width", "600"))
  await openLayout(page)
  await page.setViewportSize({ width: 1000, height: 900 })
  const sash = page.getByRole("separator", { name: "Resize file tree", exact: true })
  await expect.poll(async () => Number(await sash.getAttribute("aria-valuenow"))).toBeLessThan(600)
  await trackWrites(page, "zero-sidebar-width")
  await beginResize(page, sash)
  await page.mouse.up()
  await frames(page)
  expect(await writes(page)).toBe(0)
  expect(await page.evaluate(() => localStorage.getItem("zero-sidebar-width"))).toBe("600")
  await page.setViewportSize({ width: 1920, height: 1000 })
  await expect(sash).toHaveAttribute("aria-valuenow", "600")
})

test("unmounting the active sash keeps its final split and the new collapsed preference", async ({ page }) => {
  await openLayout(page)
  const target: Target = { kind: "panes", label: "Resize Uncommitted and Commits", title: "Uncommitted", above: "working" }
  const sash = separator(page, target)
  const initial = await preference(page, target)
  const unit = await preferencePerPixel(page, target)
  await trackWrites(page)
  const drag = await beginResize(page, sash)
  await move(sash, target, drag, 48)
  await region(page, target).getByRole("button", { name: /^Uncommitted/ }).press("Enter")
  await expect(sash).toHaveCount(0)
  await expect.poll(() => preference(page, target)).toBeCloseTo(initial + 48 * unit, 6)
  expect(record((await savedLayout(page)).collapsed).working).toBe(true)
  const finishedWrites = await writes(page)
  await page.mouse.up()
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await frames(page)
  expect(await writes(page)).toBe(finishedWrites)
  await page.reload()
  await expect(region(page, target)).not.toHaveAttribute("data-open")
  await region(page, target).getByRole("button", { name: /^Uncommitted/ }).click()
  await expect(sash).toBeVisible()
})

test("hiding the review rail retains its final width and the hidden preference", async ({ page }) => {
  await openLayout(page)
  const target: Target = { kind: "rail", label: "Resize review files" }
  const sash = separator(page, target)
  const initial = await preference(page, target)
  const unit = await preferencePerPixel(page, target)
  await trackWrites(page)
  const drag = await beginResize(page, sash)
  await move(sash, target, drag, 48)
  await rail(page).getByRole("button", { name: "Hide Files" }).press("Enter")
  await expect(rail(page)).toBeHidden()
  await expect.poll(() => preference(page, target)).toBeCloseTo(initial + 48 * unit, 6)
  expect((await savedLayout(page)).railHidden).toBe(true)
  const finishedWrites = await writes(page)
  await page.mouse.up()
  await frames(page)
  expect(await writes(page)).toBe(finishedWrites)
  await page.getByRole("button", { name: "Files", exact: true }).click()
  await expect(sash).toBeVisible()
  const fresh = await beginResize(page, sash)
  await move(sash, target, fresh, -16)
  await page.mouse.up()
  await expect.poll(() => preference(page, target)).toBeCloseTo(initial + 32 * unit, 6)
})

test("StrictMode cleanup preserves an active split across keyed project changes and owner remounts", async ({ page }) => {
  await page.goto("/test-fixtures/resize-lifecycle.html")
  const sash = page.getByRole("separator", { name: "Resize working and commits", exact: true })
  const committed = page.getByLabel("Committed working weight")
  await expect(committed).toHaveText("0.35")
  await trackWrites(page)
  for (const action of ["Switch project", "Toggle panes"]) {
    const initial = Number(await committed.textContent())
    const height = (await resizeBox(page.locator(".scm-panes"))).height
    const drag = await beginResize(page, sash)
    await sash.dispatchEvent("pointermove", { pointerId: drag.pointerId, isPrimary: true, buttons: 1, clientY: drag.y + 40 })
    const before = await writes(page)
    await page.getByRole("button", { name: action, exact: true }).press("Enter")
    if (action === "Switch project") await expect(page.getByLabel("Current project")).toHaveText("second")
    else await expect(sash).toHaveCount(0)
    // The new keyed provider renders before the old owner's cleanup commits.
    await expect.poll(async () => Number(await committed.textContent())).toBeCloseTo(initial + 40 / height, 6)
    expect(await writes(page)).toBe(before + 1)
    await page.mouse.up()
    if (action === "Toggle panes") await page.getByRole("button", { name: action, exact: true }).press("Enter")
    await expect(sash).toBeVisible()
    await frames(page)
    expect(await writes(page)).toBe(before + 1)
    await sash.press("ArrowDown")
    await expect.poll(async () => Number(await committed.textContent())).toBeCloseTo(initial + 40 / height + 0.05, 6)
    expect(await writes(page)).toBe(before + 2)
  }
})

test("resizing retains filter focus, feedback drafts, navigation and live refresh", async ({ page, live }) => {
  await openLayout(page, live.origin, live.root)
  const file = page.getByRole("main").getByRole("region", { name: "src/app.ts", exact: true })
  await file.locator(".diff-view [data-additions] [data-column-number='1']").click()
  await page.keyboard.press("c")
  const composer = page.getByRole("textbox", { name: "Comment on src/app.ts:1" })
  await composer.fill("Keep this unsent review draft.")
  const filter = rail(page).getByRole("textbox", { name: "Filter files by path" })
  await filter.fill("app")
  const query = sourceControl(page).getByRole("textbox", { name: "Filter commits by message, author, or hash" })
  await query.fill("fixture")
  const url = page.url()
  for (const target of targets) {
    const sash = separator(page, target)
    const drag = await beginResize(page, sash)
    await filter.focus()
    await move(sash, target, drag, 24)
    await frames(page)
    await expect(filter).toBeFocused()
    await page.mouse.up()
    await expect(filter).toBeFocused()
    await expect(filter).toHaveValue("app")
    await expect(query).toHaveValue("fixture")
    await expect(composer).toHaveValue("Keep this unsent review draft.")
    expect(page.url()).toBe(url)
  }
  await expect(page.locator(".status-live")).toHaveAttribute("data-mode", "watching")
  const changed = path.join(live.root, "src/app.ts")
  const original = readFileSync(changed, "utf8")
  try {
    writeFileSync(changed, `${original}\nexport const resizeRefresh = 227\n`)
    await expect(file.locator(".diff-view")).toContainText("resizeRefresh")
    await expect(composer).toHaveValue("Keep this unsent review draft.")
    await expect(filter).toHaveValue("app")
    await expect(query).toHaveValue("fixture")
    await filter.fill("")
    await rail(page).getByRole("treeitem", { name: "README.md", exact: true }).click()
    await expect(page).toHaveURL(/#f=README\.md$/)
    await expect(page.getByRole("main").getByRole("region", { name: "README.md", exact: true })).toBeVisible()
    await rail(page).getByRole("treeitem", { name: "app.ts", exact: true }).click()
    await expect(page).toHaveURL(/#f=src\/app\.ts$/)
    await expect(composer).toHaveValue("Keep this unsent review draft.")
    await expect(file.locator(".diff-view")).toContainText("resizeRefresh")
  } finally {
    writeFileSync(changed, original)
  }
})

test("grid-owned width keeps the footer aligned and Source scrolling and focus intact", async ({ page, live }, info) => {
  const file = "resize-owner.ts"
  writeFileSync(path.join(live.root, file), Array.from({ length: 120 }, (_, index) => `export const line${index} = "${"long source text ".repeat(24)}"\n`).join(""))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=${file}`)
  const source = page.getByRole("textbox", { name: "TypeScript source", exact: true })
  await expect(source.locator(".source-document-line")).toHaveCount(120)
  await expect(source.locator(".source-document-line-content").last().locator("span").first()).toBeAttached()
  await page.keyboard.press("ControlOrMeta+Shift+g")
  await expect(sourceControl(page).getByRole("listbox", { name: "Commits", exact: true })).toBeVisible()
  const sidebar = page.getByRole("separator", { name: "Resize file tree", exact: true })
  await source.evaluate((element) => {
    element.scrollLeft = 160
    element.dataset.resizeIdentity = "retained"
  })
  const sourceWidthPreference = await source.evaluate((element) => getComputedStyle(element).getPropertyValue("--sidebar-width"))

  async function retained() {
    await frames(page)
    const workspace = await resizeBox(page.locator(".workspace"))
    const footer = await resizeBox(page.locator(".status-document"))
    expect(footer.x).toBeCloseTo(workspace.x, 0)
    // The measured hot width belongs only to the grids, not the document root.
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--sidebar-width"))).toBe("")
    expect(await source.evaluate((element) => getComputedStyle(element).getPropertyValue("--sidebar-width"))).toBe(sourceWidthPreference)
    await expect(source).toHaveAttribute("data-resize-identity", "retained")
    expect(await source.evaluate((element) => element.scrollLeft)).toBeCloseTo(160, 0)
    const gutter = await resizeBox(source.locator(".source-document-line-number").first())
    expect(gutter.x).toBeCloseTo((await resizeBox(source)).x, 0)
  }

  await retained()
  const drag = await beginResize(page, sidebar)
  await page.mouse.move(drag.x + 64, drag.y)
  await page.mouse.up()
  await expect(sidebar).toHaveAttribute("aria-valuenow", "352")
  await retained()
  const sash = page.getByRole("separator", { name: "Resize Uncommitted and Commits", exact: true })
  const before = await sash.getAttribute("aria-valuenow")
  await sash.press("ArrowDown")
  await expect(sash).not.toHaveAttribute("aria-valuenow", before ?? "")
  await retained()
  await sidebar.press("ArrowRight")
  await expect(sidebar).toHaveAttribute("aria-valuenow", "368")
  await retained()
  await sidebar.dblclick()
  await expect(sidebar).toHaveAttribute("aria-valuenow", "288")
  await retained()
  await source.focus()
  await expect(source).toBeFocused()
  const screenshot = info.outputPath("resize-source-focus.png")
  await page.screenshot({ path: screenshot })
  await info.attach("resize-source-focus.png", { path: screenshot, contentType: "image/png" })
  await page.emulateMedia({ media: "print" })
  expect(await source.evaluate((element) => getComputedStyle(element).contain)).toBe("none")
  await expect(source.locator(".source-document-line")).toHaveCount(120)
})
