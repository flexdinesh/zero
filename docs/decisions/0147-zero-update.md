# 0147: `zero update` and the update notice

- Status: Accepted
- Date: 2026-11-15
- Extends: [0073](0073-install-scripts.md), [0079](0079-releases-edge-prerelease-and-install-scripts.md),
  [0118](0118-zero-name-and-collision-safe-installs.md), [0136](0136-installs-stop-the-running-daemon.md)
- Revises: [0073](0073-install-scripts.md) (no checksum verification)

## Context

Updating meant finding and rerunning the install command. Nothing told a user a
release existed. `install.sh` does more than place a binary: it installs the
desktop app, records owned paths with content fingerprints in `install.tsv`,
and stops the running daemon. A binary that replaced itself would leave a
fingerprint `install.sh` and `uninstall.sh` no longer recognize, and would not
update the desktop app, which bundles its own `zero`. Silently installing in the
background would replace binaries under a running daemon and app, and
`install.sh` refuses while the app runs. Releases already publish
`checksums.txt`; `install.sh` did not read it.

## Decision

- `zero update [--check] [--cli-only]` finds out how the running binary was
  installed (`internal/selfupdate`, `Detect`):
  - `script`: `install.tsv` (header `zero-install-v1`, parsed as data with the
    scripts' rules) has a `cli` row whose path resolves to the running binary
    and whose fingerprint matches it. `zero update` downloads `install.sh` from
    the latest release's tag (`raw.githubusercontent.com/.../v<X.Y.Z>/scripts/install.sh`)
    and runs it with `sh`, adding `--cli-only` when the record owns no app or
    when asked. Tags never move, so a broken `main` cannot break updates; script
    fixes reach updates with the next release. `install.sh` keeps every rule:
    it stops before downloading while the app runs, keeps the remembered name,
    and stops the daemon. A failure names `--cli-only`.
  - `dev` (any version that is not `X.Y.Z`): prints the `install-dev.sh --ref`
    command and the stable command. A development version's label is lossy, so
    the ref is not guessed.
  - `bundled`: the copy inside the recorded app; points to the `zero` on PATH.
  - `managed`: `version.InstallMethod` is stamped at build (`-X`); prints
    "update it with <stamp>". No package manager ships zero yet; this is the seam
    for one.
  - `goinstall`: no stamped version but a module version in build info; `go
    install` stays unsupported (0079), so it prints the `install.sh` command.
  - `unknown`: anything else, including a modified binary or malformed record;
    prints the `install.sh` command.
  Commands use the invoked name (0118). Any method but `script` exits non-zero
  without `--check`.
- The latest release comes from the redirect of
  `github.com/flexdinesh/zero/releases/latest`, as in the scripts; only `vX.Y.Z`
  tags count. Releases compare numerically.
- Update notice: bare `zero`, `browser`, `connect`, `attach`, `remote`,
  `walkthrough`, and `feedback` (and their subcommands) print one line on stderr
  when the cache (`UserCacheDir/zero/update-check.json`) knows a newer release.
  They never wait on the network: a cache older than 24 hours records the
  attempt and starts a detached `zero update --refresh` (3 s timeout). Never
  shown when stderr is not a terminal, with `CI` or `ZERO_NO_UPDATE_CHECK` set,
  for development or bundled builds, or for `daemon`, `serve-stdio`,
  `connection`, and `update`. It reports; it never installs.
- `install.sh` verifies every downloaded asset against the release's
  `checksums.txt` before unpacking: exactly one well-formed matching line per
  asset, or it stops without changing anything.

## Consequences

- Updates need `sh` and curl or wget, which installing already needs.
- A release published between the check and the run installs that newer one.
- `zero update` is a subcommand, so `zero update` never opens a folder named
  `update`; `zero ./update` does, as with `browser` and `connect`.
- At most one short-lived background process a day.
- Shipping through Homebrew or `go install` needs a decision superseding 0079;
  `go install` also needs the embedded web app, which no tag carries.
