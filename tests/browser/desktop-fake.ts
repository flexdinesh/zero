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
  // Comment mode, and the composer showing over the guest (layer 4).
  commenting?: boolean
  composing?: boolean
}

export interface FakeBrowser {
  // calls is what the page asked: ["open", project, url], ["action",
  // project, action], ["frame", project, frame | null], ["snapshot", project],
  // ["pins", project, pins, visible].
  calls: unknown[][]
  // state is what browserState answers.
  state: FakeBrowserState | null
  // snapshot is what browserSnapshot answers: a base64 PNG, or null.
  snapshot: string | null
}

export interface FakeComposer {
  // calls is what the composer's page asked: ["capture"], ["walk",
  // direction], ["resize", height], ["close", sent].
  calls: unknown[][]
  // capture is the pick that waits, null for none. A walk that answers
  // replaces it; closing ends it.
  capture: unknown
  // walks are what composerWalk answers for each direction.
  walks: { parent: unknown; child: unknown }
}

// FakeIdentities is the app's side of repository identities (decision
// 0188): calls records ["find", identity], ["open", connection, project],
// and ["set", identity, marks]; matches is what findProject answers; marks
// is the store by identity.
export interface FakeIdentities {
  calls: unknown[][]
  matches: unknown[]
  marks: Record<string, Record<string, string>>
}

declare global {
  interface Window {
    __browser?: FakeBrowser
    __composer?: FakeComposer
    __identities?: FakeIdentities
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
// comments false is the app before in-page comments: no pins method.
export async function browserDesktop(page: Page, experimental = true, comments = true) {
  await page.addInitScript(({ comments, experimental, snapshot }) => {
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
      ...(comments ? { browserPins(...args: unknown[]) { fake.calls.push(["pins", ...args]); return Promise.resolve() } } : {}),
    }
  }, { comments, experimental, snapshot: snapshotPNG })
}

// composerDesktop plays the desktop app's composer web view (decision
// 0184): the bridge of the page at /composer, which reads the pick that
// waits, walks it, reports its height, and closes.
export async function composerDesktop(page: Page, capture: unknown, experimental = true) {
  await page.addInitScript(({ capture, experimental }) => {
    const fake: FakeComposer = { calls: [], capture, walks: { parent: null, child: null } }
    window.__composer = fake
    window.zeroDesktop = {
      version: 2,
      experimental: { enabled: experimental, source: experimental ? "env" : "" },
      composerCapture() { fake.calls.push(["capture"]); return Promise.resolve(fake.capture) },
      composerWalk(direction: unknown) {
        fake.calls.push(["walk", direction])
        const next = direction === "parent" ? fake.walks.parent : fake.walks.child
        if (next) fake.capture = next
        return Promise.resolve(next)
      },
      composerResize(height: unknown) { fake.calls.push(["resize", height]); return Promise.resolve() },
      composerClose(sent: unknown) { fake.calls.push(["close", sent]); fake.capture = null; return Promise.resolve() },
    }
  }, { capture, experimental })
}

// identitiesDesktop plays the desktop app's identity methods: matches are
// other connections' checkouts, marks its store of Viewed marks.
export async function identitiesDesktop(page: Page, matches: unknown[], marks: Record<string, Record<string, string>> = {}) {
  await page.addInitScript(({ found, stored }) => {
    const identities: FakeIdentities = { calls: [], matches: found, marks: stored }
    window.__identities = identities
    window.zeroDesktop = {
      version: 2,
      viewedMarks: (identity: string) => Promise.resolve(identities.marks[identity] ?? {}),
      setViewedMarks: (identity: string, files: Record<string, string>) => {
        identities.calls.push(["set", identity, files])
        identities.marks[identity] = files
        return Promise.resolve()
      },
      findProject: (identity: string) => {
        identities.calls.push(["find", identity])
        return Promise.resolve(identities.matches)
      },
      openProject: (connection: string, project: string) => {
        identities.calls.push(["open", connection, project])
        return Promise.resolve()
      },
    }
  }, { found: matches, stored: marks })
}
