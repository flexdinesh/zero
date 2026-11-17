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
`17301dbaaf0623f4b54d5cbc5ca150d18426d6de`; candidate was `05821cec` plus
the stable-chunk revision. The identical harness produced 30 production traces
and 30 profiling samples per version. Every diagram resize changed its frame
from 607px to 435px. Baseline run: `ea815582412e4aa8e400706353a61fc5`.
Candidate run: `6a9d8edc09790081660eab09cb2becef`.

Values below are medians across ten production samples, with before → after.
Times are milliseconds. Function-call sums include nested calls.

| Workload | Long tasks >50ms | Longest task | Function calls | Style | Layout | Paint |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 600 small fences | 19 → 8 | 215 → 267 | 355.8 → 447.5 | 739.1 → 691.9 | 247.6 → 233.1 | 83.5 → 118.3 |
| One large fence | 22 → 20 | 199.5 → 181.5 | 225.7 → 347.3 | 1616.0 → 1615.0 | 563.1 → 522.2 | 63.5 → 67.3 |
| 12 diagrams | 1.5 → 1.5 | 97.5 → 80 | 218.7 → 175.5 | 133.2 → 132.8 | 31.9 → 26.2 | 25.5 → 24.2 |

| Workload, resize window | Function calls | Style | Layout | Paint | Per-sample mouse-move latency p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small fences | 26.2 → 31.6 | 621.6 → 524.1 | 154.2 → 135.1 | 60.7 → 58.7 | 16.5 → 17.3 |
| Large fence | 29.3 → 78.8 | 1482.1 → 1454.8 | 405.9 → 313.1 | 54.4 → 46.3 | 17.1 → 20.7 |
| Diagrams | 50.4 → 26.3 | 105.8 → 104.5 | 9.6 → 9.2 | 16.5 → 15.6 | 15.2 → 15.2 |

Cold and warm samples each contain five runs. React totals come from the
separate profiling build, not the production traces.

| Workload | Cold long tasks | Warm long tasks | Cold longest task | Warm longest task | Cold React total | Warm React total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small fences | 20 → 13 | 18 → 7 | 271 → 304 | 175 → 186 | 187.2 → 193.8 | 146.7 → 149.1 |
| Large fence | 22 → 20 | 21 → 19 | 200 → 183 | 191 → 162 | 83.9 → 77.2 | 41.9 → 51.8 |
| Diagrams | 2 → 2 | 1 → 1 | 111 → 105 | 54 → 55 | 135.9 → 153.6 | 111.8 → 98.2 |

Results are mixed. Diagram resize scripting decreased in this protocol, and
stable chunks removed the earlier growing-tail layout regression. That rejected
candidate (`b92a1573f1aa9d6b04df62482c4e0f5d`) had large-fence resize p95
147.9ms and resize layout 1585.7ms; stable chunks measured 20.7ms and 313.1ms.
Against the original baseline, large-fence resize latency increased from 17.1ms
to 20.7ms. Its per-run p95 ranges overlap: 14.2–46.2ms before, 16.0–28.4ms
after. Small-fence longest tasks increased, with ranges 160–294ms before and
158–406ms after. These captures do not establish a general startup or React
speedup. Concurrent desktop validation affected machine load during part of the
candidate capture; its contribution is not isolated.

Behavior checks independently verify exact block heights for LF, CRLF, mixed
endings and bare CR, live font-size changes, native selection/copy/Find,
horizontal scrolling, stale work cancellation, and retained diagram SVG and
expanded state. An indivisible visual row can exceed the markup budget; one
Mermaid compilation also remains non-interruptible.

Raw trace archives, parsed distributions and task handoff are retained outside
the disposable worktrees in `/home/dee/.t3/task-artifacts/231/` on the capture
machine. The tables preserve results independently of local artifact retention.
