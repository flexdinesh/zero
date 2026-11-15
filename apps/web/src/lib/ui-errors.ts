// ui-errors.ts keeps this tab's recent failures for a problem report
// (decision 0151): uncaught errors, unhandled rejections, and failed API
// requests. It holds only the newest UI_ERROR_LIMIT, in memory, never sent
// anywhere on its own.

export const UI_ERROR_LIMIT = 50

export interface UIError {
  // at is when it happened, as an ISO timestamp.
  at: string
  message: string
}

// UIErrorLog is a bounded list, newest last.
export class UIErrorLog {
  readonly #limit: number
  #entries: UIError[] = []

  constructor(limit = UI_ERROR_LIMIT) {
    this.#limit = limit
  }

  record(message: string, at: Date = new Date()) {
    const text = message.trim()
    if (!text) return
    this.#entries.push({ at: at.toISOString(), message: text })
    if (this.#entries.length > this.#limit) this.#entries = this.#entries.slice(-this.#limit)
  }

  entries(): readonly UIError[] {
    return [...this.#entries]
  }
}

// uiErrors is the page's log.
export const uiErrors = new UIErrorLog()

// describeThrown phrases an uncaught value.
export function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.stack && value.stack.includes(value.message) ? value.stack : `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// requestPath is a URL's path without its query, which names files.
export function requestPath(url: string): string {
  const end = url.search(/[?#]/)
  return end < 0 ? url : url.slice(0, end)
}

let watching = false

// watchUncaughtErrors records the window's uncaught errors and unhandled
// rejections once per page.
export function watchUncaughtErrors() {
  if (watching || typeof window === "undefined") return
  watching = true
  window.addEventListener("error", (event) => {
    uiErrors.record(`Uncaught ${describeThrown(event.error ?? event.message)}`)
  })
  window.addEventListener("unhandledrejection", (event) => {
    uiErrors.record(`Unhandled rejection: ${describeThrown(event.reason)}`)
  })
}
