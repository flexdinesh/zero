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
checked). Final run `4485a6a8e35ac848350f43276f6e83b2` used runtime
`1d03b983b6be01ba4e8eb8ff90e874cc2ebeb44a` (481 production input hashes
checked, zero mismatches). Both passed with 100 scenario records, 50 production
traces, five production repetitions and five separate React repetitions. Both
reported zero memory-limit and OOM events under the same 2-CPU, 4-GiB limit
and Chromium `153.0.8010.12`.

Harness, diagnostic config and runner hashes matched between captures. All
200 scenarios delivered 48 trusted pointer moves; complete paths, initial
geometry and final accessible values matched. No final-capture validation
group or container progress probe from this task ran alongside measurement.
The host remained shared with other tasks.

Values below are baseline / final five-run medians, in milliseconds per
instrumented scenario, including the fixed tail and settlement checks.

| Workload / control | Script | Layout | Style | Paint |
| --- | ---: | ---: | ---: | ---: |
| Source / sidebar | 2281.40 / 539.82 | 5591.33 / 4190.19 | 27406.14 / 469.55 | 1180.42 / 564.53 |
| Source / Uncommitted–Commits | 387.29 / 23.16 | 226.24 / 206.00 | 11.02 / 14.03 | 706.54 / 30.82 |
| Source / Commits–Branches | 420.28 / 104.80 | 248.37 / 169.39 | 11.87 / 7.59 | 817.14 / 18.66 |
| Review / sidebar | 274.52 / 140.93 | 241.22 / 154.65 | 1710.74 / 69.74 | 164.42 / 89.64 |
| Review / Uncommitted–Commits | 194.55 / 30.02 | 35.63 / 27.78 | 12.29 / 8.04 | 57.09 / 39.21 |
| Review / Commits–Branches | 197.83 / 16.69 | 34.00 / 29.78 | 13.26 / 9.18 | 43.68 / 36.66 |
| Review / Files rail | 359.44 / 272.74 | 289.09 / 239.78 | 59.70 / 43.27 | 209.23 / 196.87 |
| Diagrams / sidebar | 41.86 / 35.91 | 65.75 / 58.33 | 705.98 / 60.80 | 81.11 / 64.37 |
| Diagrams / Uncommitted–Commits | 204.00 / 40.52 | 24.83 / 26.64 | 11.60 / 10.12 | 50.99 / 45.00 |
| Diagrams / Commits–Branches | 201.40 / 17.68 | 25.58 / 26.69 | 12.81 / 9.41 | 39.48 / 33.05 |

Every pane and rail drag attempted 48 Source Control storage writes while
pressed in the baseline; the final implementation attempted zero while
pressed and one after release. Sidebar drags attempted one write after release
on both revisions, consistent with its existing completion-owned persistence.

The Source/sidebar trace's largest style recalculation changed from 110666
elements to 24 in every production repetition. The 48 recalculations involving
more than 1000 elements became zero. Actual width changes still required 48
layout passes. Source/sidebar median long-task count changed from 67 to 54;
total long-task duration changed from 45303 to 12130 ms. The first Source sash's
median long-task count changed from 4 to 0 and duration from 321 to 0 ms;
individual final runs still contained long tasks, retained in the raw report.

React owner-boundary `actualDuration` totals, separately profiled:

| Workload / control | Boundary | Baseline / final ms |
| --- | --- | ---: |
| Source / Uncommitted–Commits | SourceControlView | 91.9 / 5.2 |
| Source / Commits–Branches | SourceControlView | 81.5 / 3.6 |
| Review / Uncommitted–Commits | SourceControlView | 105.2 / 2.5 |
| Review / Commits–Branches | SourceControlView | 110.8 / 5.5 |
| Review / Files rail | ReviewFilesRail | 15.3 / 0.7 |
| Diagrams / Uncommitted–Commits | SourceControlView | 99.2 / 8.0 |
| Diagrams / Commits–Branches | SourceControlView | 91.4 / 3.1 |

These boundary totals include descendants. SidebarResizer has no separate
profiling boundary, so this pass cannot give its own React duration. During
review/sidebar, the SourceControlView boundary increased from 7.2 to 9.3 ms.
Some production costs also increased: diagram sash Layout medians changed
from 24.83/25.58 to 26.64/26.69 ms; the first Source sash's Style median changed
from 11.02 to 14.03 ms. Background polling and all outliers remain included.

### Remaining interaction and latency limits

The configured 16 ms delay is not achieved event cadence. Per-run median
Source/sidebar move intervals ranged 817.1–1415.0 ms in the baseline and
181.5–501.0 ms in the final capture. Source/sidebar is still expensive and is
not uniformly smooth on this large fixture. Its final Layout median remains
4190.19 ms. These are processing-plus-automation intervals, not display latency
or an assurance of a particular frame rate.

All 2400 production drag MouseMove flows in each capture had complete begin/end
pairs. Only 17 baseline flows and 1709 final flows recorded explicit frame-swap
metadata. The remaining 2383 and 691 completed without it; no begin/end pair was
missing. Fifty pre-drag hover flows per capture were excluded. MouseDown
frame-swap coverage was 2/50 and 23/50; MouseUp coverage was 3/50 and 2/50.
These unequal populations do not support a representative before/after
presentation-latency comparison. Acknowledgement includes different amounts
of frame work and must not be relabelled as presentation latency. For example,
review/rail median per-run acknowledgement p95 increased from 16.60 to 44.96 ms.
Do not infer an overall latency or field INP improvement from the lower CPU
and React observations.

### Investigation and preservation

The first ownership-only candidate (`17343aa5`, runtime `3d0497f9`) reduced
persistence and React work but retained high Source style/paint costs. Its
complete capture remains archived; it is superseded by the final comparison.
Controlled Source-only interventions then separated inherited width, root
style mutation, and adjacent Source painting. An inheritance override and
registration while retaining root writes did not eliminate broad style work.
Direct registered writes to the two grid owners did. Source paint containment
reduced sash paint; pane-owner containment did not and was rejected.

Diagnostic `fe0c0ba4` passed 45 records over three repetitions but reported
memory-limit pressure (`max 1228`, zero OOM kills). Diagnostic `6f6e3aaa` passed
24 records over two repetitions with zero memory-limit/OOM events. These new
mechanism probes did not replace or reduce the final unchanged five-repetition
capture. Diagnostic timing is not final acceptance evidence.

The resulting width property is non-inherited and written only on the layout
and status grids. Both targets are resolved once by the narrow resize owner.
Source uses a screen-only paint boundary inside its existing scroll box;
print keeps its previous fragmentation. Source DOM, workers, bounded caches,
diff virtualization, keyboard resize/reset, cancellation and responsive bounds
remain. Both browser engines passed the targeted geometry, scrolling, focus,
draft, navigation and live-update regressions. Full committed validation is
required separately before publication.

Raw reports, traces, input identities, each of the five samples and medians,
long-task and native latency distributions, storage calls, React boundary sums,
charts and recovery evidence are archived outside the worktree at
`/home/dee/.t3/task-artifacts/227`. See `measurements-final.md`,
`candidate-css-final-analysis.json`, `source-investigation.md` and the run
archives there. Five repetitions, shared host load and one headless browser
cannot establish a universal speedup or native desktop presentation latency.
