# 0157: Resident review diffs

- Status: Accepted
- Date: 2026-11-17
- Amends: [0035](0035-compare-list-and-review-tab.md), [0155](0155-review-file-activation-expands-diffs.md)
- Supersedes: [0034](0034-diff-anchor-reveal-and-hunk-navigation.md)'s patched `onInstance` callback

## Context

Leaving the viewport destroyed each diff renderer. Re-entering removed its
measured placeholder before an uncached response arrived, collapsing the
section and moving the viewport. Focus refresh also reparsed unchanged
content, causing Pierre to discard measured rows and expanded gaps.

## Decision

- Keep continuous reviews. Follow Pierre's supported mixed-content pattern:
  one `Virtualizer` with the existing main scroller and explicit content
  wrapper, and React `FileDiff` children. CodeView's file/diff-only items do
  not represent our image, loading, error, and binary bodies without another
  layout adapter.
- Fetch near the viewport. Keep visited renderers mounted and let Pierre
  virtualize their rows. A store owned by the mounted review retains its
  responses; sections do not keep separate response copies.
- Remove the 30-file eviction boundary and application height placeholders.
  Evicting a renderer loses Pierre's wrapped-row measurements and expanded
  gaps even if its data can be fetched again. Retain visited data for the
  kept review's lifetime instead. Closing or replacing it releases the store,
  following 0048's existing one-kept-review policy.
- Reuse rendered metadata when source bytes, names, language, and structured
  line diff are equal. Continue fetching on refresh to detect actual edits.
  Read counters and file paths alone are not content identities.
- Use public `options.onPostRender` to access the virtualized instance for
  row positions and gap expansion. Remove the React `onInstance` patch.
  Keep 0154's bounded anchor search patch and 0111's single scroll owner.

## Consequences

Normal scrolling and unchanged refreshes preserve Pierre's measurements and
expanded gaps without another scroll correction loop. Memory grows with the
files visited in the kept review, rather than a fixed 30-entry budget. Rows
remain virtualized and unread files remain lazy. Browser regressions traverse
more than 30 files, including a wrapped file, and hold refresh responses to
check layout stability. Native focus and memory checks cover returning to the
app and releasing resources.

Reference: [Pierre virtualization guidance](https://diffs.com/docs#virtualization).
