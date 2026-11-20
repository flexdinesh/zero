// Pure model of the composer (decision 0184): the page Zero shows beside a
// pick on the Browser's page. It names the pick, lists what a comment on it
// sends, and turns the pick into the visual target the server stores.

import type { ComposerCapture, WalkDirection } from "../../lib/desktop-bridge.ts"
import { projectName } from "../../workspace/navigation-history.ts"
import { regionMargin, type Size } from "../feedback/visual-geometry.ts"
import { elementLabel, planVisual, type VisualPlan } from "../feedback/visual-model.ts"

function whole(value: number): string {
  return String(Math.round(value))
}

// pickLabel names what was picked: `button "Save changes"` for an element,
// "Region 260 × 80" (CSS pixels) for a region.
export function pickLabel(capture: ComposerCapture): string {
  if (capture.kind === "element" && capture.element) return elementLabel(capture.element)
  return `Region ${whole(capture.rect.width)} × ${whole(capture.rect.height)}`
}

// pickOrigin is what rendered the pick, when the page's framework said:
// "SettingsForm › Card › Button · src/settings/SettingsForm.tsx:42".
export function pickOrigin(capture: ComposerCapture): string {
  return [capture.element?.component ?? "", capture.element?.source ?? ""].filter(Boolean).join(" · ")
}

// canWalk reports whether the pick can move in direction: only an element
// walks, and only where the page says there is one.
export function canWalk(capture: ComposerCapture, direction: WalkDirection): boolean {
  if (capture.kind !== "element") return false
  return direction === "parent" ? capture.canWalkUp : capture.canWalkDown
}

// SentFact is one thing a comment carries: a label and its values, each
// the page's own text.
export interface SentFact {
  label: string
  values: string[]
}

// sentFacts lists what goes with a comment on the pick, in the order the
// thread shows it. Facts the page did not give are left out.
export function sentFacts(capture: ComposerCapture): SentFact[] {
  const { element, page, rect } = capture
  const { viewport } = page
  const facts: SentFact[] = [
    { label: "Screenshot", values: [`The selection and ${regionMargin} px around it`] },
    { label: "Page", values: [page.url] },
  ]
  const add = (label: string, ...values: (string | undefined)[]) => {
    const given = values.filter((value): value is string => Boolean(value))
    if (given.length > 0) facts.push({ label, values: given })
  }
  add("Title", page.title)
  add("Viewport", `${whole(viewport.width)} × ${whole(viewport.height)} at ${Math.round(viewport.deviceScaleFactor * 100) / 100}×, ${page.colorScheme}`)
  add("Rectangle", `${whole(rect.x)}, ${whole(rect.y)} · ${whole(rect.width)} × ${whole(rect.height)}`)
  if (!element) return facts
  add("Element", elementLabel(element))
  add("Selector", element.selector)
  add("Path", element.path)
  add("Component", element.component)
  add("Source", element.source)
  add("Classes", element.classes)
  add("Attributes", ...(element.attributes ?? []).map((pair) => `${pair.name}=${pair.value}`))
  add("Styles", ...(element.styles ?? []).map((pair) => `${pair.name}: ${pair.value}`))
  add("Nearby text", element.nearby)
  add("Selected text", element.selectedText)
  return facts
}

// capturePlan maps the pick onto the captured frame (frame is the PNG's
// own size): the part to upload, the selection plus the 48 CSS px margin,
// and the page, rectangle, and element in that image's pixels. null when
// the selection is outside the frame.
export function capturePlan(capture: ComposerCapture, frame: Size): VisualPlan | null {
  const { deviceScaleFactor } = capture.page.viewport
  const { rect } = capture
  const drawn = {
    x: rect.x * deviceScaleFactor, y: rect.y * deviceScaleFactor,
    width: rect.width * deviceScaleFactor, height: rect.height * deviceScaleFactor,
  }
  return planVisual(drawn, frame, capture.page, "region", capture.element)
}

// targetLabel says where a comment goes: "acme-web · feature/billing", or
// the folder alone without a branch.
export function targetLabel(project: string, branch: string): string {
  const folder = projectName(project)
  return branch ? `${folder} · ${branch}` : folder
}

// ComposerKey is what a key press asks of the composer.
export type ComposerKey = { kind: "close" } | { kind: "send" } | { kind: "walk"; direction: WalkDirection }

interface KeyPress {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

// composerKey reads the composer's keys: Escape closes, Ctrl/Cmd+Enter
// sends, Alt+ArrowUp walks to the parent and Alt+ArrowDown back.
export function composerKey(event: KeyPress): ComposerKey | null {
  if (event.isComposing) return null
  const command = event.ctrlKey || event.metaKey
  if (event.key === "Escape" && !command && !event.altKey && !event.shiftKey) return { kind: "close" }
  if (event.key === "Enter" && command && !event.altKey) return { kind: "send" }
  if (event.altKey && !command && !event.shiftKey && event.key === "ArrowUp") return { kind: "walk", direction: "parent" }
  if (event.altKey && !command && !event.shiftKey && event.key === "ArrowDown") return { kind: "walk", direction: "child" }
  return null
}
