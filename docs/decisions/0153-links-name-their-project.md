# 0153: Links name their project; a link without one asks

- Status: Accepted
- Date: 2026-11-15
- Supersedes parts of: [0052](0052-welcome-tab-and-contextual-empty-state.md)
  (Landing), [0007](0007-projects-and-project-picker.md) (the first root as
  the landing project)
- Extends: [0098](0098-remote-connections.md) (the connection string),
  [0127](0127-sandbox-attach-and-stdio-transport.md)

## Context

`zero . --remote` in `~/workspace/arto`, on a daemon that already served two
other folders, printed a string that opened `stage-website` on the other
computer. The string named only the server, and `zero://<id>/` named no
project, so the window landed on the project remembered for that connection,
else the first served root. A local `zero .` puts its project in the link
(`?project=`); the remote, browser, and attach commands threw theirs away.
Strings from `zero remote status` and `rotate` cannot know a project at all,
and opening the last one there hid the choice from the person.

## Decision

### Links name their project

- The connection string may carry the project after the credential:
  `<host>[,<host>...]:<port>/<credential>[<absolute path>]`, each path segment
  percent-escaped (`connection.Invite`). Strings without a path still parse.
  `Invite.Shell` always single-quotes a string with a path.
- `zero <path> --remote` prints its project in the string, the `--web` link
  (`&project=`), and the `--tailscale` URL (`?project=`).
  `zero connect` opens `zero://<id>/?project=<path>`; `--no-open` and the
  browser fallback carry it too.
- `zero remote status` and `rotate` print the server's string without a path.
- `zero browser` prints and opens `?project=<first root>`. `zero attach`
  links carry the target's path when it is absolute; a target without one
  (the sandbox's working directory) leaves the choice to the page.

### A link without a project asks

- `/` without a project opens the only available project, and on a server
  that serves no folder keeps the workspace's “No folder is open.” state.
  Otherwise it shows **Choose a project**, in every window (local or remote, desktop or browser),
  and loads no project until one is picked:
  - a flat page on the document surface: “Choose a project” at the preview h1
    size, “Serving N folders.”, then Welcome's project list (the picker's rows,
    worktree expansion, problem notes) under a focused filter;
  - the project last opened in this session (`lastProject` under the
    `sessionKey`, while a served root holds it) carries an accent “Last
    opened” mark in place; the list keeps the server's order;
  - Enter in the filter opens the last opened project while the filter is
    empty, else the first row that opens; a filter's Enter opens its first
    match;
  - Open folder… where the server manages roots, through the picker's Browse
    (also from the desktop's File › Open Folder…);
  - a list failure shows the reason with Retry; the page holds
    `/api/presence` like the workspace.
- The landing picker of 0052 is gone: `requestLandingPick` and the
  remembered-project landing no longer exist. Stopping the current project's
  served root navigates to `/`, so it asks too.

## Consequences

- Clients without this change reject strings that carry a path (“not a zero
  connection string”); the build mismatch notice of 0148 already asks to
  update.
- Running a connect string again while its connection's window is open loads
  the string's project in that window, as a local `zero <path>` does, instead
  of only bringing it forward (0098).
- Opening the desktop app with no link, or a bookmarked `/`, asks instead of
  reopening the last project; the last one is a keystroke (Enter).
- With one available project, a folder last opened by hand within it no longer
  reopens from a link without a project.
- A sandbox root reached through a symlinked target path does not match the
  link's project, which then shows the unavailable-project state.
- The page shows no host name: `/api/projects` carries none, and the desktop
  window's label already names the connection.
