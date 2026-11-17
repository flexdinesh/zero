# 0154: Document tabs before content and bounded scroll anchors

- Status: Accepted
- Date: 2026-11-17
- Extends: [0048](0048-kept-review-tab.md), [0111](0111-review-pane-single-scroll-anchor.md)

## Context

Document tabs took their identity from the loaded page. A slow `/api/page`
response left the old tab selected after a file click. Large highlighted
lockfile reviews also spent most scroll geometry reads finding an anchor:
Pierre scanned buffered rows from the beginning and reread the scroller's
rectangle for each row.

## Decision

- Within the current project, the pending route opens and selects its document
  tab immediately, including snapshots and walkthrough preview tabs. The pane
  is busy and shows “Loading file…” after 150 ms. The current project's tree
  stays available, but old file content and capabilities never appear under
  the new tab. A failed request stays in its destination tab with Retry.
- The router still owns requests, cancellation, and accepted responses. Closing
  a loading tab or choosing another file supersedes its navigation. Switching
  projects waits for the new project's page before replacing the workspace.
- Keep Pierre's scroll anchor as the review's only anchor. Its row search is
  a binary search within each vertically ordered content column; Split's
  columns are searched separately, in their existing order. Measure the
  scroller's top once per anchor pass. Wrapping and annotations retain their
  measured geometry; overscan, highlighting, and review features stay intact.
- Extend the existing pinned Pierre patch. The large-lockfile browser scenario
  records frame intervals, geometry reads, inserted nodes, and row counts for
  both layouts with wrapping on and off. Correctness gates use bounded work
  and destination rendering, rather than machine-dependent frame deadlines.

## Consequences

The first click is visible before the server responds. Existing review state
stays mounted behind the loading document. Anchor geometry work grows with
the logarithm of buffered rows instead of their count. Dependency upgrades
must preserve these semantics or make the patch unnecessary.

Linux Playwright WebKit is useful desktop coverage, but does not establish
macOS trackpad performance.
