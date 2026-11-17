# 0156: Open feedback badge and window-relative sidebar width

- Status: Accepted
- Date: 2026-11-17
- Amends: [0120](0120-review-feedback-threads.md), [0102](0102-sharp-slate-panes.md)

## Context

The Feedback activity counted only unseen agent replies, so open feedback
could have no badge. The sidebar stopped at 480 px even in a wide window.

## Decision

- The Feedback activity counts open threads for its selected branch, across
  all files and filters. Reading a thread leaves the count unchanged; closing
  or deleting it reduces the count. A zero count hides the badge and counts over 99
  display as `99+`. Unread replies retain their own indicators in Feedback.
- The desktop navigation pane, including its activity rail, can resize to
  half the window width. The sidebar keeps its 208 px minimum, 288 px default,
  keyboard resizing and double-click reset. The maximum follows the actual
  layout and activity rail dimensions, including font-size changes.
- A smaller window clamps the displayed width without replacing the saved
  preference. Enlarging the window restores that preference. Only explicit
  resize and reset actions save a new width. Mobile retains its drawer.

## Consequences

The badge represents outstanding work rather than unread messages. Wide
sidebars leave at least half the desktop window for documents. The separator's
accessible values follow its current bounds. Contracts and server APIs stay
unchanged.
