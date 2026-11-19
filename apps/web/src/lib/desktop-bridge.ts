import { isRecord } from "../api/http.ts"

declare global {
  interface Window {
    // zeroDesktop is the desktop app's preload bridge; browsers have none.
    zeroDesktop?: unknown
  }
}

// NativeMenuItem describes one native context menu row (decision 0081): an
// action the UI runs when its id comes back, or a separator. accelerator is a
// display hint (e.g. "CmdOrCtrl+W"); nothing registers it.
export type NativeMenuItem =
  | { id: string; label: string; enabled?: boolean; accelerator?: string }
  | { separator: true }

// NotificationConfig is what a page asks its connection's notifier to follow:
// the project it shows and the kinds the user chose (decision 0099).
export interface NotificationConfig {
  project: string
  commits: boolean
  branches: boolean
  edits: boolean
  walkthroughs: boolean
  // feedback is agents' replies to review feedback (decision 0120).
  feedback: boolean
}

// DesktopDiagnostics is the app's part of a problem report (decision 0152):
// its build, its log directory, and its newest log and crash lines, redacted.
export interface DesktopDiagnostics {
  version: string
  commit: string
  logDir: string
  logLines: string[]
  crashLines: string[]
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

// readDesktopDiagnostics accepts the app's report, or null.
export function readDesktopDiagnostics(value: unknown): DesktopDiagnostics | null {
  if (!isRecord(value)) return null
  const { version, commit, logDir, logLines, crashLines } = value
  if (typeof version !== "string" || typeof commit !== "string" || typeof logDir !== "string" || !isStrings(logLines) || !isStrings(crashLines)) return null
  return { version, commit, logDir, logLines, crashLines }
}

// ScreenPage is the page a desktop capture froze (decision 0176): its URL and
// title, its layout viewport in CSS pixels with the device scale factor that
// sizes the frame, and its scroll position in CSS pixels.
export interface ScreenPage {
  url: string
  title: string
  viewport: { width: number; height: number; deviceScaleFactor: number }
  scroll: { x: number; y: number }
}

// ScreenCapture is a capture waiting for this window's composer: its id, the
// project it comments on, the full frame as base64 PNG, the page, and its
// hit map (null when the page gave none that holds). drift says the page's
// layout moved while it was captured: the hit map may not match the frame.
export interface ScreenCapture {
  id: string
  project: string
  png: string
  page: ScreenPage
  hits: ScreenHits | null
  drift: boolean
}

// ScreenHits is a capture's hit map (decision 0180), recorded with the frame:
// grid holds, row by row, the element (an index into elements, -1 for none)
// topmost at the center of each step-pixel cell of the viewport.
export interface ScreenHits {
  step: number
  columns: number
  rows: number
  grid: readonly number[]
  elements: readonly ScreenHitElement[]
}

// ScreenHitElement is one element of a hit map, the page's own word:
// advisory, never trusted. parent is the nearest ancestor the map holds
// (earlier) or -1; box is the part the page showed, in CSS pixels of the
// viewport. Metadata is present while the page had time to describe it.
export interface ScreenHitElement {
  parent: number
  tag?: string
  selector?: string
  role?: string
  name?: string
  text?: string
  box?: { x: number; y: number; width: number; height: number }
  meaningful: boolean
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

// readScreenCapture accepts the app's pending capture, or null.
export function readScreenCapture(value: unknown): ScreenCapture | null {
  if (!isRecord(value)) return null
  const { id, project, png, page } = value
  if (typeof id !== "string" || id === "" || typeof project !== "string" || project === "" || typeof png !== "string" || png === "" || !isRecord(page)) return null
  const { url, title, viewport, scroll } = page
  if (typeof url !== "string" || typeof title !== "string" || !isRecord(viewport) || !isRecord(scroll)) return null
  const { width, height, deviceScaleFactor } = viewport
  if (!positive(width) || !positive(height) || !positive(deviceScaleFactor) || !finite(scroll.x) || !finite(scroll.y)) return null
  return {
    id, project, png,
    page: { url, title, viewport: { width, height, deviceScaleFactor }, scroll: { x: scroll.x, y: scroll.y } },
    hits: readScreenHits(value.hits, width, height),
    drift: value.drift === true,
  }
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

// readScreenHitElement accepts one element of a hit map at index, or null.
function readScreenHitElement(value: unknown, index: number): ScreenHitElement | null {
  if (!isRecord(value) || !whole(value.parent) || value.parent < -1 || value.parent >= index) return null
  const element: ScreenHitElement = { parent: value.parent, meaningful: value.meaningful === true }
  for (const key of ["tag", "selector", "role", "name", "text"] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== "string") return null
    if (field) element[key] = field
  }
  const { box } = value
  if (box !== undefined) {
    if (!isRecord(box) || !finite(box.x) || !finite(box.y) || !positive(box.width) || !positive(box.height)) return null
    element.box = { x: box.x, y: box.y, width: box.width, height: box.height }
  }
  return element
}

// readScreenHits accepts a hit map for a width × height viewport, or null:
// a grid that covers the viewport in step-pixel cells, whose cells name an
// element or none, and elements whose parents come first.
export function readScreenHits(value: unknown, width: number, height: number): ScreenHits | null {
  if (!isRecord(value)) return null
  const { step, columns, rows, grid, elements } = value
  if (!whole(step) || step < 1 || columns !== Math.ceil(width / step) || rows !== Math.ceil(height / step)) return null
  if (!Array.isArray(grid) || !Array.isArray(elements) || grid.length !== columns * rows) return null
  const read: ScreenHitElement[] = []
  for (const [index, element] of elements.entries()) {
    const parsed = readScreenHitElement(element, index)
    if (!parsed) return null
    read.push(parsed)
  }
  const cells: number[] = []
  for (const cell of grid) {
    if (!whole(cell) || cell < -1 || cell >= read.length) return null
    cells.push(cell)
  }
  return { step, columns, rows, grid: cells, elements: read }
}

// NotificationStatus is whether notices can reach the user.
export interface NotificationStatus {
  supported: boolean
  denied: boolean
}

// DesktopBridge is the desktop app's preload bridge (version 1 or later). Each
// method is feature-detected and null when absent (folders open in the page
// through the server since decision 0146, not through the bridge): showAppMenu (outside macOS,
// decision 0075) pops the app menu at a window point; revealPath shows a
// project file in the OS file manager; showContextMenu pops a native menu and
// resolves the chosen id, or null when dismissed (decision 0081); closeWindow
// closes the native window after the final tab (decision 0097);
// configureNotifications sets what the app notifies about and resolves whether
// notices can reach the user, or null when it refuses (decision 0099);
// setAppearance has the app's menus and window controls follow the theme's
// polarity, or the OS for "system" (decision 0119); diagnostics resolves the
// app's part of a problem report, or null when it refuses (decision 0152).
// openReview shows a page of the developer's app in the project's review
// window; screenCapture resolves the capture waiting for this window's
// composer, with its hit map, or null (decisions 0177, 0180). A
// window on a remote server has no revealPath or diagnostics: its files are
// not on this computer, and its server is not trusted with this computer's
// logs (decision 0098).
export interface DesktopBridge {
  version: number
  closeWindow: (() => void) | null
  showAppMenu: ((x: number, y: number) => void) | null
  revealPath: ((project: string, path: string) => void) | null
  showContextMenu: ((items: readonly NativeMenuItem[], x: number, y: number) => Promise<string | null>) | null
  configureNotifications: ((config: NotificationConfig) => Promise<NotificationStatus | null>) | null
  setAppearance: ((appearance: DesktopAppearance) => void) | null
  diagnostics: (() => Promise<DesktopDiagnostics | null>) | null
  openReview: ((project: string, url: string) => void) | null
  screenCapture: (() => Promise<ScreenCapture | null>) | null
}

// DesktopAppearance is the polarity native surfaces take: the OS's, or one.
export type DesktopAppearance = "system" | "light" | "dark"

// readDesktopBridge accepts a bridge of version 1 or later; any other value
// means no bridge. Methods that are missing or not functions are null.
export function readDesktopBridge(value: unknown): DesktopBridge | null {
  if (!isRecord(value) || typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) return null
  const { closeWindow, showAppMenu, revealPath, showContextMenu, configureNotifications, setAppearance, diagnostics } = value
  const { openReview, screenCapture } = value
  return {
    version: value.version,
    closeWindow: typeof closeWindow === "function"
      ? () => {
        closeWindow.call(value)
      }
      : null,
    showAppMenu: typeof showAppMenu === "function"
      ? (x, y) => {
        showAppMenu.call(value, x, y)
      }
      : null,
    revealPath: typeof revealPath === "function"
      ? (project, path) => {
        // The app reports refusals itself.
        Promise.resolve(revealPath.call(value, project, path)).catch(() => undefined)
      }
      : null,
    showContextMenu: typeof showContextMenu === "function"
      ? async (items, x, y) => {
        try {
          const chosen: unknown = await showContextMenu.call(value, items, x, y)
          return typeof chosen === "string" ? chosen : null
        } catch {
          return null
        }
      }
      : null,
    configureNotifications: typeof configureNotifications === "function"
      ? async (config) => {
        try {
          const status: unknown = await configureNotifications.call(value, config)
          return isRecord(status) && typeof status.supported === "boolean" && typeof status.denied === "boolean"
            ? { supported: status.supported, denied: status.denied }
            : null
        } catch {
          return null
        }
      }
      : null,
    setAppearance: typeof setAppearance === "function"
      ? (appearance) => {
        setAppearance.call(value, appearance)
      }
      : null,
    diagnostics: typeof diagnostics === "function"
      ? async () => {
        try {
          return readDesktopDiagnostics(await diagnostics.call(value))
        } catch {
          return null
        }
      }
      : null,
    openReview: typeof openReview === "function"
      ? (project, url) => {
        // The app reports failures itself.
        Promise.resolve(openReview.call(value, project, url)).catch(() => undefined)
      }
      : null,
    screenCapture: typeof screenCapture === "function"
      ? async () => {
        try {
          return readScreenCapture(await screenCapture.call(value))
        } catch {
          return null
        }
      }
      : null,
  }
}

// desktopBridge is the bridge the desktop app exposes, or null in browsers.
export function desktopBridge(): DesktopBridge | null {
  return typeof window === "undefined" ? null : readDesktopBridge(window.zeroDesktop)
}

// notificationsAvailable reports a client that can show notices: the desktop
// app, on either transport.
export function notificationsAvailable(): boolean {
  return Boolean(desktopBridge()?.configureNotifications)
}
