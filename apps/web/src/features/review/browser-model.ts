// Pure model of the Browser tab (decision 0184): what the tab says about
// its project's guest, the page the desktop app shows over the tab's stage,
// from the state the app reads.

import type { BrowserFailure, BrowserState } from "../../lib/desktop-bridge.ts"
import { pageLabel } from "./review-model.ts"

// StageView is what the tab's stage holds: nothing yet (no guest and no
// page remembered), a page that closed (no guest, but the tab remembers
// what it showed; decision 0195), a failure Zero draws in the page's place,
// or the page itself.
export type StageView = "empty" | "closed" | "failed" | "page"

// blockingFailure is a failure that leaves no page to show. A refused
// scheme is not one: the guest keeps the page it had.
export function blockingFailure(state: BrowserState | null): BrowserFailure | null {
  return state?.failure && state.failure.kind !== "refused" ? state.failure : null
}

// refusedFailure is a navigation the guest refused while its page stays.
export function refusedFailure(state: BrowserState | null): BrowserFailure | null {
  return state?.failure?.kind === "refused" ? state.failure : null
}

// stageView reads the stage from the guest's state (null without a guest)
// and the address the tab last showed ("" for none).
export function stageView(state: BrowserState | null, remembered = ""): StageView {
  if (!state) return remembered ? "closed" : "empty"
  return blockingFailure(state) ? "failed" : "page"
}

// currentPage is the page the tab stands for: the guest's, else the last
// one opened.
export function currentPage(state: BrowserState | null, lastURL: string): string {
  return state?.url || lastURL
}

const titleLimit = 120

// browserTabName names the tab by its page's host, "localhost:5173", and
// "Browser" before it has one; its title adds the page's own title, one
// line and bounded, when the guest has read one.
export function browserTabName(url: string, title = ""): { label: string; title: string } {
  try {
    const parsed = new URL(url)
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) {
      const named = [...title.replace(/\s+/g, " ").trim()].slice(0, titleLimit).join("")
      return { label: parsed.host, title: named ? `Browser: ${named} · ${pageLabel(url)}` : `Browser: ${pageLabel(url)}` }
    }
  } catch {
    // Not an address yet.
  }
  return { label: "Browser", title: "Browser" }
}

// BrowserTabPage is what names a Browser tab: its number and the page it
// shows, or last showed, with the page's title when the guest read one.
export interface BrowserTabPage {
  id: number
  url: string
  title: string
}

// browserTabNames names each Browser tab (decision 0195) as browserTabName
// does; tabs whose labels would read the same add their page's path, and
// tabs with no page yet their number past the first.
export function browserTabNames(tabs: readonly BrowserTabPage[]): Map<number, { label: string; title: string }> {
  const names = new Map(tabs.map((tab) => [tab.id, browserTabName(tab.url, tab.title)]))
  const counts = new Map<string, number>()
  for (const name of names.values()) counts.set(name.label, (counts.get(name.label) ?? 0) + 1)
  for (const tab of tabs) {
    const name = names.get(tab.id)
    if (!name || (counts.get(name.label) ?? 0) < 2) continue
    if (name.label === "Browser") {
      if (tab.id > 1) names.set(tab.id, { label: `Browser ${tab.id}`, title: `Browser ${tab.id}` })
      continue
    }
    const path = new URL(tab.url).pathname
    if (path !== "/") names.set(tab.id, { ...name, label: `${name.label}${path}` })
  }
  return names
}

// isLoopback reports a URL on this machine: localhost, *.localhost,
// 127.0.0.0/8, or [::1].
export function isLoopback(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]"
}

// FailureText is how the tab words a failure: what happened, what to try,
// and the action that retries.
export interface FailureText {
  title: string
  detail: string
  retry: string
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function sentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

// failureText words a failure for the tab. The web view's description is
// its own word and stays as it is, after what Zero knows.
export function failureText(failure: BrowserFailure): FailureText {
  const description = sentence(failure.description)
  switch (failure.kind) {
    case "certificate":
      return {
        title: `${hostOf(failure.url)} has a certificate Zero does not trust`,
        detail: "The browser opens no page with a certificate error. Serve the page over http, or with a certificate this computer trusts.",
        retry: "Try again",
      }
    case "refused":
      return {
        title: `The page tried to open ${failure.url}`,
        detail: "The browser opens only http and https pages. The page stays where it was.",
        retry: "Reload",
      }
    case "crashed":
      return {
        title: "The page stopped",
        detail: description || "Its web process ended. Reload to start it again.",
        retry: "Reload",
      }
    case "load": {
      const hint = isLoopback(failure.url) ? " Is its dev server running?" : " Check the address and your connection."
      return {
        title: `Could not load ${pageLabel(failure.url)}`,
        detail: `${description || "The page did not answer."}${hint}`,
        retry: "Try again",
      }
    }
  }
}
