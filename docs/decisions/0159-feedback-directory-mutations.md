# 0159: Serialize feedback directory mutations

- Status: Accepted
- Date: 2026-11-18
- Amends: [0120](0120-review-feedback-threads.md)

## Context

`Ensure` selects a branch's existing feedback by scanning the repository
directory while holding its repository lock. Updates previously held only the
feedback ID's lock. Their atomic file replacements could change directory
entries during that scan, allowing it to miss the branch and create a second
feedback ID. The concurrent-writer regression reproduced split IDs and threads.
Diagnostic scans found the existing file immediately after the lookup missed
it, without a read or decode error.

Directory enumeration is not a snapshot when entries change during the scan;
see the [POSIX readdir contract](https://pubs.opengroup.org/onlinepubs/9799919799/functions/readdir.html).

## Decision

- Every feedback mutation holds the repository lock. Updates and deletions
  acquire it before the existing per-ID lock, matching creation and eviction.
- Keep the JSON format, stable branch IDs, atomic replacement, per-ID locking,
  and best-effort cached listing unchanged.

## Consequences

Branch selection during creation sees a stable directory across cooperating
writers. Writes to different feedback IDs in one repository now serialize;
different repositories remain independent. No migration or transport change is
needed. Lock contention and all 16 threads surviving concurrent creation are
covered by regressions.
