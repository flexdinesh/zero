# Unchanged polling measurements

Walkthrough summaries retain semantic result identity. Navigation polling and
dialog state live below App, with independent Source command and detailed
status subscriptions. See [decision 0161](decisions/0161-coherent-background-polls.md).

## Repeat the capture

```sh
mise run test:browser:extended -- tests/browser/idle-poll-performance.spec.ts --workers=1
```

The harness serves the real embedded production UI and a 10,000-line TypeScript
Source document. Walkthrough responses are controlled empty lists; navigation
responses describe a ready server with unchanged memory and capabilities.
Actual five-second and three-second timers run throughout. Each fresh context
warms highlighting and status, measures 15 seconds idle, then sends 16 native
ArrowDown inputs spaced one second apart. Five contexts use production assets;
five use the existing separate `react-dom/profiling` build. No instrumentation
ships in the product.

Captured 2026-11-18 with Chromium 153.0.8010.12, Linux amd64/Debian 12, a
1440×900 viewport, and the repository's 2 CPU/4 GiB container limits. Baseline
runtime matches all 291 production frontend source inputs in its snapshot at
`174c647f`; final candidate runtime is `d53f278c`. It includes a clock local to
the visible populated walkthrough list, preserving relative-age updates without
making unchanged results update App. Later commits update this report only.

## Results

Each entry is a median of five samples, milliseconds, baseline / candidate.
The JSON artifact retains every sample and min/median/p95/max distributions.

| Production interval | Scripting | Layout | Style recalculation | Paint |
| --- | ---: | ---: | ---: | ---: |
| Idle, 15 seconds | 920.69 / 11.76 | 0.00 / 0.00 | 6.49 / 27.73 | 0.00 / 0.00 |
| Native keys, about 16 seconds | 965.67 / 50.14 | 0.07 / 0.13 | 46.30 / 53.72 | 405.04 / 725.69 |

Scripting/layout/style are main-thread CDP metric deltas. Paint sums the union
of Paint intervals per thread. Style, key-interval layout and paint increased;
no general layout/paint improvement or overall interaction speedup is claimed.

Median per-run native input-to-frame p95 was **117.98 / 154.91 ms**. Analysis
uses `InputLatency::RawKeyDown` ORIGINAL and FRAME_SWAP components. Of 16 inputs,
baseline samples contained 15, 16, 15, 13, 15 frame-bearing records; candidate
samples contained 15, 15, 15, 14, 15. Inputs without a recorded frame swap are
excluded. This is headless frame-swap latency, not physical display latency or
field INP.

| React boundary and interval | Summed actual duration, baseline / candidate | Observed commits, baseline / candidate |
| --- | ---: | ---: |
| SourceDocument, idle | 414.70 / 0.00 | 16–17 / 0 |
| FileTree, idle | 5.60 / 0.00 | 16–17 / 0 |
| SourceDocument, keys | 464.50 / 0.00 | 18–20 / 0 |
| FileTree, keys | 9.90 / 0.00 | 18–20 / 0 |

The candidate recorded zero SourceDocument/FileTree commits in all ten measured
profiling intervals. Every idle interval on both revisions completed three
walkthrough and five navigation reads. Other intervals retained their real
polls, with counts in the JSON. Local process metrics still update StatusBar;
ancestor App/provider profiler callbacks include that descendant work and do
not establish that App's function rendered. Do not sum ancestor and descendant
durations or treat these observations as exact-render-count tests.

## Limits and retained evidence

- Controlled responses isolate unchanged polling. They do not measure a real
  language server, network variability, changed data, or notification latency.
  Browser behavior regressions cover meaningful changes, errors, retry, badges,
  cancellation, caret commands, version refreshes and project/file/settings
  switches separately.
- Visibility-policy tests simulate document visibility and focus events.
  Chromium/WebKit correctness coverage does not establish native background
  throttling or macOS web-view timings.
- Host load was uncontrolled. Baseline host typecheck/dependency preparation
  overlapped part of its capture; candidate capture ran without another
  validation workload from this task. Timing differences cannot all be assigned
  to the code change. React profiles independently establish the observed
  document-work isolation for these unchanged responses.
- The protocol and executed interactions match. A type-only contract import in
  the harness was changed to a root-resolvable relative path after baseline;
  its erased type annotation changes no measured behavior.
- Concurrent full validation exposed a five-second highlighting warm-up timeout
  in the new harness (21 other extended cases passed). The readiness wait now
  uses the existing profiling harness's 30-second bound. Measurements still
  begin only after highlighting is present; interval lengths and interactions
  are unchanged. Both standalone captures above completed the original wait.
- Existing workers, bounded caches, review virtualization and polling policies
  remain unchanged. No broad memoization was added.
- An earlier candidate capture (`73c787a7`, before the local age-clock follow-up)
  recorded 13.12 ms idle scripting, 50.10 ms key-interval scripting, 300.83 ms key
  paint and 41.44 ms native input-to-frame p95. The final capture's worse paint
  and latency demonstrate variation; their cause was not isolated. Both captured
  zero unrelated document work in the React intervals.

Capture IDs: baseline `985199e42dac38359d077b48f9d414a4`, candidate
`c7088518bb01c2984f484178385cfede`. Each completed 20 interval records and ten
production traces. Raw outputs, environment records, source hashes, analysis
script, complete distributions and command inventory are archived outside the
task worktree at `/home/dee/.t3/task-artifacts/228/`.

## Validation follow-up

The initial concurrent full run (`ae260cc6`) passed ten groups, with 225 passing
cases in each browser engine and 21 passing extended cases. It exposed the
warm-up timeout above, new test-fixture request/clock races, and one unchanged
diff-anchor failure in each engine. The fixture now identifies the explicitly
held walkthrough version and freezes wall time across the clock-pause RPC.
Nineteen focused polling cases, including relative ages and row focus, passed
in both engines (`4af8fcd7`, `6728de7f`); the earlier 18 passed twice in WebKit
(`f24bdcb5`). The corrected extended group passed 22 cases (`6d2ebef1`), but
HEAD changed during that run, so it supplies no aggregate certification.

The unchanged native anchor case passed three isolated repetitions on both
fresh-main runtime and candidate runtime (`d65a6e8b`, `9519cef4`). Inspection of
the failed traces found README rows disappearing during startup before the
first periodic walkthrough read. No polling-removal mechanism or precise cause
was established. These isolated passes do not explain that concurrent failure;
no review pin, virtualizer, timeout or assertion was changed for it.

An independent core review found no actionable issues. An optional follow-up
review of the age clock could not execute because its tool host was missing;
parent review and browser regressions cover that change. Superseded validation
runs were cancelled explicitly while the age-preservation follow-up was added.
