import { writeFileSync } from "node:fs"

import type { Page } from "@playwright/test"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

interface TraceEvent {
  name: string
  ph: string
  ts: number
  dur?: number
  pid?: number
  tid?: number
  id?: string
  args?: Record<string, unknown>
}

function isTraceEvent(value: unknown): value is TraceEvent {
  return record(value) && typeof value.name === "string" && typeof value.ph === "string" && typeof value.ts === "number"
    && (value.dur === undefined || typeof value.dur === "number")
    && (value.pid === undefined || typeof value.pid === "number")
    && (value.tid === undefined || typeof value.tid === "number")
    && (value.id === undefined || typeof value.id === "string")
    && (value.args === undefined || record(value.args))
}

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    maxMs: sorted.at(-1) ?? null,
  }
}

function inputLatency(events: TraceEvent[], name: string) {
  const starts = new Map<string, number>()
  const durations: number[] = []
  for (const event of events) {
    if (event.name !== name || event.id === undefined) continue
    const key = `${event.pid}:${event.id}`
    if (event.ph === "b") starts.set(key, event.ts)
    else if (event.ph === "e") {
      const start = starts.get(key)
      if (start !== undefined) durations.push((event.ts - start) / 1000)
      starts.delete(key)
    }
  }
  return { ...distribution(durations), incomplete: starts.size }
}

function summary(raw: unknown[]) {
  const events = raw.filter(isTraceEvent)
  const duration = (name: string) => distribution(events.filter((event) => event.ph === "X" && event.name === name)
    .flatMap((event) => event.dur === undefined ? [] : [event.dur / 1000]))
  const dispatch = (type: string) => distribution(events.filter((event) => event.name === "EventDispatch" && event.ph === "X"
    && record(event.args?.data) && event.args.data.type === type).flatMap((event) => event.dur === undefined ? [] : [event.dur / 1000]))
  return {
    // Dispatch includes every listener. FunctionCall durations can nest. Neither
    // is an isolated measurement of the overlay controller or an additive CPU total.
    pointeroverDispatch: dispatch("pointerover"),
    wheelDispatch: dispatch("wheel"),
    functionCalls: duration("FunctionCall"),
    style: duration("UpdateLayoutTree"),
    layout: duration("Layout"),
    paint: duration("Paint"),
    mouseMoveLatency: inputLatency(events, "InputLatency::MouseMove"),
    mouseWheelLatency: inputLatency(events, "InputLatency::MouseWheel"),
  }
}

// Trace only the short interaction, without screenshots or patched DOM APIs.
// Raw CPU samples and style/layout stacks permit attribution in DevTools.
export async function traceScrollbars(page: Page, path: string, interact: () => Promise<void>) {
  const session = await page.context().newCDPSession(page)
  const events: unknown[] = []
  const collect = (payload: unknown) => {
    if (record(payload) && Array.isArray(payload.value)) events.push(...payload.value)
  }
  session.on("Tracing.dataCollected", collect)
  await session.send("Tracing.start", {
    categories: "devtools.timeline,v8.execute,blink.user_timing,latencyInfo,benchmark,toplevel,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-v8.cpu_profiler",
    options: "sampling-frequency=1000",
    transferMode: "ReportEvents",
  })
  try {
    await interact()
  } finally {
    try {
      const complete = new Promise<void>((resolve) => session.once("Tracing.tracingComplete", () => resolve()))
      await session.send("Tracing.end")
      await complete
      writeFileSync(path, JSON.stringify({ traceEvents: events }))
    } finally {
      await session.detach()
    }
  }
  return summary(events)
}
