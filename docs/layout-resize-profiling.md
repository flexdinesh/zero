# Layout resize profiling

Run the unchanged [resize harness](../tests/browser/layout-resize-performance.spec.ts)
and [diagnostic configuration](../apps/web/test-fixtures/profile.config.ts) through
the public snapshot tooling on both revisions:

```sh
mise run test:browser:extended -- tests/browser/layout-resize-performance.spec.ts --production-only --workers=1
```

## Capture protocol

The harness uses the real production binary, embedded production assets and
server APIs. Each of five production repetitions exercises:

- Sidebar width and both Source Control pane sashes beside a highlighted
  10,000-line TypeScript Source document.
- The same three controls beside the extended fixture's 24,000-line working
  review included in a branch compare, positioned at `large.txt`, plus the
  review Files rail's width.
- The same three controls beside a Markdown preview containing twelve diagrams.
  All twelve diagrams compile before capture; the preview returns to its top.

Five separate repetitions use `react-dom/profiling` and diagnostic Profiler
boundaries. Only this pass substitutes the shell's scripts and styles; APIs,
workers and CSP remain real. The shipped build configuration is unchanged.
The runner's explicit `--production-only` mode serves embedded production assets
without starting the unused Vite development server. Default browser validation
continues to start Vite. Workload sizes, controls, paths, cadence and assertions
are identical between measured revisions.
The new capture is opt-in through this mode, separate from aggregate validation,
so its samples run without another test worker or validation group from this task.
Existing correctness and extended behavior coverage retains its normal runner.

Each workload and repetition gets a fresh 1440×900 browser context, closed in
`finally`. Source highlighting, rendered review rows, Source Control lists and
stats, diagram compilation, and outstanding finite API requests settle before
measurement. Event and presence streams remain open. A two-frame request check
and 400 ms warm-up allow deferred width work to finish.

Each native mouse drag takes 24 evenly spaced moves out and 24 back halfway,
with a configured 16 ms delay after each move. Horizontal excursion is 120 px
(negative for the rail); vertical excursion is 60 px. Final geometry differs
from the starting geometry, exercising persistence at release. The harness
checks that each real separator changes during the drag and retains a changed
value afterward. It checks that resizing selects no text. No exact render count
is asserted. A 400 ms tail and finite-request settlement precede the end mark.
Pointer processing and automation overhead add to the configured delay; retained
trusted pointer timestamps reveal actual cadence.

## Artifacts and analysis

The validation command prints its artifact directory. The Playwright output
contains `layout-resize-measurements.json` with 100 scenario records: ten controls
and workloads, five repetitions, two build modes. Fifty `*.trace.json` files
contain only the production intervals. Files are written directly before
attachment so the dot reporter preserves them.

For every production scenario, report the five samples and their median:

- CDP `ScriptDuration`, `LayoutDuration`, `RecalcStyleDuration`, and `TaskDuration`
  deltas, converted from seconds to milliseconds.
- Paint duration from the union of complete `Paint` intervals on each thread.
- Long-task count, total duration, and maximum duration from the browser's
  `longtask` observer.
- Complete native `InputLatency::MouseMove`, `MouseDown`, and `MouseUp` begin/end
  pairs, paired by process and async ID, including only complete flows whose
  component metadata explicitly records a frame swap. Keep unpresented, missing-start, and
  missing-end flows separate. Report pair counts and per-run latency p95; do not
  substitute pointer-handler duration for missing pointer-to-frame evidence.
- Local-storage calls grouped by key and whether the pointer is pressed or
  released. Preserve raw values and timestamps. This records attempts to write
  through `setItem`, not physical disk I/O.

For React, sum `actualDuration` separately for each boundary within each
scenario, then report the median across five runs. Retain commit counts as
observations. Ancestor boundaries include descendants, so their durations must
not be added together or called owner self time. The diagram compiler also does
work outside React render; production scripting captures that work.

Archive the baseline's run record, input manifests, raw output, source hashes,
and harness/config copies outside the worktree at
`/home/dee/.t3/task-artifacts/227`. The baseline runtime must be byte-equal to
`174c647f268f8c68688937b1ffa17e19d24f58f4`; only diagnostic and test inputs may
differ. Create the public tooling's immutable snapshot before product edits.
Candidate capture must use this same harness/config and run sequentially with
the baseline, without another validation group from this task running alongside.

## Interpretation limits

### Harness recovery

The first capture (`cea831d9`) crashed on its first Source/sidebar scenario,
before any complete sample. The host kernel recorded a 4 GiB cgroup OOM kill:
the renderer used about 2.7 GiB and an unused Vite development server about
1 GiB. This was a measurement failure, not evidence of a product speedup.

A diagnostic (`e91039ef`) ran the same 10,000-line Source and 48-move drag
with and without tracing. The untraced case passed near the memory limit;
the traced case recorded `oom_kill 1`. The production-only runner then passed
both cases (`1da16d63`), peaking at 3566 and 3481 MiB respectively, with zero
memory-limit or OOM events. The container still had 2 CPUs, 4 GiB, and no swap.
No workload, cadence, path, repetition, or assertion was reduced.

The review workload also uses a branch compare including uncommitted changes.
A working-tree-only review has no Files rail by design and cannot exercise
that separator. This correction retains the large working-tree diff.

These diagnostic passes establish that removing unused development-server
overhead permits the traced drag. They do not establish a performance result
for the resize implementation.

React profiling overhead is excluded from production timing. Browser layout and
paint remain necessary when real geometry changes. Background polling stays
enabled; an unrelated commit may occur within any interval. Five repetitions on
one container, fixture and Chromium version cannot establish a universal speedup.
Native latency describes headless Chromium frame swap, not a physical display,
desktop WebView, field INP, or every delivered pointer event. Report missing
latency pairs explicitly. Compare scripting, layout, style, paint, storage and
React observations separately rather than combining them into one speedup.

## Recorded comparison, 2026-11-18

Baseline run `9f31792601fa37c9ae27a819bbba6b7d` used production inputs
byte-equal to `174c647f268f8c68688937b1ffa17e19d24f58f4` (479 hashes
checked). Candidate run `17343aa521a7cafb095f6f8a6c700eba` used runtime
`3d0497f9eb1e93566547cf8d972054ca65f8e6b6`. Both passed with 100 scenario
records, 50 production traces, five production repetitions and five separate
React repetitions. Both reported zero memory-limit and OOM events under the
same 2-CPU, 4-GiB limit and Chromium `153.0.8010.12`.

Harness, diagnostic config and runner hashes matched between captures. All
200 scenarios delivered 48 trusted pointer moves; starting/final separator
values and paths matched. The configured 16 ms delay is not achieved event
cadence: per-run median Source/sidebar move intervals ranged 817–1415 ms in
the baseline and 837–1215 ms in the candidate. Other scenarios ranged roughly
32–88 ms and 32–90 ms respectively. The large Source/sidebar interaction is
still visibly expensive. This capture does not establish smoothness.

Values below are baseline / candidate five-run medians, in milliseconds per
instrumented scenario, including the fixed tail and settlement checks.

| Workload / control | Script | Layout | Style | Paint |
| --- | ---: | ---: | ---: | ---: |
| Source / sidebar | 2281.40 / 2942.67 | 5591.33 / 6232.58 | 27406.14 / 34603.88 | 1180.42 / 1308.70 |
| Source / Uncommitted–Commits | 387.29 / 207.01 | 226.24 / 276.55 | 11.02 / 19.24 | 706.54 / 840.97 |
| Source / Commits–Branches | 420.28 / 158.36 | 248.37 / 275.71 | 11.87 / 9.44 | 817.14 / 844.85 |
| Review / sidebar | 274.52 / 294.94 | 241.22 / 266.04 | 1710.74 / 1863.17 | 164.42 / 174.75 |
| Review / Uncommitted–Commits | 194.55 / 56.89 | 35.63 / 35.32 | 12.29 / 9.08 | 57.09 / 57.59 |
| Review / Commits–Branches | 197.83 / 18.86 | 34.00 / 36.16 | 13.26 / 9.55 | 43.68 / 47.00 |
| Review / Files rail | 359.44 / 329.37 | 289.09 / 292.41 | 59.70 / 51.92 | 209.23 / 201.96 |
| Diagrams / sidebar | 41.86 / 42.91 | 65.75 / 60.08 | 705.98 / 626.75 | 81.11 / 74.06 |
| Diagrams / Uncommitted–Commits | 204.00 / 22.32 | 24.83 / 27.08 | 11.60 / 9.59 | 50.99 / 56.49 |
| Diagrams / Commits–Branches | 201.40 / 35.73 | 25.58 / 27.58 | 12.81 / 9.66 | 39.48 / 43.46 |

Every pane and rail drag attempted 48 Source Control storage writes while
pressed in the baseline; the candidate attempted zero while pressed and one
after release. Sidebar drags attempted one write after release on both
revisions, consistent with its existing completion-owned persistence.

React owner-boundary `actualDuration` totals, separately profiled:

| Workload / control | Boundary | Baseline / candidate ms |
| --- | --- | ---: |
| Source / Uncommitted–Commits | SourceControlView | 91.9 / 5.2 |
| Source / Commits–Branches | SourceControlView | 81.5 / 2.1 |
| Review / Uncommitted–Commits | SourceControlView | 105.2 / 1.9 |
| Review / Commits–Branches | SourceControlView | 110.8 / 5.3 |
| Review / Files rail | ReviewFilesRail | 15.3 / 0.5 |
| Diagrams / Uncommitted–Commits | SourceControlView | 99.2 / 6.8 |
| Diagrams / Commits–Branches | SourceControlView | 91.4 / 1.7 |

These boundary totals include descendants. SidebarResizer has no separate
profiling boundary, so this pass cannot give its own React duration. The
SourceControlView boundary during Source/sidebar increased from 44.7 to
73.7 ms; during review/sidebar it changed from 7.2 to 7.8 ms. Unrelated
background work is retained, including existing refreshes.

Native latency requires particular care. All 2400 drag MouseMove flows in
each production capture had complete begin/end pairs. Only 17 baseline flows
and 1701 candidate flows recorded explicit frame-swap metadata. The remaining
2383 and 699 completed without frame-swap metadata; no begin/end pair was
missing. Fifty pre-drag hover flows per capture were excluded. MouseDown
frame-swap coverage was 2/50 and 18/50; MouseUp coverage was 3/50 and 0/50.
These unequal populations do not support a representative before/after
presentation-latency comparison. Acknowledgement also includes different
amounts of frame work and must not be relabelled as presentation latency.
For example, median per-run acknowledgement p95 for Source's first sash
increased from 16.73 to 52.25 ms. Its median long-task count rose from 4 to 7;
total long-task duration rose from 321 to 707 ms. Lower scripting and React
duration therefore do not establish an overall interaction speedup.

Raw reports, traces, input identities, per-sample analysis, chart and recovery
evidence are archived outside the worktree at
`/home/dee/.t3/task-artifacts/227`. The host was shared with other tasks;
isolation excludes this task's parallel checks, not all host activity. Timing
differences remain observations rather than a proven causal regression or
speedup. The scope removes repeated persistence and shared publications;
Source layout/style/paint costs and smoothness remain unresolved.
