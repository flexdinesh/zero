# Preview profiling

Finding 7 identified eager main-thread Markdown fence highlighting and Mermaid
compilation on each observed width. Decision [0158](decisions/0158-preview-work-scheduling.md)
moves fences to the shared highlight worker and schedules diagram compilation
after width settles.

## Repeatable capture

```sh
mise run test:browser:extended -- tests/browser/preview-performance.spec.ts --workers=1
```

The repository runner builds and serves the embedded production app in its
private browser container. Fixtures contain 600 small JSON fences, approximately
250 KiB of JavaScript in one fence, and 12 Mermaid flowcharts. Every workload has
five cold and five warm samples. Cold uses a fresh browser context; warm reloads
in that context with browser caches intact. The viewport is 1000 × 900, DPR 1,
with no CPU throttling, inside the runner's 2 CPU / 4 GiB limits.

Each production sample opens Preview, waits for a highlighted token or diagram,
allows a fixed 1000ms observation window, then drags the file-tree separator in
24 ten-pixel steps spaced by at least 16ms. It allows 400ms for settling, scrolls
to the final block, and observes another 400ms. Diagram samples assert their
frame becomes at least 32px narrower, so the reading-width cap cannot turn the
drag into an ineffective resize. Playwright screenshots and automatic tracing
are disabled for these measurements.

Each sample retains a Chrome performance trace and its long-task/event-duration
observations in `browser-extended/output/playwright/`. Traces include scripting,
style, layout, paint, resize marks and native mouse-move latency. The metrics
files record the browser version, viewport and observed diagram widths.

The separate React measurement builds the same app with `react-dom/profiling`
and a root Profiler before JSX transformation. Request interception serves only
that context's profiling assets, with the real server's initial data, APIs and
CSP. This needs no Go rebuild or network access in the execution container.
`preview-react-metrics.json` retains the actual render durations for the same
workloads and gestures. Normal builds ship no profiling instrumentation.

## Interpretation and limits

Report cold/warm distributions and retained raw evidence, rather than inferring
speedups from worker use or fewer synchronous call sites. Root React durations
include workspace rendering. They exclude worker tokenization and are separate
from normal production latency measurements.

Function-call trace durations can nest; their sum is not an additive CPU total.
Native mouse-move latency includes compositor scheduling and is not INP. Event
Timing reports only events meeting its duration threshold. Trace windows are
fixed, not a measurement of highlighting every offscreen fence: distant fences
intentionally remain plain until approached. Host contention and trace overhead
can affect individual samples. A single Mermaid compile remains synchronous.

Chromium traces do not establish native macOS performance. Playwright WebKit
and the built Linux desktop app provide separate compatibility coverage.

## Recorded comparison

Captured on 2026-11-18 with Chromium 153.0.8010.12. Baseline runtime was
`17301dbaaf0623f4b54d5cbc5ca150d18426d6de`; final candidate was
`f293e39f8767483a70eadec8871661949d1ee00f`. The identical harness produced 30 production traces
and 30 profiling samples per version. Every diagram resize changed its frame
from 607px to 435px. Baseline run: `463f1370ac64d68276c372c1b35eeace`.
Candidate run: `c3e3c4493a21683d628943e7863e574b`.

Values below are medians across ten production samples, with before → after.
Times are milliseconds. Function-call sums include nested calls.

| Workload | Long tasks >50ms | Longest task | Function calls | Style | Layout | Paint |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 600 small fences | 19.5 → 21 | 256.5 → 352 | 387.2 → 726.4 | 792.4 → 1186.9 | 276.4 → 439.5 | 93.7 → 235.0 |
| One large fence | 22 → 21 | 183.5 → 312.5 | 247.6 → 511.6 | 1534.6 → 2881.4 | 547.4 → 854.1 | 60.8 → 108.7 |
| 12 diagrams | 2 → 1.5 | 87 → 112.5 | 206.3 → 239.9 | 118.2 → 226.0 | 26.7 → 39.0 | 23.1 → 42.1 |

| Workload, resize window | Function calls | Style | Layout | Paint | Per-sample mouse-move latency p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small fences | 26.3 → 41.8 | 689.5 → 958.1 | 169.3 → 224.0 | 73.1 → 117.3 | 15.8 → 18.9 |
| Large fence | 26.2 → 77.1 | 1407.2 → 2550.7 | 377.3 → 497.6 | 51.3 → 69.3 | 20.5 → 21.5 |
| Diagrams | 45.4 → 35.7 | 89.2 → 189.2 | 9.1 → 15.0 | 15.1 → 28.9 | 14.4 → 16.7 |

Cold and warm samples each contain five runs. React totals come from the
separate profiling build, not the production traces.

| Workload | Cold long tasks | Warm long tasks | Cold longest task | Warm longest task | Cold React total | Warm React total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small fences | 21 → 22 | 19 → 21 | 268 → 537 | 181 → 342 | 203.0 → 320.0 | 130.5 → 221.2 |
| Large fence | 22 → 21 | 21 → 20 | 215 → 304 | 173 → 375 | 94.7 → 108.9 | 54.0 → 87.3 |
| Diagrams | 2 → 2 | 1 → 1 | 100 → 141 | 59 → 83 | 124.8 → 135.6 | 74.2 → 83.1 |

The final sequential captures show higher costs in several metrics. Small-fence
longest-task ranges were 157–318ms before and 225–610ms after. Large-fence
per-run resize p95 ranges were 15.2–29.9ms before and 15.6–45.4ms after.
Diagram resize function-call duration decreased, while its style/layout/paint
costs increased. Three other browser validation containers were active on the
host immediately after the candidate capture. This task started no concurrent
validation during these sequential captures; other work was not isolated.
Contention is a possible confounder, not a proven explanation for the increases.
The measurements do not establish an overall responsiveness or React speedup.

Earlier captures remain evidence rather than being replaced by a favorable
selection. The initial baseline (`ea815582412e4aa8e400706353a61fc5`) and
contained-block candidate (`6a9d8edc09790081660eab09cb2becef`, before the
final WebKit boundary correction) measured small-fence long tasks 19 → 8,
longest tasks 215 → 267ms, large-fence resize p95 17.1 → 20.7ms, and diagram
resize function calls 50.4 → 26.3ms. That candidate overlapped this task's
desktop validation. The rejected growing-tail candidate
(`b92a1573f1aa9d6b04df62482c4e0f5d`) measured large-fence resize p95 147.9ms
and resize layout 1585.7ms. Stable chunks measured 20.7ms/313.1ms in the earlier
capture and 21.5ms/497.6ms in the final capture. Results vary with capture load;
no controlled attribution of the remaining startup costs is claimed.

Behavior checks independently verify exact block heights for LF, CRLF, mixed
endings and bare CR, live font-size changes, native selection/copy/Find,
horizontal scrolling, stale work cancellation, and retained diagram SVG and
expanded state. An indivisible visual row can exceed the markup budget; one
Mermaid compilation also remains non-interruptible.

Raw trace archives, parsed distributions and task handoff are retained outside
the disposable worktrees in `/home/dee/.t3/task-artifacts/231/` on the capture
machine. The tables preserve results independently of local artifact retention.
