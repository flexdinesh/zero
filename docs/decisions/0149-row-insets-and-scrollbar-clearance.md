# 0149: Row insets and scrollbar clearance

- Status: Accepted
- Date: 2026-11-15
- Supersedes: [0140](0140-overlay-scrollbars.md)'s consequence that a visible lane covers the last 10px of its area's content, for rows' trailing content
- Extends: [0033](0033-design-tokens-and-ui-primitives.md)

## Context

Overlay scrollbars (0140) draw a 10px lane over a scroll area's edge. List
rows ended their content 8px from that edge (`--space-2`), so a row's
trailing content (a commit's diff glyph, a change's status letter, stats,
row actions) sat inside the lane: the slim thumb touched it and the hovered
thumb covered it. Every `ListRow` list had it; Pierre's trees already kept
their status letters clear. Features also set rows' sideways padding
themselves (`0 var(--space-2) 0 var(--space-5)` and similar), so a fix in
one list would not reach the next. VS Code keeps trailing decorations clear
of its overlay scrollbar and lets row fills run under it.

## Decision

- `ListRow` and `ListButton` own their sideways insets. Their `indent` prop
  (`RowIndent`) names why content starts where it does, each a token:
  `flush` (`--row-indent-flush`, 8px, the default), `toggle` (the row leads
  with its own chevron, `--row-indent-toggle`, 4px), `nested` (under a pane
  or file header, past its chevron, `--row-indent-nested`, 24px), and
  `match` (a search match under its file, `--row-indent-match`, 40px).
- Every row ends at `--row-inset-end`, the lane plus 4px
  (`calc(var(--scrollbar-size) + var(--space-1))`), so trailing content
  never sits under a scrollbar and follows the lane if it changes.
- Features choose an `indent`; they set no sideways padding on rows. Rows
  that carry two lines set `padding-block` only. Content beside rows, such
  as a commit's details and the project picker's floating actions, places
  itself with the same tokens.
- Walkthrough rows and steps take `flush`; their 12px one-off indent is gone.
- Row fills, selection, and focus marks still run to the edge, under the
  lane, as in VS Code. Content never shifts; nothing else in 0140 changes.

## Consequences

- Trailing glyphs keep at least 4px from the hovered thumb in every list.
- Rows are 6px narrower for text; subjects truncate slightly sooner.
- The project picker's actions size from `--icon-button-min`, so their
  offsets need no narrow-screen overrides.
- No lint enforces the rule; the `indent` API, the primitive gallery,
  DESIGN.md, and this record carry it.
