# 0192: Paint first, read the tree apart, keep followed scans

- Status: Accepted
- Date: 2026-11-23
- Extends: [0050](0050-live-updates.md), [0080](0080-application-layer-contracts-and-transports.md),
  [0191](0191-open-nothing-implicitly.md)

## Context

A large folder showed nothing until it had been scanned, three times over:

- The server embedded the routed page in the HTML shell, so the shell waited
  on a full scan before the browser could load a script.
- The router's loaders block its first render, so the page stayed blank
  until `/api/page` answered.
- `/api/page` scanned the project and built its whole tree on every read,
  for the tree and the document alike.

The home folder (491,878 files at `--depth 5`, polling past the watch limit)
took 3.4 s and 112 MB for the shell of a deep link, then 2.6 s and 112 MB for
every file opened after it.

## Decision

- The shell embeds nothing. Every page and tree comes over the API.
- `/api/tree?project=` (`contract.TreeData`: tree, file count, empty, error
  and code, warnings) is the file tree. `PageData` loses its tree fields;
  `/api/page` reads the folder's state and the document only. Without a
  working-tree path it scans nothing. A snapshot (`at=`) scans nothing.
- The workspace paints before any data:
  - Until the first route has loaded, the router's `InnerWrap` draws the
    workspace's frame (`WorkspaceSkeleton`): title band, activity bar,
    sidebar of skeleton rows, busy document pane, no controls. It fades in
    after `--delay-progress`, so a quick load never flashes it.
  - The Explorer shows `SkeletonRows` (a UI primitive: static bars, no
    shimmer, `role="status"`) until its tree arrives. Quick Open says
    “Loading files…”. The status bar's file count waits for the tree.
  - The tree loads when the project's live stream reports its first status,
    or after 1 s, so its scan is the one live updates keep. A tree change
    rereads the tree, not the page.
- Scans are kept while live updates follow the project (`internal/app`
  `scanCache`): `watch.Hub.Generation(root)` reports a counter that moves
  with every tree change, overflow, and poll, only while the project is
  followed at the open level and not off. A kept index is reused while its
  generation stands; concurrent reads share one scan; a scan that raced a
  change is not kept; at most 4 projects, least recently used first.
  Unfollowed projects scan on every read, as before.
- Selection is the client's: `TreeNode.open` and `selected` stay in the
  contract but the server always sends false. The Explorer opens the folders
  of the selected file itself.
- Remembered tabs restore once the page loads, not the tree: restoring
  navigates, which would close a dialog opened meanwhile. Documents restored
  before the tree are kept, and those whose files are gone are dropped when
  it loads; the active one stays to say so.

## Consequences

- The shell of any link answers in under a millisecond (home folder: 0.6 ms,
  1.7 KB). The first document still waits for the scan (2.2 s), behind the
  painted frame; later documents read in about a millisecond (5 KB each).
  The tree (112 MB) is read once per change instead of per document.
- Server RSS on the home folder, live stream open, measured 996 MB before
  and 848 MB after.
- The workspace mounts once its first page loads, not with the HTML: keys
  pressed before then reach the frame, not the app. Browser tests wait for
  the workspace before pressing shortcuts. The Explorer remounts once when
  its tree arrives, so a click on its header in that frame is lost.
- Tests that injected the embedded page (bundle and preview profiling)
  serve the built shell as is.
