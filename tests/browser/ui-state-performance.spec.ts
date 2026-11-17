import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { devices, expect, type CDPSession, type Page, type Request, type TestInfo } from "@playwright/test"

import { test } from "./live-test.ts"
import { gitFixtureRoot } from "./git-fixture.ts"

test.use({ seed: gitFixtureRoot, trace: "off" })

async function attachJSON(info: TestInfo, name: string, body: string) {
  const destination = info.outputPath(name)
  writeFileSync(destination, body)
  await info.attach(name, { path: destination, contentType: "application/json" })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function traceStart(session: CDPSession) {
  await session.send("Performance.enable")
  await session.send("Tracing.start", {
    categories: "devtools.timeline,blink.user_timing,latencyInfo",
    transferMode: "ReturnAsStream",
  })
}

async function traceEnd(session: CDPSession): Promise<string> {
  const complete = new Promise<string>((resolve) => {
    session.once("Tracing.tracingComplete", (event: { stream?: string }) => resolve(event.stream ?? ""))
  })
  await session.send("Tracing.end")
  const handle = await complete
  if (!handle) throw new Error("Missing performance trace stream")
  let trace = ""
  while (true) {
    const chunk: unknown = await session.send("IO.read", { handle })
    if (!record(chunk) || typeof chunk.data !== "string") throw new Error("Invalid trace chunk")
    trace += chunk.data
    if (chunk.eof === true) break
  }
  await session.send("IO.close", { handle })
  return trace
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

async function collectors(page: Page) {
  await page.evaluate(() => {
    const profiles: unknown[] = []
    const events: { name: string; duration: number; processing: number; delay: number }[] = []
    document.addEventListener("zero-profile", (event) => {
      if (event instanceof CustomEvent) profiles.push(event.detail)
    })
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry instanceof PerformanceEventTiming && entry.interactionId) events.push({
          name: entry.name, duration: entry.duration, processing: entry.processingEnd - entry.processingStart,
          delay: entry.processingStart - entry.startTime,
        })
      }
    })
    const options: PerformanceObserverInit & { durationThreshold: number } = { type: "event", durationThreshold: 16 }
    observer.observe(options)
    Reflect.set(window, "readZeroMeasurements", () => ({ profiles: profiles.splice(0), events: events.splice(0) }))
  })
}

async function readMeasurements(page: Page) {
  return page.evaluate((): unknown => {
    const read: unknown = Reflect.get(window, "readZeroMeasurements")
    if (typeof read !== "function") throw new Error("Missing measurement collector")
    return read()
  })
}

test("feature state interaction measurements @extended", async ({ browser, live, browserName }, info) => {
  test.skip(browserName !== "chromium" || process.env.ZERO_BROWSER_EXTENDED !== "1", "Chromium diagnostic measurements")
  test.setTimeout(900_000)
  writeFileSync(path.join(live.root, "ownership-large.ts"), Array.from({ length: 10_000 }, (_, index) =>
    `export const line${index} = "${index % 1000 === 0 ? "ownership-needle" : "stable source text"}"\n`).join(""))
  const profileDirectory = path.resolve(".dev/ui-state-profile")
  mkdirSync(profileDirectory, { recursive: true })
  const reports: unknown[] = []
  const save = () => writeFileSync(info.outputPath("ui-state-measurements.json"), JSON.stringify({
    browser: browser.version(), viewport: [1440, 900], lines: 10_000, query: "ownership-needle", delay: 50, reports,
  }))
  const pending = new Set<Request>()
  const settled = async (page: Page) => {
    await expect.poll(() => pending.size, { timeout: 30_000 }).toBe(0)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.poll(() => pending.size, { timeout: 30_000 }).toBe(0)
  }
  try {
    const built = spawnSync(process.execPath, ["apps/web/node_modules/vite/bin/vite.js", "build", "--configLoader", "native",
      "--config", "apps/web/test-fixtures/profile.config.ts", "--outDir", profileDirectory, "--logLevel", "warn"], { encoding: "utf8" })
    expect(built.status, built.stderr).toBe(0)
    const profileHTML = readFileSync(path.join(profileDirectory, "index.html"), "utf8")
    const script = profileHTML.match(/<script[^>]+src="([^"]+)"/u)?.[1]
    if (!script) throw new Error("Missing profiling entry")
    const styles = [...profileHTML.matchAll(/<link[^>]+href="([^"]+\.css)"/gu)].map((match) => match[1]).filter((value) => value !== undefined)
    const url = `${live.origin}/view?project=${encodeURIComponent(live.root)}&path=ownership-large.ts`
    for (const profiling of [false, true]) {
      for (let run = 0; run < 5; run++) {
        // Bound each repetition's renderer lifetime, including profiling data
        // and the large document's DOM. Every sample warms its own corpus.
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 }, userAgent: devices["Desktop Chrome"].userAgent,
        })
        try {
          const page = await context.newPage()
          pending.clear()
          page.on("request", (request) => {
            const pathname = new URL(request.url()).pathname
            if (pathname.startsWith("/api/") && pathname !== "/api/events" && pathname !== "/api/presence") pending.add(request)
          })
          page.on("requestfinished", (request) => pending.delete(request))
          page.on("requestfailed", (request) => pending.delete(request))
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
          await page.goto(url)
          await expect(page.locator(".source-document-line")).toHaveCount(10_000)
          // Find in Files initializes the corpus; selecting the activity alone
          // only reveals the panel in the original implementation.
          const corpus = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/search-documents")
          await page.keyboard.press("ControlOrMeta+Shift+f")
          expect((await corpus).ok()).toBe(true)
          const input = page.getByRole("textbox", { name: "Search", exact: true })
          await input.fill("ownership-needle")
          await expect(page.getByRole("tree", { name: "Search results" })).toBeVisible({ timeout: 30_000 })
          await expect(page.getByRole("tree", { name: "Search results" })).toHaveAttribute("aria-busy", "false")
          await expect(page.locator(".source-document-line-content span").first()).toBeAttached({ timeout: 30_000 })
          await input.clear()
          await settled(page)
          await collectors(page)
          const session = await page.context().newCDPSession(page)
          await session.send("Performance.enable")
          if (!profiling) await traceStart(session)
          const before = await metrics(session)
          await input.pressSequentially("ownership-needle", { delay: 50 })
          await expect(page.locator(".search-message")).toContainText("10 results", { timeout: 30_000 })
          await expect(page.getByRole("tree", { name: "Search results" })).toHaveAttribute("aria-busy", "false", { timeout: 30_000 })
          // Event Timing entries are delivered after presentation; no concurrent I/O.
          await page.waitForTimeout(250)
          const after = await metrics(session)
          const measured = await readMeasurements(page)
          const report = { profiling, run, scenario: "search", before, after, measured }
          reports.push(report)
          save()
          if (!profiling) await attachJSON(info, `search-${run}.trace.json`, await traceEnd(session))

          await page.getByRole("button", { name: /^Source Control/ }).click()
          const scm = page.getByRole("region", { name: "Source Control", exact: true })
          await expect(scm.getByRole("button", { name: /^Commits/ })).toBeVisible()
          await expect(scm.getByRole("listbox", { name: "Commits", exact: true })).toBeVisible()
          await expect(scm.getByRole("listbox", { name: "Branches", exact: true })).toBeVisible()
          await expect(scm.locator(".changes-row-stats").first()).toBeVisible()
          await expect(scm.locator(".ui-progress")).not.toHaveAttribute("data-active", "true")
          await settled(page)
          await readMeasurements(page)
          if (!profiling) await traceStart(session)
          const layoutBefore = await metrics(session)
          for (let change = 0; change < 4; change++) await scm.getByRole("button", { name: /^Commits/ }).click()
          await scm.getByRole("button", { name: "View as Tree" }).click()
          await scm.getByRole("button", { name: "View as List" }).click()
          const sash = scm.getByRole("separator", { name: "Resize Uncommitted and Commits", exact: true })
          await sash.press("ArrowDown")
          await sash.press("ArrowUp")
          await page.waitForTimeout(250)
          reports.push({ profiling, run, scenario: "panes", before: layoutBefore, after: await metrics(session), measured: await readMeasurements(page) })
          save()
          if (!profiling) await attachJSON(info, `panes-${run}.trace.json`, await traceEnd(session))

          await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&review=branch`)
          const rail = page.getByRole("complementary", { name: "Review files", exact: true })
          await expect(rail.getByRole("treeitem").first()).toBeVisible()
          await expect(page.locator(".diff-view").first()).toBeAttached()
          await settled(page)
          await collectors(page)
          await page.waitForTimeout(250)
          await readMeasurements(page)
          if (!profiling) await traceStart(session)
          const railBefore = await metrics(session)
          const railSash = rail.getByRole("separator", { name: "Resize review files", exact: true })
          await railSash.press("ArrowLeft")
          await railSash.press("ArrowRight")
          await rail.getByRole("button", { name: "Hide viewed files", exact: true }).click()
          await rail.getByRole("button", { name: "Hide viewed files", exact: true }).click()
          await page.getByRole("button", { name: "Files", exact: true }).click()
          await page.getByRole("button", { name: "Files", exact: true }).click()
          await page.waitForTimeout(250)
          reports.push({ profiling, run, scenario: "rail", before: railBefore, after: await metrics(session), measured: await readMeasurements(page) })
          save()
          if (!profiling) await attachJSON(info, `rail-${run}.trace.json`, await traceEnd(session))
          await session.detach()
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    save()
    await info.attach("ui-state-measurements.json", { path: info.outputPath("ui-state-measurements.json"), contentType: "application/json" })
    rmSync(profileDirectory, { recursive: true, force: true })
  }
})
