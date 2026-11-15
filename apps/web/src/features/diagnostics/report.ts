import type { Diagnostics } from "@zero/contracts"

import type { DesktopDiagnostics } from "../../lib/desktop-bridge.ts"
import type { UIError } from "../../lib/ui-errors.ts"

// Pure content for Report a Problem (decision 0151): the redacted Markdown a
// user reviews, copies, and pastes into an issue. ReportProblemDialog.tsx
// shows it.

export interface ClientFacts {
  // app is the desktop app or a web browser.
  app: "desktop" | "browser"
  // connection is how the page reaches its server.
  connection: "local" | "remote" | "sandbox"
  userAgent: string
}

export interface ReportInput {
  // server is null when /api/diagnostics failed; serverError says why.
  server: Diagnostics | null
  serverError: string
  // desktop is null outside the desktop app's local window.
  desktop: DesktopDiagnostics | null
  client: ClientFacts
  uiErrors: readonly UIError[]
}

const homeEnd = new Set(["/", "\\", " ", "\"", "'", ":", ",", ";", ")", "]", "}", "\n", "\t"])

// redact replaces home with ~ where it starts a path, as the server does.
export function redact(text: string, home: string): string {
  const prefix = home.replace(/[/\\]+$/, "")
  if (!prefix) return text
  let result = ""
  let rest = text
  for (let at = rest.indexOf(prefix); at >= 0; at = rest.indexOf(prefix)) {
    const end = at + prefix.length
    const boundary = end === rest.length || homeEnd.has(rest.charAt(end))
    result += rest.slice(0, at) + (boundary ? "~" : prefix)
    rest = rest.slice(end)
  }
  return result + rest
}

// clientFacts reads what the page knows about its client: a desktop window's
// host is "local" or a saved connection's id (r- remote, s- sandbox); a
// browser is local on a loopback host.
export function clientFacts(host: string, hostname: string, desktop: boolean, userAgent: string): ClientFacts {
  if (desktop) {
    const connection = host.startsWith("s-") ? "sandbox" : host === "local" ? "local" : "remote"
    return { app: "desktop", connection, userAgent }
  }
  const loopback = hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || hostname.startsWith("127.")
  return { app: "browser", connection: loopback ? "local" : "remote", userAgent }
}

function uptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function build(version: string, commit: string, date = ""): string {
  return [version || "unknown", commit && commit.slice(0, 12), date].filter(Boolean).join(" ")
}

// systemInfo is the report's facts without any log lines: short enough for
// an issue link.
export function systemInfo(input: ReportInput): string {
  const { server, desktop, client } = input
  const lines: string[] = []
  if (server) {
    lines.push(
      `- Server: zero ${build(server.version, server.commit, server.buildDate)}, ${server.os}/${server.arch}`,
      `- Mode: ${server.mode}${server.protocol ? ` (protocol ${server.protocol})` : ""}, up ${uptime(server.uptimeSeconds)}, ${server.roots} ${server.roots === 1 ? "root" : "roots"}`,
      `- Install: ${server.installMethod || "unknown"}`,
    )
    if (server.exposure) lines.push(`- Exposed: ${server.exposure}`)
  } else {
    lines.push(`- Server: unavailable (${input.serverError || "no response"})`)
  }
  lines.push(`- Client: ${client.app === "desktop" ? "desktop app" : "browser"}, ${client.connection} connection`)
  if (desktop) lines.push(`- Desktop app: ${build(desktop.version, desktop.commit)}`)
  lines.push(`- User agent: ${client.userAgent}`)
  return lines.join("\n")
}

// fence wraps lines in a code fence longer than any backtick run they hold.
function fence(lines: readonly string[]): string {
  const longest = Math.max(2, ...lines.map((line) => Math.max(0, ...[...line.matchAll(/`+/g)].map((run) => run[0].length))))
  const marks = "`".repeat(longest + 1)
  return `${marks}text\n${lines.join("\n")}\n${marks}`
}

function section(title: string, note: string, lines: readonly string[]): string {
  return lines.length ? `### ${title}\n\n${note}\n\n${fence(lines)}` : `### ${title}\n\n${note}\n\nNone.`
}

// buildReport is the whole report: the facts, then the server's, the desktop
// app's, and this tab's recent lines. Text the client adds is redacted with
// the server's home; the server and the app redacted their own.
export function buildReport(input: ReportInput): string {
  const { server, desktop } = input
  const home = server?.home ?? ""
  const parts = ["## zero problem report", systemInfo(input)]
  if (server) {
    parts.push(server.logsKept
      ? section("Server log", `Newest lines of ${server.logFile}.`, server.logLines)
      : "### Server log\n\nThis server keeps no log file.")
    if (server.crashLines.length) parts.push(section("Server crash output", "From the last crash.", server.crashLines))
  }
  if (desktop) {
    parts.push(section("Desktop app log", `Newest lines from ${desktop.logDir}.`, desktop.logLines))
    if (desktop.crashLines.length) parts.push(section("Desktop app crash output", "From the last crash.", desktop.crashLines))
  }
  parts.push(section("Recent errors in this window", "Failed requests and uncaught errors since the page loaded.",
    input.uiErrors.map((entry) => `${entry.at} ${redact(entry.message, home)}`)))
  return `${parts.join("\n\n")}\n`
}
