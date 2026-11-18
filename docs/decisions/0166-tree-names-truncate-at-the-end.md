# 0166: Tree names truncate at the end

- Status: Accepted
- Date: 2026-11-18
- Amends: [0035](0035-compare-list-and-review-tab.md) (Files tree rows)

## Context

Pierre's trees (`@pierre/trees` 1.0.0-beta.6) render every row name through
`MiddleTruncate`, split at the extension, and every segment of a compact
folder chain through its own `Truncate`. Each half is a grid holding the
text twice (a visible copy and a hidden overflow copy that wraps to detect
overflow) and draws its own "…" marker. Names came out as
`architecture……stro`, `comp……ents`, and `blog-demo…/mcp-u…`: two markers
in one name, markers on names that nearly fit, one marker per folder segment.
The Explorer and the Source Control Files tree both showed it; DESIGN.md
documented "truncate in the middle".

## Decision

- A name reads whole when it fits, else truncates once at the end with "…",
  as Zed does. Both trees.
- The Pierre patch renders each row name as plain text, and a compact folder
  chain's segments as plain text in their `data-item-flattened-subitem` spans
  (click and drag targets, hover underline kept), joined by a tight `/`.
- `lib/tree-css.ts` keeps the content section on one line
  (`white-space: nowrap`; Pierre already clips it with
  `text-overflow: ellipsis`) and lays the chain out inline, so one ellipsis
  ends the whole chain.
- No tooltip: the row's accessible name stays the full name or chain.

## Consequences

- A truncated name can hide its extension; the file icon still shows the type.
- One text node per name instead of four, with no per-row overflow grids.
- The patch depends on `FileTreeView.js` internals; a Pierre bump re-ports it.
