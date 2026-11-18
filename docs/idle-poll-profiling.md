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
`174c647f`; the recorded candidate runtime is `400ef212`. It includes a clock local to
the visible populated walkthrough list, preserving relative-age updates without
making unchanged results update App, and the review-settlement correction below.
The later fold-input and coordinate fixes require a fresh final capture.

## Results

Each entry is a median of five samples, milliseconds, baseline / candidate.
The JSON artifact retains every sample and min/median/p95/max distributions.

| Production interval | Scripting | Layout | Style recalculation | Paint |
| --- | ---: | ---: | ---: | ---: |
| Idle, 15 seconds | 920.69 / 13.71 | 0.00 / 0.00 | 6.49 / 6.78 | 0.00 / 0.00 |
| Native keys, about 16 seconds | 965.67 / 47.91 | 0.07 / 0.08 | 46.30 / 40.92 | 405.04 / 273.74 |

Scripting/layout/style are main-thread CDP metric deltas. Paint sums the union
of Paint intervals per thread. Idle style and key-interval layout increased
slightly. Scripting, key-interval style and paint were lower in this capture;
earlier captures varied substantially. No overall interaction speedup is claimed.

Median per-run native input-to-frame p95 was **117.98 / 32.21 ms**. Analysis
uses `InputLatency::RawKeyDown` ORIGINAL and FRAME_SWAP components. Of 16 inputs,
baseline samples contained 15, 16, 15, 13, 15 frame-bearing records; candidate
samples contained 15, 15, 15, 15, 15. Inputs without a recorded frame swap are
excluded. This is headless frame-swap latency, not physical display latency or
field INP.

| React boundary and interval | Summed actual duration, baseline / candidate | Observed commits, baseline / candidate |
| --- | ---: | ---: |
| SourceDocument, idle | 414.70 / 0.00 | 16–17 / 0 |
| FileTree, idle | 5.60 / 0.00 | 16–17 / 0 |
| SourceDocument, keys | 464.50 / 0.00 | 18–20 / 0 |
| FileTree, keys | 9.90 / 0.00 | 18–20 / 0 |

The candidate recorded zero SourceDocument/FileTree commits in all ten measured
profiling intervals. Baseline idle intervals completed three walkthrough and
five navigation reads. Final idle intervals completed three or four walkthrough
and five or six navigation reads. Other intervals retained their real
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
  validation workload from this task. Another worktree's browser and host checks
  were observed during final capture. Timing differences cannot all be assigned
  to the code change. React profiles independently establish the observed
  document-work isolation for these unchanged responses.
- The protocol and executed interactions match. A type-only contract import in
  the harness was changed to a root-resolvable relative path after baseline;
  its erased type annotation changes no measured behavior.
- Concurrent full validation exposed a five-second highlighting warm-up timeout
  in the new harness (21 other extended cases passed). The readiness wait now
  uses the existing profiling harness's 30-second bound. Measurements still
  begin only after highlighting is present; interval lengths and interactions
  are unchanged.
- Existing workers, bounded caches, review virtualization and polling policies
  remain unchanged. No broad memoization was added.
- An earlier candidate capture (`73c787a7`, before the local age-clock follow-up)
  recorded 13.12 ms idle scripting, 50.10 ms key-interval scripting, 300.83 ms key
  paint and 41.44 ms native input-to-frame p95. A later pre-settlement capture
  (`c7088518`) recorded 11.76 ms idle scripting, 50.14 ms key scripting,
  725.69 ms key paint and 154.91 ms native p95. That capture overlapped another
  worktree's full validation. These differences demonstrate variation; their
  cause was not isolated. Every candidate capture observed zero SourceDocument/
  FileTree commits in its React intervals.

Capture IDs: baseline `985199e42dac38359d077b48f9d414a4`, candidate
`8f49127881cd62a8ade4f95eacde92dd`. Each completed 20 interval records and ten
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
no review pin, virtualizer, timeout or assertion was changed at that point.

An independent core review found no actionable issues. An optional follow-up
review of the age clock could not execute because its tool host was missing;
parent review and browser regressions cover that change. Superseded validation
runs were cancelled explicitly while the age-preservation follow-up was added.

The subsequent full run (`f802a2a4`) passed 12 groups, all 229 Chromium cases,
all 22 extended cases, and the unchanged anchor case in both engines. WebKit
passed 228 cases and failed the existing Mermaid expansion test. Its locator
selected the first rendered diagram while lazy diagrams finished out of order:
the trace shows a state diagram expanded before the first flowchart rendered.
The test now selects the first stable source placeholder; all SVG, zoom and pan
assertions remain. Three focused WebKit repetitions passed (`9bce975a`).
No Mermaid product code changed.

The next full run (`dae6b53d`) again passed 12 groups: 229 Chromium and 22
extended cases passed; WebKit passed 228 cases and failed the existing reverse
F7 review step. Two traced ten-repeat diagnostic batches reproduced it once
each (`865c52c3`, `cec3e8c4`). The latter captured content geometry changing
before its resize/render correction ran: the quiet timer released the pin with
the selected row outside the viewport and cancelled the queued correction.
Another reproduction had the right scroll position but no selected row.

Timed settlement now recomputes the target from current geometry and refreshes
the virtual window once before releasing the pin. Input and cleanup release
without correction; the 300 ms quiet period and three-second limit remain.
No dependency or virtualization-policy changes were needed. Independent review
supported this correction; nine focused WebKit reveal cases, eight Chromium
keyboard/native-scroll cases and six WebKit native-scroll cases passed
(`196e15dd`, `d5c09afa`, `943736f6`). Existing viewport assertions cover both
failure forms. Temporary diagnostics were removed and archived.

Run `b43f74ad` completed twelve groups, including 229 Chromium and 22 extended
cases, but received SIGTERM before WebKit finished. Its aggregate remains
uncertified; the termination cause is unknown. A live-copied failure showed a
fold-preservation setup click was lost, not a later fold-state reset. In two of
ten diagnostic repetitions (`7a10340e`), pointerdown reached the fold button
while pointerup and click landed elsewhere. Releasing an active reveal on a
fold-button press, matching existing keyboard release, passed ten repetitions
(`179feea3`). The test now asserts the initial collapse before later preservation.

The next WebKit run (`b08e7952`) found a blank README diff and was stopped
gracefully after its failure artifacts were copied. A deterministic coordinate
regression then proved a separate defect: after an 80-pixel physical scroll in
one JavaScript task, Pierre reported the stationary file's content offset 80
pixels wrong (`783cff86`, `f378939a`). The existing dependency patch now pairs
current DOM rectangles with the post-layout physical scroll offset. Cached
virtual-window calculations remain. Independent review supported this change;
22 focused cases passed in each engine (`55c50a89`, `1c5bbdda`). The contract
test does not alone establish the cause of every earlier blank-row failure.
See [decision 0162](decisions/0162-review-placement-uses-live-geometry.md).
