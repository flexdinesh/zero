# 0155: Review file activation expands its diff

- Status: Accepted
- Date: 2026-11-17
- Amends: [0137](0137-review-selection-is-the-chosen-file.md)

## Context

Choosing a collapsed file in Files or Uncommitted revealed only its header.
Choosing the selected file again in a tree did nothing because its selection
had not changed.

## Decision

- Activating a file in Files or Uncommitted expands and reveals its diff,
  including repeated activation of the selected file. Keyboard activation
  follows the same rule; click and Space keep list focus, Enter and
  double-click move focus to the review.
- Opening a Viewed file keeps its Viewed mark. Other files keep their
  collapse state. Manual collapse remains until another reveal request.
- Refreshing a review preserves its viewport and never activates a file.
  Cached diffs remain rendered while their replacement loads.

## Consequences

File activation is distinct from synchronizing tree selection. Review
fragments, contracts, and server APIs are unchanged.
