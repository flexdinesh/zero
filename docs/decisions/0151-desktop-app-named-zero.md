# 0151: Desktop app named Zero; process names

- Status: Accepted
- Date: 2026-11-15
- Supersedes: [0095](0095-desktop-app-is-mygo-electron-removed.md)'s and
  [0118](0118-zero-name-and-collision-safe-installs.md)'s desktop names
  (`zero-desktop` binary, bundle, launcher, Linux data directory, assets)
- Revises: [0101](0101-install-script-installs-cli-and-desktop.md)'s PATH launcher

## Context

The desktop app showed as `zero-desktop` everywhere: the macOS bundle and its
Activity Monitor name, the Linux process, a `~/.local/bin` launcher, and the
release assets. The daemon showed its full flag list:
`zero daemon run --socket … --depth 5 --scan-depth 10 --idle-exit 30m0s`.
Similar tools name the app for the product and keep the CLI short: `Zed.app`
with `zed` and, on Linux, `zed-editor` off PATH; `Ollama.app` with
`ollama serve` from the same binary.

## Decision

| Thing | Name |
| --- | --- |
| Display name (window, menus, desktop entry, Dock) | Zero |
| macOS bundle and process | `Zero.app`, `Contents/MacOS/Zero` |
| Linux binary, process, mygo slug | `zero-app` |
| Linux desktop entry and icon | `zero-app.desktop`, `zero-app` |
| Linux app and page state | `$XDG_DATA_HOME/zero-app/`: `app/` and WebKit's store beside it |
| Window looks (`appearance.json`) | mygo user data: `$XDG_CONFIG_HOME/Zero/`, `~/Library/Application Support/Zero/` |
| Assets | `zero-app_<version>_linux_<arch>.tar.gz`, `zero-app_<version>_darwin_<arch>.zip` |
| `--version` | `zero-app <version> <commit>` |
| CLI | `zero`, unchanged |
| Bundle identifier | `io.github.flexdinesh.zero.desktop`, unchanged |

The app has no PATH launcher: bare `zero [path]` opens it. `zero-app` and
`zero-desktop` are invalid CLI names.

The daemon keeps one binary and `zero daemon run`, as `ollama serve` does, and
`ensure` forwards only flags that differ from their defaults, so it shows as
`zero daemon run`. A second `zerod` name was rejected: it needs a hard link or
copy in every install and bundle for Activity Monitor to show it.

Internal names stay: `apps/desktop`, `window.zeroDesktop`, `ZERO_DESKTOP_*`
environment variables, `/__zero-desktop/crashed`, the `desktop` tasks and
validation group. The `zero-app://` page scheme is unrelated to the binary.

## Migration

Installers retire the owned `zero-desktop` app, launcher, desktop entry, and
icon after installing Zero. On Linux they move WebKit's state from
`zero-desktop/` (all but `app/`) to `zero-app/` when the new directory holds no
state yet. They move `appearance.json` to the new user data directory when it
is absent there. The unchanged bundle identifier keeps macOS WebKit storage,
notification permission, and the `zero://` handler.

## Consequences

Main's installer requires `zero-app_*` assets and fails clearly, before
changing anything, until a release publishes them: publish one promptly after
merge. Releases already published keep their `zero-desktop_*` names.

On a case-insensitive macOS volume, the app's user data
(`Application Support/Zero`) is the CLI's configuration directory
(`Application Support/zero`). Their file names differ (`appearance.json` beside
`roots.json` and `install.tsv`), and uninstall keeps that directory, so nothing
collides.
