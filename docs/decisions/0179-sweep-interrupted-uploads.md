# 0179: Sweep interrupted uploads

- Status: Accepted
- Date: 2026-11-20
- Extends: [0176](0176-visual-feedback-targets.md) (attachment sweep)

## Context

0176 writes an upload into `staging/` through a temporary file
(`.attachment-*`) and a rename, and sweeps only staged `at-*.png` files past
their lifetime and attachments no feedback references: "Nothing else is
swept." A daemon killed while writing an upload leaves its temporary file,
up to 8 MiB, in `staging/` for good. Nothing lists, serves, or counts it, so
no budget notices it either.

## Decision

- The sweep 0176 runs on every upload and thread creation, under the
  repository lock, also removes `staging/.attachment-*` regular files whose
  modification time is at least the staged lifetime (1 hour) old.
- A younger temporary file may be an upload another process is still
  writing, so it stays.
- Nothing else changes: the feedback JSON's own temporary files
  (`.feedback-*`) are still not swept, and an attachment moved into
  `fb-<id>/` whose thread's JSON write failed is still swept as an
  unreferenced attachment (0176).

## Consequences

- A crashed upload costs its disk space for at most an hour past the next
  upload or thread creation in its repository.
- A failed thread write still loses its upload; the composer uploads again
  when it retries, so the retry works.
