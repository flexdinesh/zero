# 0158: Schedule preview highlighting and diagram rendering

- Status: Accepted
- Date: 2026-11-18
- Amends: [0029](0029-highlights-syntax-highlighting.md), [0025](0025-ondine-mermaid.md)

## Context

Markdown preview loaded Highlights even without eligible fences and tokenized
every fence synchronously in one callback. Mermaid compiled during React render
for every observed width. Many small fences and continuous resizing could collect
otherwise modest work into a main-thread task.

## Decision

- Highlight Markdown fences in the existing shared highlight worker, including
  small fences. Source and Format retain their existing main-thread threshold.
- Start fence work within 300px of its scroll viewport. Distant fences retain
  complete plain text and working copy controls. Unlabeled and explicit plain
  fences never load Highlights; the worker checks other declared languages.
- Each preview owns a visible-first queue with one active fence. Keep plain text
  in stable line chunks with layout/style containment, then replace each chunk's
  contents in bounded animation-frame batches. Label controls subscribe to their
  own fence's completion.
  Chunks preserve the preformatted line-box typography around inline code text,
  including later font changes. Only visual newlines create chunk boundaries;
  bare carriage returns stay within the same visual row. An indivisible visual
  row may exceed the chunk budget. Active native selections defer replacement.
- Content replacement and unmount cancel queued work and ignore obsolete worker
  replies. Closing the final workspace tab still releases the shared worker.
  No application-wide fence-result cache is added.
- Compile Mermaid outside React render in separate browser tasks. The first
  positive width renders immediately; subsequent widths settle for 150ms before
  recompilation. Existing same-source SVG scales while width moves.
- Ignore obsolete jobs and results. Expanded diagrams retain separate natural
  dimensions, pan and zoom. Existing sanitization, diagram-link unwrapping,
  diagnostics, reload recovery and CSS theme colors remain.

## Consequences

Offscreen fences stay plain until approached. Highlighting can arrive over
several frames. Copy always uses the complete original fence source. A single
Mermaid compilation remains synchronous; scheduling cannot interrupt it.
Production browser traces and separate profiling-enabled React measurements,
rather than source inspection, establish the measured effect.

A growing inline highlighted prefix beside a shrinking plain-text tail caused
the whole large code block to lay out on every update. Stable chunks isolate
those layout changes while retaining all source text for selection and Find.
