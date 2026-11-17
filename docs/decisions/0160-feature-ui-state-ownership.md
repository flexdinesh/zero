# 0160: Feature UI state ownership

- Status: Accepted
- Date: 2026-11-18
- Extends: [0020](0020-activity-bar-and-search-view.md), [0040](0040-source-control-panes-and-review-files-rail.md), [0129](0129-base-row-picker-inline-commit-filter-and-lanes.md)

## Context

App owned the search session, Source Control layout, commit filter draft, and
commit selection. Their interaction updates rendered the workspace, including
an unrelated Source document. Search's worker debounce limited matching work,
but did not limit those parent renders.

## Decision

- A search provider owns one session per project. Search consumes its session;
  the empty-workspace leaf consumes its summary. App registers only open and
  stale-corpus commands for global actions and live updates.
- Source Control provides independent query, pane, rail, filter, and command
  subscriptions. App reads range, base, and the applied filter for its existing
  shared data hooks. Layout changes and filter drafts do not update that query
  subscription. No server responses are copied into these providers.
- Commit selection belongs to the mounted Source Control view and still follows
  commit/range routes. The rail owns its mobile sheet visibility. The diff
  toolbar composes the rail's Files control without subscribing to its state.
- Both owners use the router's project lifetime. Sidebar hiding and document
  navigation retain transient state; a project change resets it. The existing
  Source Control storage format, global preferences, and per-project base choices
  remain compatible. The kept review's Activity boundary is preserved.

## Consequences

Context values retain identity across changes to independent state slices.
Commands stay current without requiring a workspace subscription to drafts.
Meaningful query and shared-data updates still render their existing consumers.
Pointer event scheduling, polling equality, and Source row rendering remain
separate concerns.

The extended interaction measurement uses normal embedded production assets for
browser traces and a separate diagnostic React profiling build for component
timings. The diagnostic configuration is never used by release builds.
