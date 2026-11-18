# 0168: Sidebar and picker visibility

- Status: Accepted
- Date: 2026-11-18
- Extends: [0020](0020-activity-bar-and-search-view.md), [0145](0145-quick-open-file-popup.md), [0160](0160-feature-ui-state-ownership.md), [0162](0162-coherent-background-polls.md)

## Context

The sidebar hid mounted views with CSS. Workspace and background updates
still supplied presentation data to those views. Closed command and theme
pickers also matched and rendered options and tried to scroll them.

## Decision

- Create sidebar bodies on first reveal. A visited body stays mounted and
  receives new presentation inputs when visible. The native drawer's open
  state, the desktop sidebar toggle, and presentation mode determine visibility.
- Keep project data, global shortcuts, badges, and route-driven selection
  outside the presentation boundary. Run focus requests, list age ticks,
  and seen markers when their targets are visible. Refresh a stale Search
  corpus on reveal and keep result navigation available while Search is hidden.
- Retain Pierre models with their mounted views. Explorer snapshots expansion
  before replacing its model for a breakpoint or font-size change. Pierre's
  React hook cleans up the model when effects disconnect.
- Keep the command palette, theme picker, and Quick Open shells and registrations
  alive. Build their option bodies while open and scroll using an active key.
  Keep Quick Open's file index with its controller for reuse.

## Consequences

First reveal bears the cost of constructing a sidebar body. Later switches
retain the view's scroll, expansion, focus cursor, and drafts. Hidden project
controllers continue to receive changes and update badges. Production browser
traces and a separate diagnostic React build measure those tradeoffs.
