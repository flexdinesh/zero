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

// BrowserFailureKind is why a project browser's page did not show (decision
// 0184): it could not load, its certificate was refused, the page asked for
// a scheme the guest refuses, or its web process stopped.
export type BrowserFailureKind = "load" | "certificate" | "refused" | "crashed"

// BrowserFailure is the page's last failure: the address it concerned and
// the web view's one-line description.
export interface BrowserFailure {
  kind: BrowserFailureKind
  url: string
  description: string
}

// BrowserState is a project's guest as the app reads it now (decision
// 0184): the page's address ("" before the first load commits) and title,
// whether it is loading, its history, its last failure, cleared by the next
// navigation, and whether comment mode is on or the composer shows.
export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  failure: BrowserFailure | null
  commenting: boolean
  composing: boolean
}

// BrowserAction is what the Browser tab asks of its guest.
export type BrowserAction = "back" | "forward" | "reload" | "stop" | "close"

// BrowserFrame is where the guest shows: a rectangle of this page's
// viewport in CSS pixels.
export interface BrowserFrame {
  x: number
  y: number
  width: number
  height: number
}

const failureKinds: readonly string[] = ["load", "certificate", "refused", "crashed"] satisfies readonly BrowserFailureKind[]

function isFailureKind(value: unknown): value is BrowserFailureKind {
  return typeof value === "string" && failureKinds.includes(value)
}

function readBrowserFailure(value: unknown): BrowserFailure | null | undefined {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) return undefined
  const { kind, url, description } = value
  if (!isFailureKind(kind) || typeof url !== "string" || typeof description !== "string") return undefined
  return { kind, url, description }
}

// readBrowserState accepts the app's state of a project's guest, or null:
// no guest, or an answer that is not one. A missing title reads as "", and
// missing commenting or composing as false.
export function readBrowserState(value: unknown): BrowserState | null {
  if (!isRecord(value)) return null
  const { url, title, loading, canGoBack, canGoForward } = value
  const failure = readBrowserFailure(value.failure)
  if (typeof url !== "string" || typeof loading !== "boolean" || typeof canGoBack !== "boolean" || typeof canGoForward !== "boolean" || failure === undefined) {
    return null
  }
  return {
    url, title: typeof title === "string" ? title : "", loading, canGoBack, canGoForward, failure,
    commenting: value.commenting === true, composing: value.composing === true,
  }
}

// ExperimentalSource says what decided the app's experimental features
// (decision 0184): the environment turned them off, a development build or
// the environment turned them on, or the user's own choice did; "" when
// nothing did and they are off.
export type ExperimentalSource = "" | "off" | "build" | "env" | "setting"

// ExperimentalState is whether the app shows features still being built, and
// what decided it. Only "" and "setting" leave the user a choice.
export interface ExperimentalState {
  enabled: boolean
  source: ExperimentalSource
}

const experimentalSources: readonly string[] = ["", "off", "build", "env", "setting"] satisfies readonly ExperimentalSource[]

function isExperimentalSource(value: unknown): value is ExperimentalSource {
  return typeof value === "string" && experimentalSources.includes(value)
}

// readExperimentalState accepts the app's state, or null.
export function readExperimentalState(value: unknown): ExperimentalState | null {
  if (!isRecord(value)) return null
  const { enabled, source } = value
  if (typeof enabled !== "boolean" || !isExperimentalSource(source)) return null
  return { enabled, source }
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
// The browser methods drive a project's guest, the page the Browser tab
// shows (decision 0184): browserOpen makes it if the project has none and
// navigates; browserState resolves it, or null without one; browserAction
// steers it; browserFrame says where it shows, or hides it with null (the
// page is kept); browserSnapshot resolves its frame now as a base64 PNG, or
// null. A
// window on a remote server has no revealPath or diagnostics: its files are
// not on this computer, and its server is not trusted with this computer's
// logs (decision 0098). experimental is the state the window opened with, and
// setExperimental remembers the user's choice and resolves the state that
// results; the app reopens its windows when that changes (decision 0184).
export interface DesktopBridge {
  version: number
  experimental: ExperimentalState | null
  setExperimental: ((enabled: boolean) => Promise<ExperimentalState | null>) | null
  closeWindow: (() => void) | null
  showAppMenu: ((x: number, y: number) => void) | null
  revealPath: ((project: string, path: string) => void) | null
  showContextMenu: ((items: readonly NativeMenuItem[], x: number, y: number) => Promise<string | null>) | null
  configureNotifications: ((config: NotificationConfig) => Promise<NotificationStatus | null>) | null
  setAppearance: ((appearance: DesktopAppearance) => void) | null
  diagnostics: (() => Promise<DesktopDiagnostics | null>) | null
  browserOpen: ((project: string, url: string) => Promise<void>) | null
  browserState: ((project: string) => Promise<BrowserState | null>) | null
  browserAction: ((project: string, action: BrowserAction) => Promise<void>) | null
  browserFrame: ((project: string, frame: BrowserFrame | null) => void) | null
  browserSnapshot: ((project: string) => Promise<string | null>) | null
}

// DesktopAppearance is the polarity native surfaces take: the OS's, or one.
export type DesktopAppearance = "system" | "light" | "dark"

// readDesktopBridge accepts a bridge of version 1 or later; any other value
// means no bridge. Methods that are missing or not functions are null.
export function readDesktopBridge(value: unknown): DesktopBridge | null {
  if (!isRecord(value) || typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) return null
  const { closeWindow, showAppMenu, revealPath, showContextMenu, configureNotifications, setAppearance, diagnostics } = value
  const { browserOpen, browserState, browserAction, browserFrame, browserSnapshot, setExperimental } = value
  return {
    version: value.version,
    experimental: readExperimentalState(value.experimental),
    setExperimental: typeof setExperimental === "function"
      ? async (enabled) => {
        try {
          return readExperimentalState(await setExperimental.call(value, enabled))
        } catch {
          return null
        }
      }
      : null,
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
    browserOpen: typeof browserOpen === "function"
      ? async (project, url) => {
        try {
          // The app reports failures in the guest's state.
          await browserOpen.call(value, project, url)
        } catch {
          // Refused: the state says what shows.
        }
      }
      : null,
    browserState: typeof browserState === "function"
      ? async (project) => {
        try {
          return readBrowserState(await browserState.call(value, project))
        } catch {
          return null
        }
      }
      : null,
    browserAction: typeof browserAction === "function"
      ? async (project, action) => {
        try {
          await browserAction.call(value, project, action)
        } catch {
          // Refused: the state says what shows.
        }
      }
      : null,
    browserFrame: typeof browserFrame === "function"
      ? (project, frame) => {
        Promise.resolve(browserFrame.call(value, project, frame)).catch(() => undefined)
      }
      : null,
    browserSnapshot: typeof browserSnapshot === "function"
      ? async (project) => {
        try {
          const png: unknown = await browserSnapshot.call(value, project)
          return typeof png === "string" && png !== "" ? png : null
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

// experimentalEnabled reports whether features still being built show
// (decision 0184): only in the desktop app, when its state says so.
export function experimentalEnabled(): boolean {
  return desktopBridge()?.experimental?.enabled === true
}

// hostsBrowser reports a bridge whose window hosts the Browser (decision
// 0184): experimental features on, and every browser method offered.
export function hostsBrowser(bridge: DesktopBridge | null): boolean {
  return Boolean(bridge?.experimental?.enabled && bridge.browserOpen && bridge.browserState && bridge.browserAction
    && bridge.browserFrame && bridge.browserSnapshot)
}

// browserAvailable reports whether this window hosts the Browser.
export function browserAvailable(): boolean {
  return hostsBrowser(desktopBridge())
}

// notificationsAvailable reports a client that can show notices: the desktop
// app, on either transport.
export function notificationsAvailable(): boolean {
  return Boolean(desktopBridge()?.configureNotifications)
}
