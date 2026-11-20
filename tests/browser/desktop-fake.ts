import type { Page } from "@playwright/test"

// Stand-ins for the desktop app's bridge (window.zeroDesktop). The web app
// shows features still being built, the Browser and visual feedback threads
// (decision 0184), only where the bridge says experimental features are on.

export interface FakeBrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  failure: { kind: string; url: string; description: string } | null
}

export interface FakeBrowser {
  // calls is what the page asked: ["open", project, url], ["action",
  // project, action], ["frame", project, frame | null], ["snapshot", project].
  calls: unknown[][]
  // state is what browserState answers.
  state: FakeBrowserState | null
  // snapshot is what browserSnapshot answers: a base64 PNG, or null.
  snapshot: string | null
}

declare global {
  interface Window {
    __browser?: FakeBrowser
    zeroDesktop?: unknown
  }
}

// A 1 × 1 PNG.
export const snapshotPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

// experimentalDesktop plays the desktop app with experimental features on
// and no Browser: visual threads and their screen tabs show.
export async function experimentalDesktop(page: Page) {
  await page.addInitScript(() => {
    window.zeroDesktop = { version: 2, experimental: { enabled: true, source: "env" } }
  })
}

// browserDesktop plays the desktop app hosting the Browser: it records what
// the page asks in window.__browser and answers the state a test sets.
export async function browserDesktop(page: Page, experimental = true) {
  await page.addInitScript(({ experimental, snapshot }) => {
    const fake: FakeBrowser = { calls: [], state: null, snapshot }
    window.__browser = fake
    window.zeroDesktop = {
      version: 2,
      experimental: { enabled: experimental, source: experimental ? "env" : "" },
      browserOpen(...args: unknown[]) { fake.calls.push(["open", ...args]); return Promise.resolve() },
      browserState() { return Promise.resolve(fake.state) },
      browserAction(...args: unknown[]) { fake.calls.push(["action", ...args]); return Promise.resolve() },
      browserFrame(...args: unknown[]) { fake.calls.push(["frame", ...args]); return Promise.resolve() },
      browserSnapshot(...args: unknown[]) { fake.calls.push(["snapshot", ...args]); return Promise.resolve(fake.snapshot) },
    }
  }, { experimental, snapshot: snapshotPNG })
}
