# 0154: Row state paint clears the scrollbar lane

- Status: Accepted
- Date: 2026-11-17
- Supersedes: [0149](0149-row-insets-and-scrollbar-clearance.md)'s rule that row fills, selection, and focus marks run under the scrollbar lane; its content insets remain unchanged

## Context

0149 keeps trailing row content clear of the scrollbar lane but paints row
states under it. Hover, selection, and keyboard focus therefore reach the
scroll area's edge while content stops short. Shared rows need one stable
paint boundary independent of whether a scrollbar is visible.

## Decision

- All shared `ListRow` and `ListButton` hover, active, selection, and
  keyboard focus paint ends `--scrollbar-size` before the row's trailing
  edge. The inset is constant with no overflow, hidden scrollbars, and
  fine or coarse pointers.
- A noninteractive `::before` state layer behind content owns these fills
  and marks, with `pointer-events: none`. It changes paint only: full row
  width, click targets, and layout remain unchanged.
- Keep 0149's leading `indent` tokens and content insets.
  `--row-inset-end` remains
  `calc(var(--scrollbar-size) + var(--space-1))`, preserving the 4px
  clearance between trailing content and the scrollbar lane.
- Keyboard focus keeps its 1px accent outline inset 1px within the state
  layer. Commit ranges draw one continuous selection border around the
  run on the layer, with top and bottom edges only at the run's ends.
  The pending range anchor's dashed outline also moves onto the layer.
- This supersedes only 0149's fills/selection/focus-under-lane rule.
  The original content insets and 0140's scrollbar behavior remain in force.

## Consequences

- Every shared row uses the same trailing paint boundary, including rows
  outside overflowing lists and on touch devices.
- Scrollbar visibility never changes row content, truncation, click targets,
  or the state layer's geometry.
- Features put row state decoration on the shared layer so commit ranges
  and pending anchors keep the same trailing boundary as hover and focus.
