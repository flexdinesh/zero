import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { devices, expect, type CDPSession, type ElementHandle, type Page, type Request, type TestInfo } from "@playwright/test"

import { test } from "./live-test.ts"
import { gitFixtureRoot } from "./git-fixture.ts"
import { resizeBox } from "./resize.ts"

test.use({ seed: gitFixtureRoot, trace: "off", screenshot: "off" })

const cadence = 16
const steps = 24
const repetitions = 5
const workloads = ["source", "review", "diagrams"]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function artifact(info: TestInfo, name: string, body: string) {
  const destination = info.outputPath(name)
  writeFileSync(destination, body)
  await info.attach(name, { path: destination, contentType: "application/json" })
}

async function traceEnd(session: CDPSession): Promise<string> {
  const complete = new Promise<string>((resolve) => {
    session.once("Tracing.tracingComplete", (event: unknown) => {
      resolve(record(event) && typeof event.stream === "string" ? event.stream : "")
    })
  })
  await session.send("Tracing.end")
  const handle = await complete
  if (!handle) throw new Error("Missing performance trace stream")
  let trace = ""
  try {
    for (;;) {
      const chunk: unknown = await session.send("IO.read", { handle })
      if (!record(chunk) || typeof chunk.data !== "string") throw new Error("Invalid performance trace chunk")
      trace += chunk.data
      if (chunk.eof === true) return trace
    }
  } finally {
    await session.send("IO.close", { handle })
  }
}

async function metrics(session: CDPSession) {
  const result: unknown = await session.send("Performance.getMetrics")
  if (!record(result) || !Array.isArray(result.metrics)) throw new Error("Invalid performance metrics")
  const values: Record<string, number> = {}
  for (const entry of result.metrics) {
    const metric: unknown = entry
    if (record(metric) && typeof metric.name === "string" && typeof metric.value === "number") values[metric.name] = metric.value
  }
  return values
}

async function collectors(page: Page) {
  await page.evaluate(() => {
    const profiles: unknown[] = []
    const longTasks: { start: number; duration: number }[] = []
    const pointers: { name: string; time: number; x: number; y: number; buttons: number; trusted: boolean }[] = []
    const writes: { key: string; value: string; time: number; phase: string }[] = []
    let phase = "idle"
    document.addEventListener("zero-profile", (event) => {
      if (event instanceof CustomEvent) profiles.push(event.detail)
    })
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })))
    })
    observer.observe({ type: "longtask" })
    for (const name of ["pointerdown", "pointermove", "pointerup"]) document.addEventListener(name, (event) => {
      if (!(event instanceof PointerEvent)) return
      if (name === "pointerdown") phase = "pressed"
      if (name === "pointerup") phase = "released"
      if (event.buttons === 1 || name === "pointerup") pointers.push({
        name, time: event.timeStamp, x: event.clientX, y: event.clientY, buttons: event.buttons, trusted: event.isTrusted,
      })
    }, true)
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage) writes.push({ key, value, time: performance.now(), phase })
      return setItem.call(this, key, value)
    }
    Reflect.set(window, "readResizeMeasurements", () => {
      longTasks.push(...observer.takeRecords().map((entry) => ({ start: entry.startTime, duration: entry.duration })))
      phase = "idle"
      return { profiles: profiles.splice(0), longTasks: longTasks.splice(0), pointers: pointers.splice(0), writes: writes.splice(0) }
    })
  })
}

async function readMeasurements(page: Page) {
  return page.evaluate((): unknown => {
    const read: unknown = Reflect.get(window, "readResizeMeasurements")
    if (typeof read !== "function") throw new Error("Missing resize measurement collector")
    return read()
  })
}

function requests(page: Page) {
  const pending = new Set<Request>()
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith("/api/") && pathname !== "/api/events" && pathname !== "/api/presence") pending.add(request)
  })
  page.on("requestfinished", (request) => pending.delete(request))
  page.on("requestfailed", (request) => pending.delete(request))
  return async () => {
    await expect.poll(() => pending.size, { timeout: 30_000 }).toBe(0)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.poll(() => pending.size, { timeout: 30_000 }).toBe(0)
  }
}

async function drag(page: Page, separator: ElementHandle<HTMLElement | SVGElement>, box: { x: number; y: number; width: number; height: number },
  initialValue: string | null, axis: "x" | "y", distance: number) {
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  try {
    // Two fixed native paths. Processing time adds to the configured cadence;
    // retain trusted event timestamps instead of assuming a 60 Hz input rate.
    for (const direction of [1, -1]) {
      for (let step = 1; step <= steps; step++) {
        const offset = distance * (direction === 1 ? step / steps : 1 - step / (steps * 2))
        await page.mouse.move(start.x + (axis === "x" ? offset : 0), start.y + (axis === "y" ? offset : 0))
        await page.waitForTimeout(cadence)
      }
      if (direction === 1) expect(await separator.getAttribute("aria-valuenow"), "drag must resize the real separator").not.toBe(initialValue)
    }
  } finally {
    await page.mouse.up()
  }
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("")
  expect(await separator.evaluate((element) => element.isConnected), "the active separator must retain its identity").toBe(true)
  expect(await separator.getAttribute("aria-valuenow"), "drag must retain its final size").not.toBe(initialValue)
  return { start, axis, distance, initialValue, finalValue: await separator.getAttribute("aria-valuenow") }
}

test("layout resize production and React measurements @extended", async ({ browser, live, browserName }, info) => {
  test.skip(browserName !== "chromium" || process.env.ZERO_BROWSER_EXTENDED !== "1" || process.env.ZERO_BROWSER_PRODUCTION_ONLY !== "1",
    "Run this isolated production capture with --production-only --workers=1")
  test.setTimeout(1_200_000)
  const source = Array.from({ length: 10_000 }, (_, index) => `export const line${index} = "stable resize source text"\n`).join("")
  const diagrams = Array.from({ length: 12 }, (_, index) => `\`\`\`mermaid\nflowchart LR\nA${index}[Start] --> B${index}{Ready?}\nB${index} --> C${index}[Render]\nB${index} --> D${index}[Wait]\n\`\`\``).join("\n\n")
  writeFileSync(path.join(live.root, "resize-large.ts"), source)
  writeFileSync(path.join(live.root, "resize-diagrams.md"), `# Resize diagrams\n\n${diagrams}\n`)
  expect(readFileSync(path.join(live.root, "large.txt"), "utf8").trimEnd().split("\n")).toHaveLength(24_000)
  const profileDirectory = mkdtempSync(path.join(tmpdir(), "zero-layout-profile-"))
  const reports: unknown[] = []
  const save = () => writeFileSync(info.outputPath("layout-resize-measurements.json"), JSON.stringify({
    browser: browser.version(), viewport: [1440, 900], sourceLines: 10_000, reviewLines: 24_000, diagrams: 12,
    cadence, steps, repetitions, reports,
    memoryLimit: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
    cpuLimit: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
    memoryEvents: readFileSync("/sys/fs/cgroup/memory.events", "utf8"),
  }))
  try {
    const built = spawnSync(process.execPath, ["apps/web/node_modules/vite/bin/vite.js", "build", "--configLoader", "native",
      "--config", "apps/web/test-fixtures/profile.config.ts", "--outDir", profileDirectory, "--logLevel", "warn"], { encoding: "utf8" })
    expect(built.status, built.stderr).toBe(0)
    const profileHTML = readFileSync(path.join(profileDirectory, "index.html"), "utf8")
    const script = profileHTML.match(/<script[^>]+src="([^"]+)"/u)?.[1]
    if (!script) throw new Error("Missing profiling entry")
    const styles = [...profileHTML.matchAll(/<link[^>]+href="([^"]+\.css)"/gu)].map((match) => match[1]).filter((value) => value !== undefined)
    for (const profiling of [false, true]) for (let run = 0; run < repetitions; run++) for (const workload of workloads) {
      // One fresh context per workload and repetition. No renderer retains
      // previous repetitions' source DOM, diagrams, diffs or profiler records.
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: devices["Desktop Chrome"].userAgent })
      try {
        await context.addInitScript((project) => sessionStorage.setItem(`zero-preview:${project}`, "1"), live.root)
        const page = await context.newPage()
        const settled = requests(page)
        if (profiling) {
          await page.route("**/assets/*", async (route) => {
            const name = path.basename(new URL(route.request().url()).pathname)
            const contentType = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : undefined
            await route.fulfill({ path: path.join(profileDirectory, name), contentType })
          })
          await page.route("**/view?*", async (route) => {
            const response = await route.fetch()
            const html = (await response.text()).replace(/<script[^>]+type="module"[^>]*><\/script>/u, `<script type="module" src="${script}"></script>`)
              .replace(/<link[^>]+href="[^"]+\.css"[^>]*>/gu, "")
            await route.fulfill({ response, body: html.replace("</head>", `${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}</head>`) })
          })
        }
        const target = workload === "review" ? "review=branch&uncommitted=1#f=large.txt" : `path=${workload === "source" ? "resize-large.ts" : "resize-diagrams.md"}`
        await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&${target}`)
        if (workload === "source") {
          await expect(page.locator(".source-document-line")).toHaveCount(10_000)
          await expect(page.locator(".source-document-line-content span").first()).toBeAttached({ timeout: 30_000 })
        } else if (workload === "review") {
          const rail = page.getByRole("complementary", { name: "Review files", exact: true })
          await expect(rail.getByRole("treeitem").first()).toBeVisible()
          await expect(page.getByRole("region", { name: "large.txt", exact: true }).locator(".diff-view [data-line-type]").first()).toBeVisible({ timeout: 30_000 })
        } else {
          await expect(page.getByRole("heading", { name: "Resize diagrams" })).toBeVisible()
          await expect(page.locator(".mermaid-lazy")).toHaveCount(12)
          for (let index = 0; index < 12; index++) {
            await page.locator(".mermaid-lazy").nth(index).scrollIntoViewIfNeeded()
            await expect(page.locator(".mermaid-lazy").nth(index).locator(".mermaid-svg > svg.ondine")).toBeAttached({ timeout: 30_000 })
          }
          await page.getByRole("heading", { name: "Resize diagrams" }).scrollIntoViewIfNeeded()
          await expect(page.locator(".mermaid-svg > svg.ondine")).toHaveCount(12)
        }
        await page.getByRole("button", { name: /^Source Control/ }).click()
        const scm = page.getByRole("region", { name: "Source Control", exact: true })
        await expect(scm.getByRole("listbox", { name: "Commits", exact: true })).toBeVisible()
        await expect(scm.getByRole("listbox", { name: "Branches", exact: true })).toBeVisible()
        await expect(scm.locator(".changes-row-stats").first()).toBeVisible()
        await expect(scm.locator(".ui-progress")).not.toHaveAttribute("data-active", "true")
        await settled()
        // Include deferred width compilation in warm-up, then in every tail.
        await page.waitForTimeout(400)
        await collectors(page)
        const session = await context.newCDPSession(page)
        await session.send("Performance.enable")
        const scenarios = [
          { name: "sidebar", separator: page.getByRole("separator", { name: "Resize file tree", exact: true }), axis: "x", distance: 120 },
          { name: "working-commits", separator: scm.getByRole("separator", { name: "Resize Uncommitted and Commits", exact: true }), axis: "y", distance: 60 },
          { name: "commits-branches", separator: scm.getByRole("separator", { name: "Resize Commits and Branches", exact: true }), axis: "y", distance: 60 },
          ...(workload === "review" ? [{ name: "rail", separator: page.getByRole("separator", { name: "Resize review files", exact: true }), axis: "x", distance: -120 }] : []),
        ]
        for (const scenario of scenarios) {
          if (scenario.axis !== "x" && scenario.axis !== "y") throw new Error("Invalid resize axis")
          await expect(scenario.separator).toBeVisible()
          await settled()
          await readMeasurements(page)
          // Resolve accessibility selectors and geometry before timing. Repeating
          // a whole-document role query beside 10,000 Source rows measures the
          // automation selector engine rather than the resize interaction.
          const separator = await scenario.separator.elementHandle()
          if (!separator) throw new Error("Missing resize separator")
          const box = await resizeBox(scenario.separator)
          const initialValue = await separator.getAttribute("aria-valuenow")
          if (!profiling) await session.send("Tracing.start", {
            categories: "devtools.timeline,v8,blink.user_timing,toplevel,latencyInfo,benchmark", transferMode: "ReturnAsStream",
          })
          const before = await metrics(session)
          await page.evaluate(() => performance.mark("layout-resize-start"))
          const path = await drag(page, separator, box, initialValue, scenario.axis, scenario.distance)
          await page.waitForTimeout(400)
          await settled()
          await page.evaluate(() => performance.mark("layout-resize-end"))
          const after = await metrics(session)
          const measured = await readMeasurements(page)
          reports.push({ profiling, run, workload, scenario: scenario.name, path, before, after, measured })
          save()
          if (!profiling) await artifact(info, `${workload}-${scenario.name}-${run}.trace.json`, await traceEnd(session))
        }
        await session.detach()
      } finally {
        await context.close()
      }
    }
  } finally {
    save()
    await info.attach("layout-resize-measurements.json", { path: info.outputPath("layout-resize-measurements.json"), contentType: "application/json" })
    rmSync(profileDirectory, { recursive: true, force: true })
  }
})
