# 0161: Coherent background polls and navigation ownership

- Status: Accepted
- Date: 2026-11-18
- Extends: [0018](0018-lsp-only-navigation.md), [0047](0047-walkthroughs.md), [0160](0160-feature-ui-state-ownership.md)

## Context

Walkthrough list polls published loading and fresh arrays every five seconds.
Language server status polls changed a scheduling token and then replaced the
status every three seconds. Both updates reached App and its document tree,
including when the server answered with unchanged data.

## Decision

- Walkthrough summaries retain their ordered result identity when id, title,
  step count and update time match. Initial and manual reads expose loading;
  background reads retain displayed data without a loading transition. Errors
  remain visible, including with a cached empty list, and successful reads clear
  errors. The existing walkthrough session remains the state owner. Relative-age
  labels keep their five-second visible-page cadence through a clock local to
  the visible populated list; unchanged response identity does not freeze them.
- Navigation status polling calls the reader directly. Complete semantic
  equality retains unchanged status identity, including installation guidance,
  capabilities, memory and failure details. Request cancellation and identity
  fence superseded responses.
- One navigation provider below App owns status reads, navigation requests and
  the result dialog. Source consumes stable navigation commands and eligibility;
  the status leaf consumes detailed server information. App registers palette
  commands and retains routing and caret seeding without subscribing to polls.
- Keep five-second walkthrough polling, its focus and visibility refresh, and
  three-second navigation polling while a server starts or runs. Hidden
  navigation ticks remain skipped. Status reads never start or keep servers alive.

## Consequences

Changed walkthroughs still update their list, badges and active version. Server
transitions, memory, errors and recovery still update the status panel; command
eligibility changes reach Source. Timers are external synchronization, not
rendered state. Existing project lifetimes, focus, drafts, live updates, workers,
review virtualization and caches retain their contracts.

Production browser traces and a separate diagnostic React profiling build
measure the idle polling scenario. No profiling instrumentation ships with the
product, and measured results are documented separately from these ownership
rules.
