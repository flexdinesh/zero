# 0148: Client and server versions in remote workflows

- Status: Accepted
- Date: 2026-11-15
- Extends: [0098](0098-remote-connections.md), [0127](0127-sandbox-attach-and-stdio-transport.md),
  [0128](0128-sandbox-connections-in-the-desktop-app.md), [0147](0147-zero-update.md)

## Context

A remote server describes itself at `/_zero/remote` (`RemoteInfo`: protocol,
version, host name), and `zero connect` printed the version, but nothing
compared it. A remote window's page is the server's web app, so a warning drawn
by the page never reaches a person whose server is the older side; only code the
client owns can say it. `zero attach` installs the client's own version, so only
development builds differ there. Tailscale and `--web` serve a browser, which
has no build of its own.

## Decision

- `RemoteInfo` gains an optional `commit` (the stamped build commit). Older
  servers omit it.
- `connection.Compare(local, server)` (pure, `pkg/connection`): another protocol
  is incompatible; two releases compare by version (older or newer); otherwise
  two commits compare (a prefix matches); a development build without a commit
  on either side is unknown and stays quiet, since nothing tells the builds
  apart. `VersionWarning` names the side to update: `zero update` on the server
  and `zero <path> --remote` again, or `<name> update` here.
- `zero connect` and `zero attach` print the warning on stderr and carry on;
  another protocol fails before anything is saved.
- The desktop app compares the server with its own build (`version`, `commit`,
  `connect.Protocol`; the bundled zero is the same release) on a saved
  connection's first page load that reaches the server, over the window's own
  transport, TLS or sandbox. Another protocol is the window's failure page, and
  every request of that server is refused. Any other difference is a native
  notice, once per connection and server build for the app's lifetime,
  whatever the page's notification settings say. A server that does not answer
  is checked again on the next page load.

## Consequences

- With notifications denied, the desktop warning is not seen; `zero connect`
  still warns.
- One extra request per saved connection per app run.
- The protocol is 1 everywhere, so nothing is refused today.
- Builds without stamps (`go run`, tests) never warn.
