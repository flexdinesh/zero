# 0193: Load in parallel, paint once when fast

- Status: Accepted
- Date: 2026-11-23
- Supersedes parts of: [0192](0192-fast-first-paint.md) (the tree waits for
  the live stream's first status or 1 s; the Explorer's own delayed
  skeleton)
- Extends: [0153](0153-links-name-their-project.md),
  [0191](0191-open-nothing-implicitly.md)

## Context

0192 painted a large folder's workspace early, but slowed every ordinary
project. The first page now ran as a chain: script, `/api/page`, the
workspace mounts, `/api/events` opens, and only after the stream's first
status (or 1 s) did `/api/tree` start. The first status waits for the watch:
a directory walk plus a watch per entry, one descriptor per file on macOS
(kqueue), so a medium repository in the desktop app on macOS sat behind a
skeleton for about a second. The server itself answered the zero repository
in 20 ms for each of page, tree, and first status.

The loading states also stuttered: the router's frame skeleton unmounted when
the workspace mounted, and the Explorer's skeleton restarted its own 150 ms
fade, so the sidebar flashed empty between them. With no project chosen, the
page drew the workspace's frame while it listed projects, then listed them
again. The project list (`/api/projects`, a repository discovery over every
root) was requested three or four times per load, once each by presence,
root management, the server's place, and the picker.

## Decision

- The tree loads beside the page. A tree store (`apps/web/src/workspace/
  tree-store.ts`) holds one read per project: the route loaders start it on a
  real navigation to a project that is not mounted (never on a hover
  preload), and the workspace takes it up when it mounts. A new project's read
  aborts the previous project's. The stream no longer gates the tree; a tree
  change still rereads it, keeping the current tree meanwhile.
- The server keeps the scan without the client waiting: an open-level
  subscription's first status that follows the tree (watching or polling)
  starts one background scan through the scan cache, so the index is kept for
  the documents opened next. Page and tree reads that run together already
  share one walk.
- Paint once when fast. On a first load or a project switch the loader waits
  for the page, then for the tree, up to 500 ms from its start
  (`firstPaintBudget`). A fast project mounts whole: no skeleton. A slow one
  mounts with the Explorer's skeleton shown at once, where the frame's rows
  were, so the loading state reads as one; a skeleton that first appears
  after the workspace mounts keeps the `--delay-progress` fade
  (`SkeletonRows` `delayed`).
- The picker paints at once. `/` without a project or `repo=` lists nothing
  before it renders: Choose a project draws its title band and heading
  immediately and shows its list's delayed loading state. Serving no folder,
  it says “No folder is open.” and offers Open folder… where the server
  manages roots, in place of the workspace's no-folder state. The first-load
  frame draws only for routes that open a workspace.
- One project list in flight: concurrent `fetchProjects` callers share one
  request; a caller's abort rejects only that caller, and the request aborts
  once every caller has left.

## Consequences

- A project opens as fast as its page and tree read in parallel; over
  `--remote`, Tailscale, or a sandbox it saves the stream's round trip.
- A slow load shows nothing for up to 500 ms, then the frame, then the
  workspace with its Explorer skeleton in place.
- Opening the workspace starts one background scan per followed project:
  about 20 ms for a repository, the folder's full scan for one that is large.
  The kept index's memory is what 0192 measured.
- The picker's reread after Stop serving can join a list request that
  started before the change; the next read is fresh.
