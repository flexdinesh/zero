# Scrollbar discovery profiling

Finding 10 (`perf-expensive-rendering`) identified synchronous discovery in
`apps/web/src/components/ui/overlay-scrollbars.tsx`: pointerover and wheel walk
the composed event path and read scrollability before the scheduled geometry
frame. This is a hypothesis about cost. The existing frame already batches
geometry reads before writes.

## Decision and initial evidence

The production baseline at `eef47882752ee366e4afb0e274ddece158f89704` did not
establish a material discovery bottleneck on the measured machine. Keep the
controller unchanged and add repeatable measurement and behavior coverage.
A persistent cache would require ancestry, overflow, size, removal, and modal
invalidation. Its complexity is not justified by this evidence.

The initial capture used Chrome 157 on Linux, headless, 1280 × 633 CSS pixels,
DPR 1, a fine primary pointer, and no CPU throttling. The application was built
with `mise run build:web` and served by the Go binary with its embedded assets.
Each scenario used three 240-step pointer sweeps and 24 alternating ±120px wheel
inputs. Setup and syntax highlighting completed before tracing.

| Scenario | Overlay pointerover p95 | Overlay wheel p95 | Discovery style recalculations | Discovery forced layouts |
| --- | ---: | ---: | ---: | ---: |
| Source, 3,148 highlighted spans | 0.571 ms | 0.536 ms | 0 | 0 |
| Pierre shadow-root file tree | Insufficient samples | 0.808 ms | 0 | 0 |
| Settings dialog | 0.587 ms | 0.542 ms | 42, totaling 7.229 ms | 0 |
| 24-level nested area, 30,025 descendants | 0.447 ms | 0.562 ms | 0 | 0 |

These are durations of the overlay's outer callbacks, including scheduling and
target changes, not `nearest` alone. Attribution used trace function locations
and style/layout stacks in the built bundle. A single source pointerover reached
3.283 ms. The shadow-tree document callback ran once on entry: transitions
within the shadow root do not all propagate to the document after related-target
retargeting. Slower internal pointerover work belonged to Pierre's handlers.

A separate diagnostic burst dispatched 100 synthetic wheel events on a source
span: 210 computed-style calls, 3.1 ms total including a counter and two captured
stacks. This confirms repeated reads, not native scroll latency or a speedup.
No DOM APIs were patched during the primary traces.

The task's initial artifacts were `/tmp/scrollbar-baseline-{source,shadow,dialog,nested}.json`
and `/tmp/zero-scrollbar-234-baseline.json`. They are local artifacts; the table
preserves the conclusion independently of their retention.

## Repeatable production capture

```sh
mise run test:browser:extended -- tests/browser/overlay-scrollbars-performance.spec.ts --workers=1 --repeat-each=3
```

The existing validation runner builds fresh production assets and the binary
inside its isolated container. The spec opens the private live server's embedded
UI, verifies production asset URLs and a mounted overlay, then measures source,
Pierre's file tree, Settings, and the large nested fixture. Vite is not the
measured application. A fine pointer and completed syntax highlighting are
required; missing prerequisites fail the capture.

Each scenario records three relative 240-step sweeps, followed by eight
alternating ±120px native wheel inputs per sweep, spaced 32 ms apart. The
browser's frame/input scheduling determines sweep duration. This is a new,
stable container protocol; compare subsequent runs of this protocol with each
other, rather than treating the initial agent-browser capture as an identical
benchmark. Run with one worker to reduce contention; repeat runs to expose
variation. Record competing machine load when interpreting results.

Validation prints the artifact directory. Each successful repetition retains
four `*.chrome-trace.json` files and a `scrollbar-measurements` attachment under
the Playwright output. The JSON records browser version, pointer/viewport/DPR,
fixture sizes, repetition, and distributions. Open raw traces in Chrome
DevTools Performance or Perfetto. Screencast tracing and screenshots are off.

The summaries include pointerover/wheel dispatch, function calls, style, layout,
paint, and completed native input-latency spans. Dispatch includes all listeners;
function-call spans can nest and must not be added into an exclusive scripting
total. Input latency includes compositor scheduling and is not INP. Inspect CPU
samples and stack traces to attribute work to discovery before proposing a fix.
Do not infer an overlay bottleneck from whole-page style/layout totals.

There are no machine-dependent timing assertions. Behavioral regressions check
scroll destinations, nearest axes, clipping, shadow-root traversal, and modal
transitions; existing Source Control tests retain drag, idle, touch, and native
horizontal-bar coverage.

## Limits

The measurements include tracing overhead and cover headless Linux Chromium.
The container has bounded resources. They establish neither low-power hardware
performance nor native WebKitGTK timings. WebKit behavior tests check
compatibility separately; CDP profiling is Chromium-only. This imperative
controller does not render React during discovery, and these captures make no
React render-timing claims. Use a React profiling build for any future React
timing investigation. No optimization or measured speedup is claimed here.
