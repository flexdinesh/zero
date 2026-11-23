# 0194: Broad folders are not loaded by default

- Status: Accepted
- Date: 2026-11-23
- Extends: [0066](0066-lease-levels-and-desktop-events.md),
  [0146](0146-in-app-open-folder-and-stop-serving.md),
  [0191](0191-open-nothing-implicitly.md),
  [0192](0192-fast-first-paint.md)

## Context

Before 0191, bare `zero` served `.`, and the daemon saved it: run from the
home folder, home became a saved root for good. A project inside it then
opened inside home (`RootSet.Cover`), so its own tree stayed small, but every
project list discovered repositories across all of home (`--scan-depth` 10:
1.65 s cold, 0.3 to 0.75 s warm), and opening home itself scanned 491,878
files into a 114 MB tree. Home is not the only such folder: the filesystem
root, the folders that hold homes, mount points, and system folders are as
broad and as rarely meant.

## Decision

- A broad folder is, exactly (never a folder inside it, symlinks resolved on
  both sides): `/`, the user's home and its `Library`, `/home`, `/Users`,
  `/root`, `/Volumes`, `/mnt`, `/media`, `/run/media`, `/usr`, `/opt`,
  `/var`, `/etc`, `/System`, `/Library`, `/Applications`
  (`projects.Broad`).
- Never saved: opening a broad folder (the CLI, Open folder…) serves it for
  the daemon's lifetime but never writes it to `roots.json`. Saved roots it
  replaced stay saved, so a restart serves them again.
- Not restored: at daemon start a saved broad root is dropped from
  `roots.json` with a log line, as missing roots are.
- Shallow discovery: repositories inside a broad root are discovered one
  level deep, unless the user set `--scan-depth` (the daemon spawn forwards
  the flag whenever it was given, so the daemon treats it as explicit).
  Other roots keep `--scan-depth`.
- Asked before scanning: `PageData.broad` marks a broad project folder.
  `/api/tree` answers it without a scan (`unscanned`) unless asked
  (`scan=1`). The Explorer then says “<folder> holds too many files to scan
  by default.” with Scan files and Open Project…; Quick Open and Search show
  the same prompt. Scan files is remembered per project in this browser's
  memory. Until then the project's live stream holds `lease=watched` (git
  state only), so the server never walks the folder; afterwards it holds
  `open`, and the stream's first status warms its scan (0193).
- A link to a file inside a broad folder still reads it: the document was
  asked for.

## Consequences

- An old saved home root stops costing every project list a walk of home
  the next time the daemon starts.
- Someone who serves `/Volumes` or `~` on purpose still can, but it is not
  saved and its files wait for Scan files.
- A daemon already running without an explicit `--scan-depth` keeps
  discovering broad roots one level deep when a later `zero` passes the
  flag at its default value; `zero daemon stop` applies it.
- Lazy directory reads for large trees remain a separate decision.
