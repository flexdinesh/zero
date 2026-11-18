# 0169: Deferred review and dialog assets

- Status: Accepted
- Date: 2026-11-19
- Extends: [0048](0048-kept-review-tab.md), [0157](0157-resident-review-diffs.md), [0168](0168-sidebar-and-picker-visibility.md)

## Context

Welcome and Source loaded the Pierre diff renderer and three optional dialogs
with the workspace. Eager review cleanup and shared presentation imports also
kept those implementations in the startup graph.

## Decision

- Load the review renderer on first use. Start compare data reads as the
  review route resolves. Keep the renderer in the existing Activity so a
  visited review retains its diffs, scroll, and selection. Call the loaded
  implementation's resource cleanup when the last review tab closes.
- Load the project picker, settings, and problem report bodies on demand.
  Their open commands and global shortcuts register with the workspace.
  A pending open keeps the original focus target and options. Project lists
  and shortcut labels use lightweight shared modules.
- Keep loading and failure feedback in the affected review pane or dialog.
  Retry once in the current page. After a repeated import failure, offer a
  user-initiated reload to recover from cached failures or retired asset URLs.
- Use native imports for these feature chunks and their JavaScript
  dependencies. Failed module preloads can survive a reload in WebKit.
  [WebKit bug 270357](https://bugs.webkit.org/show_bug.cgi?id=270357)
- Serve the chunks from the same embedded assets over HTTP and the desktop
  custom scheme.

## Consequences

Startup executes less JavaScript. First use pays the cost of loading and
evaluating the deferred code, and compare data can load in parallel.
