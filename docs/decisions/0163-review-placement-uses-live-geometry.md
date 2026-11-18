# 0163: Review placement uses live geometry

- Status: Accepted
- Date: 2026-11-18
- Extends: [0034](0034-diff-anchor-reveal-and-hunk-navigation.md), [0135](0135-walkthrough-narration-panel-and-one-way-review-scroll.md), [0140](0140-overlay-scrollbars.md)

## Context

WebKit validation exposed missing diff rows, reveal targets outside the pane,
and a fold click whose pointerup landed away from its pointerdown target.
These failures did not justify longer pin deadlines or removing virtualization.

Pierre projects a file's DOM rectangle into content coordinates. Its cached
scroll offset can trail a native or imperative scroll until the queued scroll
event arrives. Combining that cache with a current rectangle changes the
reported content position of a stationary file. A browser regression reproduces
an 80-pixel error after an 80-pixel scroll in one JavaScript task.

## Decision

- The existing Pierre patch reads the DOM-relative rectangle first, then the
  pane's physical scroll offset, to calculate content placement. A rectangle
  read can flush layout and clamp scrolling, so its physical offset is read
  afterward. Cached and clamped logical positions still drive virtual windows.
- Timed reveal settlement places its target from current geometry and refreshes
  the virtual window once before teardown cancels queued resize/render work.
  Keep the 300 ms quiet period and three-second limit from 0135.
- A fold-button pointerdown releases the old reveal before the header can move
  during the click. Keyboard folding already releases through keydown. Line
  selection and Viewed presses retain their existing behavior.
- Test content-position invariance before a queued scroll event, and retain
  browser assertions for visible rows, keyboard stepping, folds and released
  native scrolling. Do not assert render counts or increase interaction waits.

## Consequences

Placement reads one physical scroll offset after an existing rectangle read;
it adds no rectangle reads. Workers, resident renderers, bounded caches and
virtualization remain. The coordinate regression proves the contract defect;
it does not alone establish the cause of every earlier blank-row failure.
