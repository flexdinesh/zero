import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect, type CDPSession, type Page } from "@playwright/test"
import type { NavigationStatus } from "../../packages/contracts/src/index.ts"

import { test } from "./live-test.ts"

test.use({ trace: "off", screenshot: "off" })

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function metrics(session: CDPSession) {
  const result: unknown = await session.send("Performance.getMetrics")
  if (!record(result) || !Array.isArray(result.metrics)) throw new Error("Invalid performance metrics")
  const values: Record<string, number> = {}
  for (const value of result.metrics) {
    const metric: unknown = value
    if (record(metric) && typeof metric.name === "string" && typeof metric.value === "number") values[metric.name] = metric.value
  }
  return values
}

async function traceEnd(session: CDPSession) {
  const complete = new Promise<string>((resolve) => {
    session.once("Tracing.tracingComplete", (event: { stream?: string }) => resolve(event.stream ?? ""))
  })
  await session.send("Tracing.end")
  const handle = await complete
  if (!handle) throw new Error("Missing performance trace stream")
  let trace = ""
  try {
    for (;;) {
      const chunk: unknown = await session.send("IO.read", { handle })
      if (!record(chunk) || typeof chunk.data !== "string") throw new Error("Invalid trace chunk")
      trace += chunk.data
      if (chunk.eof === true) return trace
    }
  } finally {
    await session.send("IO.close", { handle })
  }
}

async function readProfiles(page: Page) {
  return page.evaluate((): unknown => {
    const read: unknown = Reflect.get(window, "readPollProfiles")
    if (typeof read !== "function") throw new Error("Missing profile collector")
    return read()
  })
}

const ready: NavigationStatus = {
  supported: true, enabled: true, eligible: true, reason: "",
  server: { name: "TypeScript", language: "TypeScript", state: "ready", message: "", install: [], docs: "",
    memory: 32 * 1024 * 1024, idleMinutes: 10, capabilities: { definition: true, references: true } },
}

test("unchanged polling Source measurements @extended", async ({ browser, browserName, live }, info) => {
  test.skip(browserName !== "chromium", "Production CDP and separate React profiling")
  test.setTimeout(900_000)
  writeFileSync(path.join(live.root, "poll-large.ts"), Array.from({ length: 10_000 }, (_, index) => `export const line${index} = "stable source text"`).join("\n"))
  const profileDirectory = path.resolve(".dev/idle-poll-profile")
  mkdirSync(profileDirectory, { recursive: true })
  const reports: unknown[] = []
  const save = () => writeFileSync(info.outputPath("idle-poll-measurements.json"), JSON.stringify({
    browser: browser.version(), viewport: [1440, 900], lines: 10_000, idleMS: 15_000,
    protocol: "5 fresh contexts/build; unchanged controlled walkthrough and ready LSP responses; real timers; 16 ArrowDown inputs spaced 1000ms",
    limitations: "Headless Chromium; controlled status/list responses, no real LSP process; host load uncontrolled; trace input latency is not field INP",
    reports,
  }, null, 2))
  try {
    const built = spawnSync(process.execPath, ["apps/web/node_modules/vite/bin/vite.js", "build", "--configLoader", "native",
      "--config", "apps/web/test-fixtures/profile.config.ts", "--outDir", profileDirectory, "--logLevel", "warn"], { encoding: "utf8" })
    expect(built.status, built.stderr).toBe(0)
    const html = readFileSync(path.join(profileDirectory, "index.html"), "utf8")
    const script = html.match(/<script[^>]+src="([^"]+)"/u)?.[1]
    if (!script) throw new Error("Missing profiling entry")
    const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/gu)].map((match) => match[1]).filter((value) => value !== undefined)
    for (const profiling of [false, true]) for (let run = 0; run < 5; run++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      try {
        const page = await context.newPage()
        let walkthroughs = 0
        let navigation = 0
        await page.route("**/api/walkthroughs?*", async (route) => { await route.fulfill({ json: [] }); walkthroughs++ })
        await page.route("**/api/navigation-status?*", async (route) => { await route.fulfill({ json: ready }); navigation++ })
        if (profiling) {
          await page.route("**/assets/*", async (route) => {
            const name = path.basename(new URL(route.request().url()).pathname)
            await route.fulfill({ path: path.join(profileDirectory, name), contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : undefined })
          })
          await page.route("**/view?*", async (route) => {
            const response = await route.fetch()
            const body = (await response.text()).replace(/<script[^>]+type="module"[^>]*><\/script>/u, `<script type="module" src="${script}"></script>`)
              .replace(/<link[^>]+href="[^"]+\.css"[^>]*>/gu, "")
            await route.fulfill({ response, body: body.replace("</head>", `${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}</head>`) })
          })
        }
        await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=poll-large.ts`)
        await expect(page.locator(".source-document-line")).toHaveCount(10_000)
        await expect(page.locator(".source-document-line-content span").first()).toBeAttached()
        await expect(page.getByText("LSP ready", { exact: true })).toBeVisible()
        await expect.poll(() => walkthroughs).toBeGreaterThan(0)
        await page.waitForTimeout(1000)
        expect(await page.evaluate(() => [...document.scripts].some((entry) => entry.src.includes("/@vite/client")))).toBe(false)
        await page.evaluate(() => {
          const profiles: unknown[] = []
          document.addEventListener("zero-profile", (event) => { if (event instanceof CustomEvent) profiles.push(event.detail) })
          Reflect.set(window, "readPollProfiles", () => profiles.splice(0))
        })
        const session = await context.newCDPSession(page)
        await session.send("Performance.enable")
        for (const scenario of ["idle", "keys"]) {
          if (scenario === "keys") await page.getByRole("textbox", { name: "TypeScript source" }).focus()
          await readProfiles(page)
          if (!profiling) await session.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,latencyInfo", transferMode: "ReturnAsStream" })
          const counts = { walkthroughs, navigation }
          const before = await metrics(session)
          if (scenario === "idle") await page.waitForTimeout(15_000)
          else for (let key = 0; key < 16; key++) { await page.keyboard.press("ArrowDown"); await page.waitForTimeout(1000) }
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
          const report = { profiling, run, scenario, before, after: await metrics(session),
            polls: { walkthroughs: walkthroughs - counts.walkthroughs, navigation: navigation - counts.navigation }, measured: await readProfiles(page) }
          reports.push(report)
          save()
          if (!profiling) writeFileSync(info.outputPath(`${scenario}-${run}.trace.json`), await traceEnd(session))
          expect(report.polls.walkthroughs).toBeGreaterThanOrEqual(2)
          expect(report.polls.navigation).toBeGreaterThanOrEqual(4)
        }
        await session.detach()
      } finally { await context.close() }
    }
  } finally { save(); rmSync(profileDirectory, { recursive: true, force: true }) }
})
