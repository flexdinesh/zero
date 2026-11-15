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

// DesktopDiagnostics is the app's part of a problem report (decision 0151):
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
// app's part of a problem report, or null when it refuses (decision 0151). A
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
}

// DesktopAppearance is the polarity native surfaces take: the OS's, or one.
export type DesktopAppearance = "system" | "light" | "dark"

// readDesktopBridge accepts a bridge of version 1 or later; any other value
// means no bridge. Methods that are missing or not functions are null.
export function readDesktopBridge(value: unknown): DesktopBridge | null {
  if (!isRecord(value) || typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) return null
  const { closeWindow, showAppMenu, revealPath, showContextMenu, configureNotifications, setAppearance, diagnostics } = value
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
