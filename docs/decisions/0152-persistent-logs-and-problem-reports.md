# 0152: Persistent logs and Report a Problem

- Status: Accepted
- Date: 2026-11-15
- Extends: [0061](0061-daemon-roots-and-leases.md), [0080](0080-application-layer-contracts-and-transports.md),
  [0081](0081-desktop-bridge-v2-native-features.md), [0094](0094-mygo-app-uses-web-views.md)

## Context

When something failed, users had nothing to send. The daemon wrote startup and
stop lines to `<socket>.log`, truncated on every start, and logged no request
failures: `internal` errors reached the client only. The desktop app's
`log.Printf` went to stderr, lost when the app opens from the Dock or a
launcher. Language server stderr was kept only as a 2 KiB tail on the error.
Uncaught errors in the web app reached only the devtools console. There was no
report to paste into an issue.

## Decision

- Logs live in the user's log directory: `$XDG_STATE_HOME/zero/logs`, else
  `~/.local/state/zero/logs` on Linux; `~/Library/Logs/zero` on macOS
  (`pkg/logfile`, `Dir`). The directory is 0700 and files 0600. A daemon on a
  socket other than the default one, and a desktop app with
  `ZERO_DESKTOP_SOCKET`, log in `logs/` beside the socket, so dev and test
  daemons keep out of the user's logs.
- Each log rotates at 5 MiB, keeping one older file (`<name>.log`,
  `<name>.log.1`): at most 10 MiB per process. `debug.SetCrashOutput` also
  writes a fatal panic to `<name>-crash.log`, rotated when it opens. Signals
  that kill a process leave no crash output.
- The daemon logs `log/slog` text lines (`daemon.log`) at `ZERO_LOG`'s level
  (`debug`, `info` by default, `warn`, `error`) to stderr and the file. Info:
  startup, saved roots dropped or skipped, exposures, the stop reason, language
  server starts, falling back to polling. Warn: language server failures with
  their stderr tail. Error: every response with a 5xx status, with its method,
  path, status, and the first 512 bytes of its body. Every request at debug.
  The query is never logged: it names files. `<socket>.log` stays, for what a
  started daemon prints before its log opens.
- The desktop app's standard logger also writes `desktop.log`, with
  `desktop-crash.log`. Foreground browser and stdio servers keep no log file.
- `GET /api/diagnostics` (`contract.Diagnostics`, `internal/app`
  `Diagnostics`) describes the server: build, OS and architecture, install
  method (detected only when asked), mode (`daemon`, `browser`, `stdio`),
  daemon protocol, uptime, root count, active exposure, home directory, and
  the newest 200 log and crash lines. Paths and lines are redacted
  (`logfile.Redact`): the home directory becomes `~`; connection credentials
  and named tokens become placeholders. It answers over every transport,
  remote ones included: whoever connects already browses that machine's files.
- Bridge method `diagnostics()` answers the desktop app's build, log directory,
  and newest lines, redacted, to the local window only, like `revealPath`: a
  remote server is not trusted with this machine's logs. The UI feature-detects
  it.
- The web app keeps its last 50 uncaught errors, unhandled rejections, and
  failed API requests (method, path without the query, status, message) in
  memory (`lib/ui-errors.ts`).
- Report a Problem is a dialog: the Markdown report (`features/diagnostics/
  report.ts`) of server facts, client facts (desktop or browser, local,
  remote, or sandbox connection, user agent), the server's, the app's, and the
  window's recent lines, redacted again with the server's home. Copy puts the
  whole report on the clipboard. Open GitHub issue opens
  `github.com/flexdinesh/zero/issues/new` with the facts and no log lines,
  under 6000 characters, asking for the copied report. Nothing is sent until
  the user pastes it. It opens from Help: Report a Problem… in the command
  palette, the desktop app's Help menu (which also has Open Logs Folder), the
  Welcome tab, and the status bar's error panel.

## Consequences

- A user can attach what happened without knowing where zero keeps anything.
- Redaction knows only its patterns; file names and error text stay. The user
  reads the report before sharing it.
- The daemon writes to disk on failures and lifecycle events; requests write
  only at debug level.
- No crash reporting service: zero sends nothing on its own.
- A `zero bugreport` CLI and issue forms are left for later; the report comes
  from the server, so a CLI can reuse it.
