import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { CDPSession, Page } from "@playwright/test"

export function buildProfilingAssets(directory: string, mode: "feedback" | "source" | "workspace" = "feedback") {
  execFileSync(process.execPath, ["apps/web/node_modules/vite/bin/vite.js", "build", "--configLoader", "native",
    "--config", "apps/web/test-fixtures/profile.config.ts", "--outDir", directory, "--logLevel", "warn"],
  { env: { ...process.env, ZERO_PROFILE_FEEDBACK: mode === "feedback" ? "1" : "0", ZERO_PROFILE_SOURCE: mode === "source" ? "1" : "0" }, stdio: "inherit" })
  const html = readFileSync(path.join(directory, "index.html"), "utf8")
  const script = html.match(/<script[^>]+src="([^"]+)"/u)?.[1]
  if (!script) throw new Error("Missing profiling entry")
  const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/gu)].map(([tag]) => tag + ">")
  return async (page: Page) => {
    await page.route("**/assets/*", (route) => {
      const name = path.basename(new URL(route.request().url()).pathname)
      return route.fulfill({ path: path.join(directory, name),
        contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : undefined })
    })
    await page.route("**/view?*", async (route) => {
      const response = await route.fetch()
      const body = (await response.text()).replace(/<script[^>]+type="module"[^>]*><\/script>/u, `<script type="module" src="${script}"></script>`)
        .replace(/<link[^>]+href="[^"]+\.css"[^>]*>/gu, "")
        .replace("</head>", styles.join("") + "</head>")
      await route.fulfill({ response, body })
    })
  }
}

interface Render {
  id: string
  phase: string
  actualDuration: number
  commitTime: number
}

declare global {
  interface Window { readZeroReactProfile(): Render[] }
}

export async function collectProfiles(page: Page) {
  await page.addInitScript(() => {
    const renders: Render[] = []
    document.addEventListener("zero-profile", (event) => {
      if (!(event instanceof CustomEvent)) return
      const entry: unknown = event.detail
      if (typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string"
        && "phase" in entry && typeof entry.phase === "string" && "actualDuration" in entry && typeof entry.actualDuration === "number"
        && "commitTime" in entry && typeof entry.commitTime === "number") {
        renders.push({ id: entry.id, phase: entry.phase, actualDuration: entry.actualDuration, commitTime: entry.commitTime })
      }
    })
    window.readZeroReactProfile = () => renders.splice(0)
  })
}

export async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  // Include the compositor tail so the trace can carry FRAME_SWAP components.
  await page.waitForTimeout(250)
}

export async function productionSample(session: CDPSession, file: string, action: () => Promise<void>) {
  const events: unknown[] = []
  const collect = (chunk: { value: unknown[] }) => { events.push(...chunk.value) }
  session.on("Tracing.dataCollected", collect)
  await session.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,latencyInfo,benchmark,toplevel", transferMode: "ReportEvents" })
  try {
    const before = await session.send("Performance.getMetrics")
    await action()
    const after = await session.send("Performance.getMetrics")
    return { before: before.metrics, after: after.metrics }
  } finally {
    const complete = new Promise<void>((resolve) => session.once("Tracing.tracingComplete", () => resolve()))
    await session.send("Tracing.end")
    await complete
    session.off("Tracing.dataCollected", collect)
    writeFileSync(file, JSON.stringify({ traceEvents: events }))
  }
}
