// Pure model of the project browser tab (decision 0181): what the tab says
// about its project's guest window, from the state the desktop app reads.

import type { BrowserFailure, BrowserState } from "../../lib/desktop-bridge.ts"
import { pageLabel } from "./review-model.ts"

// BrowserPhase is what the tab shows: no page chosen yet, a page whose
// window is closed, a page loading, one that failed, or one showing.
export type BrowserPhase = "empty" | "closed" | "loading" | "failed" | "shown"

// browserPhase reads the tab's phase from the window's state (null without
// a window) and the last page the project reviewed.
export function browserPhase(state: BrowserState | null, lastURL: string): BrowserPhase {
  if (!state) return lastURL ? "closed" : "empty"
  if (state.failure) return "failed"
  return state.loading ? "loading" : "shown"
}

// currentPage is the page the tab stands for: the window's, else the last
// one reviewed.
export function currentPage(state: BrowserState | null, lastURL: string): string {
  return state?.url || lastURL
}

// browserTabName names the tab by its page's host, "localhost:5173", and
// "Browser" before it has one.
export function browserTabName(url: string): { label: string; title: string } {
  try {
    const parsed = new URL(url)
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) {
      return { label: parsed.host, title: `Browser: ${pageLabel(url)}` }
    }
  } catch {
    // Not an address yet.
  }
  return { label: "Browser", title: "Browser" }
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
