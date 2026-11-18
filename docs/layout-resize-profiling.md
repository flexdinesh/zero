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
