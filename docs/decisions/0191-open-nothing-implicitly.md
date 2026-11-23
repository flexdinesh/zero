# 0191: Open nothing implicitly

- Status: Accepted
- Date: 2026-11-23
- Supersedes parts of: [0153](0153-links-name-their-project.md) (`/` opens
  the only available project); the CLI's default path `.`
- Extends: [0068](0068-cli-opens-desktop-app-and-desktop-releases.md),
  [0098](0098-remote-connections.md),
  [0146](0146-in-app-open-folder-and-stop-serving.md)

## Context

`zero` run in the home folder served it: the CLI defaulted to `.`, and a
link without a project opened the only one there was. A home folder at the
default `--depth 5` held 491,878 files; its page was a 110 MB tree that took
3.3 s to scan before anything showed. Nobody asked to open the home folder:
they ran `zero` to get to the app. The daemon already lets the page open any
folder (0146), so the CLI does not need to guess one.

## Decision

- A path is never implied. `zero`, `--remote`, and `--tailscale` without a
  path or `--repo` add no folder: the daemon serves what it already has.
  - Bare `zero` opens `zero://local/` in the desktop app and prints
    `opened zero`.
  - `--remote` prints a string without a project; `--tailscale` a URL
    without one. The startup lists the served folders, or
    `serving:  no folder yet; open one from the app`.
- Browser mode cannot open a folder from the page, so without a path it
  serves nothing: `zero browser`, `--host` or `--port` without a path, and
  bare `zero`'s browser fallback fail with “pass a folder to serve, as in
  `zero browser .`” (in the invoked name, 0118). The fallback prints its
  notice and install hint first, without “serving in browser mode”.
- `/` without a project always shows **Choose a project** (0153's page),
  even with one available project; serving no folder keeps “No folder is
  open.”. Links with `project=` or `repo=` behave as before.

## Consequences

- `zero .` is how to open the current directory; docs say so.
- The desktop app opened from the Dock or a launcher, a bookmarked `/`, and a
  connection string without a project ask even when one project is served;
  Enter opens it.
- A large folder is scanned only when someone names it or picks it.
