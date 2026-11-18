# 0171: Review re-measure survives cache reads

- Status: Accepted
- Date: 2026-11-19
- Extends: [0157](0157-resident-review-diffs.md), [0163](0163-review-placement-uses-live-geometry.md)

## Context

A working-tree review revealing README.md sometimes left README's
expanded diff blank, while files above and below it showed their rows.
Logging the virtualizer during the failure showed that README's cached
top was 664 px while its live position was 5132 px. The window pass
rendered README as out of view with the cached top. A later height
reconcile corrected that top, but nothing queued another pass.

`markDOMDirty` marks the scroll, height and scroll-height caches stale.
A render pass treats stale height caches as a signal to re-measure every
file's top. The size getters clear those flags whenever they refresh
their caches. Two reads consumed the signal before any pass:

- a newly connected diff checks its visibility in its setup render, and
  that check clamps against the scroll height;
- a reveal pin's resize observer scrolls through `Virtualizer.scrollTo`,
  which clamps the same way.

When a diff mounted above the pinned file, both reads happened before the
next pass, so the pass kept every cached top.

Measured in Chromium with four workers, 15 runs per variant:

| Variant | Before | After |
| --- | --- | --- |
| Natural flow | 3 of 15 failed | 0 of 15 failed |
| large.txt's diff held until README showed | 10 of 15 failed | 0 of 15 failed |

All 13 failures before the fix showed the same stale top.

## Decision

- The existing Pierre patch adds a re-measure flag that `markDOMDirty`
  and `cleanUp` set and only `computeRenderRangeAndEmit` clears. A pass
  with the flag set re-measures every file, just as one with stale height
  caches does. Cache reads between passes no longer cancel it.
- The pin, the window math, 0163's placement reads, workers, resident
  renderers and bounded caches are unchanged.
- A browser regression grows the content above README, then scrolls
  through the virtualizer from a later resize observer, as the pin does.
  It requires README's rows in the viewport. It failed 5 of 5 runs
  without the patch change.

## Consequences

Every `markDOMDirty` now yields the full pass Pierre already intended,
even when a clamp read the sizes first. That pass reads each connected
file's rectangle once, as such passes already did. Transient blank frames
can still appear between two passes; they no longer persist.

Under four-times CPU throttling, the reveal pin can settle after its
300 ms quiet period before a slow diff mounts above the target and pushes
it off screen (0135). That is pin timing, not missing rows, and it stays
unchanged.
