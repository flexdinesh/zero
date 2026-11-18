# 0161: Resize previews belong to their layout

- Status: Accepted
- Date: 2026-11-18
- Extends: [0040](0040-source-control-panes-and-review-files-rail.md), [0156](0156-feedback-badge-and-sidebar-width.md), [0160](0160-feature-ui-state-ownership.md)

## Context

Source Control sashes measured their container and published weights for every
pointer move. The review Files rail read the root font size and published its
width on each move. Each publication rendered layout subscribers and persisted
the whole Source Control preference. The sidebar already scheduled its narrow
updates by frame and saved only when the interaction completed.

## Decision

- Keep active drag geometry in the layout that applies it. Cache measurements
  at pointer down, calculate moves without layout reads, and apply visual and
  accessible-value changes in one animation frame. Commit shared preferences
  only when the drag finishes. React retains the content's existing lifetime.
- Keep the pane weight arithmetic, rail bounds in rem, sidebar bounds in pixels,
  arrow-key steps, double-click reset, and responsive layout. Keyboard actions
  commit immediately; resize keys do nothing during an active pointer drag.
- Finish on pointer up, cancellation, lost capture, blur, hiding, or unmount.
  Flush the latest valid value, save a changed preference once, cancel the
  pending frame, and release capture. Repeated termination is harmless.
- A viewport, font, container, or pane-topology change finishes the drag using
  its cached geometry, then the new layout constrains display. A temporarily
  smaller viewport still preserves the sidebar's preferred width.
- Source Control preference actions own persistence, outside React updater
  functions and effects. A drag commits only its geometry into the latest
  committed preference, retaining other choices made during the interaction.
  Storage remains optional and keeps its existing format.

## Consequences

Actual width and height changes still require layout and paint. Drag previews
avoid shared React publications and repeated storage work. Effects manage only
external synchronization and cleanup. Production browser traces and a separate
React profiling build establish measured effects; source inspection does not
establish a speedup. Diff virtualization, workers, and cache policies remain.
