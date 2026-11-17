# UI state ownership profiling

Search interaction state lives in its project session provider. Source Control
has separate query, pane, rail, draft, and command subscriptions. App retains
shared data reads and routing. See [decision 0158](decisions/0158-feature-ui-state-ownership.md).

## Repeat the capture

Run the same [benchmark](../tests/browser/ui-state-performance.spec.ts) and
[diagnostic build configuration](../apps/web/test-fixtures/profile.config.ts)
against both revisions through the repository's container tooling:

```sh
mise run test:browser:extended -- tests/browser/ui-state-performance.spec.ts
```

The test serves the real production binary and real search corpus/worker. Each
repetition creates a fresh browser context, opens a 10,000-line TypeScript Source
document, warms highlighting and search, then types `ownership-needle` with
Playwright's configured 50 ms key delay. It waits for the final worker result.
It separately collapses panes, changes list/tree mode, resizes panes by keyboard,
and exercises the review rail's keyboard resize, viewed filter, and visibility.
Source Control lists, stats, and API requests settle before measurement.

Five repetitions use normal production assets and CDP performance traces. Five
more use a separate `react-dom/profiling` build with component Profiler boundaries.
The shipped build never imports this instrumentation. The profiling assets replace
only the shell's scripts/styles; server data, API, CSP, and workers remain real.

Each scenario persists its metrics to `ui-state-measurements.json`. The test's
output directory also retains 15 production `*.trace.json` files. These files are
written before attachments so the dot reporter preserves them. The validation
command prints the containing artifact directory.

## Recorded result

Captured 2026-11-18 on Chromium 153.0.8010.12, Linux container, 2 CPUs, 4 GiB
memory limit, 1440×900 viewport. Original feature source matches `17301dba`;
candidate is `316ad002`. Both matching captures completed 30 scenario samples.
Each table entry is a median across five repetitions, in milliseconds.

| Production scenario | Scripting before / after | Layout before / after | Style before / after | Paint before / after |
| --- | ---: | ---: | ---: | ---: |
| Search typing | 1090.02 / 135.50 | 70.37 / 64.73 | 31.85 / 35.52 | 87.96 / 81.07 |
| Source Control panes | 506.13 / 251.37 | 43.55 / 40.50 | 70.78 / 66.49 | 50.22 / 49.10 |
| Review rail | 47.02 / 20.46 | 5.71 / 5.10 | 8.86 / 8.41 | 3.08 / 2.96 |

Scripting, layout, and style are main-thread CDP metric deltas. Paint sums the
union of trace Paint intervals per thread. Median per-run native key-down-to-frame
swap p95 during search was **334.38 / 40.67 ms**. Every production typing sample
contained 16 complete native key-down latency pairs. This is a trace latency
measurement, not the web-vitals INP statistic.

| React profiling scenario and boundary | Actual duration before / after |
| --- | ---: |
| Search typing: SourceDocument | 561.0 / 51.7 |
| Search typing: FileTree | 4.3 / 0.4 |
| Pane controls: SourceDocument | 260.9 / 46.0 |
| Pane controls: FileTree | 2.0 / 0.4 |
| Rail controls: ReviewDocument | 3.3 / 0.0 |
| Rail controls: FileTree | 1.1 / 0.0 |

These are sums of actual durations for each boundary within a scenario, then
medians across repetitions. App's ancestor profiler includes descendants; it is
not an App self-render counter. Do not add ancestor and descendant timings.

## Limits and diagnostics

- Captures retain real background updates. The candidate's search profiles still
  contain two Source/FileTree commits per repetition; pane profiles contain zero
  or two. Navigation status polls every three seconds and walkthroughs every five
  seconds. Their state remains in App. Polling is a plausible contributor to this
  residual work; the capture does not isolate each commit's cause. No zero-total-
  render claim or polling optimization is made.
- The input delay is configured in Playwright. Actual event spacing also includes
  browser processing. Native latency pairs describe headless Chromium frame swap,
  rather than a physical display or the desktop OS web view.
- React profiling overhead is excluded from production browser timings. The
  measured reduction is predominantly scripting; layout, style, and paint remain
  comparable. Five repetitions on this fixture do not establish a hardware-wide
  speedup.
- An early harness selected the Search activity without invoking Find in Files.
  The original code reveals the panel through that path without initializing the
  corpus. The benchmark now invokes the real command and verifies its response.
  Activity-only initialization remains outside this change.
- An earlier long-lived-page candidate capture crashed on its fifth profiling
  repetition. Its partial results are excluded above. Fresh contexts bound each
  repetition's lifetime; both final captures passed. The earlier crash's precise
  cause was not established.

Final capture IDs: original `8c81b97849c51b2452d4a9b06699050f`, candidate
`15f5ee28d0305291bda25e5186a1480c`. Raw artifacts and the analysis script are
retained with task 225's handoff. Existing diff virtualization, workers, bounded
caches, pointer scheduling, and polling equality are unchanged.

## WebKit compatibility follow-up

The full WebKit run exposed six cases that also failed with the original
feature source from freshly fetched `origin/main` (`17301dba`). Two font checks
required Chromium's quoted CSSOM serialization. They now compare the exact
first family after removing optional quotes. Three clipboard checks used
`readText()`, which Playwright WebKit cannot grant permission to call. They now
verify the native clipboard through trusted keyboard paste into a temporary
textarea, restoring focus and selection afterward. Chromium retains native
`readText()`. Native Ctrl+C and exact copied text remain covered.

The review-anchor failure was a product bug. Moving over an expanded gutter
re-appended Pierre's gutter utility to its existing parent. Instrumented native
hover captured `main.scrollTop` changing from 4033 to 216 synchronously inside
that `appendChild`, before pointerdown or focus and without a JavaScript scroll
call. The existing Pierre patch now skips same-parent utility reattachment
and uses Pierre's existing WebKit rebuild guard during actual utility moves.
The first guard-only trial fixed hover but exposed the same collapse during
the selection's real utility move. The original anchor click, URL,
selection, scroll and refresh assertions remain, with an added hover-position
assertion. The initial automation-only diagnosis was disproved by native mouse
input. This guard changes no virtualization, worker or cache policy.

The performance captures above predate this gutter guard and browser-test
repairs. The hover diagnosis is correctness evidence, not a measured speedup.
Original-runtime comparison: `8a0198f3945f0e0b6a58d1b65fe35dbd`; synchronous
mutation diagnosis: `52dec08fc85642f3ea2a6d73ba7d593a`. Traces and logs remain
in task 225's artifact archive.

## Render-completion and test-budget follow-up

A later combined full-suite run passed Chromium, desktop, static, unit and
stress groups, but WebKit reported two different failures. Both cases passed
three isolated repetitions on freshly fetched main and the candidate; those
passes alone did not resolve the full-suite evidence.

F7 selected the correct final file and line, but the viewport stopped above it.
The resident diff remained registered while Pierre replaced its rows. Passing
diagnostic captures recovered through ResizeObserver; the registration-only
path did not notify the active pin about later renders of the same instance.
Completed mount/update notifications now schedule one coalesced correction
after Pierre's render. Release cancels that frame and fences an already queued
callback. Corrections compare against the reachable, clamped position. The
300 ms quiet interval, three-second maximum, input cancellation, virtualization
and single scroll owner remain unchanged.

The actual public render handler is tested for repeated updates of a resident
instance, virtualization unmounts, coalescing and release fencing. Existing F7
and anchor browser assertions remain unchanged. Controlled-frame and synthetic
collapse probes are excluded as final regressions: their scheduling assumptions
were unstable across repeated native browser runs. They are retained only as
diagnostic artifacts, not aggregate validation evidence.

The Feedback trace showed test teardown and server shutdown before the final
Delete click. Its 30-second total budget expired during the long navigation
flow. That case now has a 60-second total budget; its five-second assertions and
exact clipboard checks are unchanged. Three traced WebKit repetitions passed:
DELETE returned 204 in 1.460–1.991 ms, and the final empty-view assertion took
84–139 ms (`2e3589b045c782a6371aac55a1e106fa`). No server change was needed.

A subsequent trace exposed a separate startup gap: the badge read completed
before an external reply, and the live subscription started afterward. Its
initial status/head events replayed no feedback write. The follower reconciles
Feedback once on its first validated subscription status. Reconnection and
focus fallback retain their existing full catch-up behavior.

The regression holds the real event subscription, reads two open threads,
resolves one through the API, then releases the stream. Old code failed with
the badge still at two (`2be46799af645ad7074b4670ac147de5`). The repaired
code passed three new regressions and three unchanged long flows per engine:
Chromium `8a3cd4d1eb690241a621ae05deb3566d` and WebKit
`60ba7ef5da97326925a0fc67216da975`. Those captures used an initial full refresh.
Traces show a fresh read after status,
without a replayed feedback event. Frontend tests also passed
(`0b267fa00fca5a4220fd31680691b11a`). Existing five-second assertions remain.

Combined run `993f8653efd7dd3eae00d9ac7ac7181e` then exposed unnecessary page
reads from that broad initial refresh: embedded page data and fragment-only
selection assertions failed. Initial reconciliation is now a separate
subscription callback mapped only to Feedback. The no-extra-page-read
assertions remain. The project-choice fixture also waits for its in-flight
route handlers before teardown, preventing response disposal during JSON
decoding; its existing navigation assertions remain.

The narrowed path passed frontend tests (`7a51bd075b84df33b4b3a85ab7fd4669`)
and 15 targeted cases per engine, three repetitions of each affected behavior:
Chromium `5855f1088531a510b73bdc24d7eecf38`, WebKit
`0efbafdfdc4673bcce5554bdde267a68`. Web, root tooling and site typechecks passed.

## Saved connection lifetime follow-up

Full run `993f8653efd7dd3eae00d9ac7ac7181e` also closed the remote desktop
window successfully, then found its server still counting one presence client.
Fresh-main desktop baseline `edb23efa8fdbcc8e4bbdd87f683ef2f4` passed the
complete native scenario. The intermittent native failure's exact sequence
remains unproven: its artifacts contain no request teardown stacks.

Static inspection found a concrete ownership gap: dropping a saved TLS
connection closed idle transport connections but relied on downstream write
failure to end active requests. Each saved connection instance now cancels its
active requests on Drop, replacement or Close. The notifier shares that
instance's transport. Cancellation remains attached after headers until the
response body closes; caller cancellation still works. Existing sandbox and
transport cleanup, other connections and freshly reopened instances retain
their lifetimes.

The regression uses real TLS presence with a downstream writer that continues
accepting writes. It covers Drop, Close, replacement, shared notifier requests,
independent connections, reopening, parent cancellation, body cleanup and a
request still waiting for headers. The native close/shutdown assertions and
deadlines remain unchanged. Late requests recreating a connection after window
closure were not established by the trace and are not changed speculatively.

Old implementation with the new regression failed as expected in
`f6cac8bebda34fc396411906b6ab54c7`: TLS presence outlived Drop, Close and
replacement, and a request waiting for headers remained active. The repaired
implementation passed desktop vet and race-enabled tests in
`1276db4dca2fae1c219cf157ad64aca5`. Independent static review found no
actionable issues. These establish the lifetime gap and its repair, not the
exact cause of the intermittent native failure.
