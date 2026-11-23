import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import path from "node:path"

import { expect, type BrowserContext, type Page, type Request } from "@playwright/test"

import { collectProfiles, productionSample, settle } from "./feedback-profile-capture.ts"
import { gitFixtureRoot } from "./git-fixture.ts"
import { test } from "./live-test.ts"

const repetitions = 5
const viewport = { width: 1440, height: 900 }
const sourceFile = "src/app.ts"
const welcome = "main .welcome-title"
const sourceToken = "[data-line='1'] .hl-keyword"
const source = `.source-document ${sourceToken}`
const review = `[data-review-path="${sourceFile}"] .diff-view >>> [data-line-type="change-addition"]`
const scenarios = [
  { name: "welcome", ready: welcome },
  { name: "source", ready: source },
  { name: "first-review", ready: review, from: source },
  { name: "first-project-picker", ready: '#project-results [role="option"]', from: welcome },
  { name: "first-settings", ready: '[aria-label="Settings categories"]', from: welcome },
  { name: "first-report-problem", ready: '[aria-label="Problem report"]', from: welcome },
]

type Scenario = typeof scenarios[number]
type Readiness = { selector: string; input: boolean; mark: string }

// Executed in the browser at document start or armed immediately before a click.
function watchReady({ selector, input, mark }: Readiness) {
  const [outer, inner] = selector.split(" >>> ")
  const check = () => {
    const host = document.querySelector(outer)
    const node = inner ? host?.shadowRoot?.querySelector(inner) : host
    const bounds = node?.getBoundingClientRect()
    if (!node?.checkVisibility({ visibilityProperty: true }) || !bounds?.width || !bounds.height
      || bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= innerHeight || bounds.left >= innerWidth) {
      requestAnimationFrame(check)
      return
    }
    requestAnimationFrame(() => performance.mark(mark))
  }
  if (input) document.addEventListener("pointerdown", (event) => {
    performance.mark("bundle-input", { startTime: event.timeStamp })
    check()
  }, { capture: true, once: true })
  else requestAnimationFrame(check)
}

async function actionFor(page: Page, scenario: Scenario) {
  switch (scenario.name) {
    case "first-review": {
      await page.getByRole("button", { name: /^Source Control, / }).click()
      const row = page.getByRole("listbox", { name: "Uncommitted changes" }).getByRole("option", { name: /^src\/app\.ts, / })
      await expect(row).toBeVisible()
      return row
    }
    case "first-project-picker":
      return page.getByRole("complementary", { name: "Files" }).getByRole("button", { name: /Switch project/ })
    case "first-settings":
      return page.getByRole("button", { name: "Settings", exact: true })
    case "first-report-problem":
      return page.getByRole("main").getByRole("button", { name: "Report a problem…" })
  }
}

async function confirmReady(page: Page, scenario: Scenario) {
  switch (scenario.name) {
    case "welcome":
      await expect(page.getByRole("tab", { name: "Welcome" })).toHaveAttribute("aria-selected", "true")
      await expect(page.getByRole("main").getByRole("heading", { name: "Zero", level: 1 })).toBeVisible()
      break
    case "source":
      await expect(page.getByRole("textbox", { name: "TypeScript source" }).locator(sourceToken).first()).toBeVisible()
      break
    case "first-review":
      await expect(page.getByRole("region", { name: sourceFile, exact: true })
        .locator('.diff-view [data-line-type="change-addition"]').first()).toBeInViewport()
      break
    case "first-project-picker":
      await expect(page.getByRole("dialog", { name: "Switch project" }).getByRole("option").first()).toBeVisible()
      break
    case "first-settings":
      await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("navigation", { name: "Settings categories" })).toBeVisible()
      break
    case "first-report-problem":
      await expect(page.getByRole("dialog", { name: "Report a Problem" }).getByLabel("Problem report", { exact: true })).toContainText("## zero problem report")
  }
}

function recordAssets(context: BrowserContext, origin: string) {
  const observed: Request[] = []
  context.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === origin && url.pathname.startsWith("/assets/")) observed.push(request)
  })
  return async (start: number, end: number) => {
    const assets = await Promise.all(observed.filter((request) => {
      const time = request.timing().startTime
      return time >= start && time <= end
    }).map(async (request) => {
      const response = await request.response()
      if (!response) throw new Error(`Asset request failed: ${request.url()}`)
      expect(response.ok() || response.status() === 304, request.url()).toBe(true)
      const { responseBodySize, responseHeadersSize } = await request.sizes()
      const file = new URL(request.url()).pathname.slice("/assets/".length)
      return { file, kind: path.extname(file), status: response.status(), resourceType: request.resourceType(),
        startMs: request.timing().startTime - start, bodyBytes: responseBodySize,
        transferredBytes: responseBodySize + responseHeadersSize, encoding: await response.headerValue("content-encoding") }
    }))
    return {
      requests: assets.length,
      bodyBytes: assets.reduce((sum, asset) => sum + asset.bodyBytes, 0),
      transferredBytes: assets.reduce((sum, asset) => sum + asset.transferredBytes, 0),
      assets,
    }
  }
}

async function timings(page: Page) {
  return page.evaluate(() => {
    function mark(name: string) { return performance.getEntriesByName(name, "mark")[0]?.startTime }
    const input = mark("bundle-input")
    const ready = mark("bundle-ready")
    const end = mark("bundle-end")
    if (ready === undefined || end === undefined) throw new Error("Missing performance marks")
    return { timeOrigin: performance.timeOrigin, input, ready, end, readyMs: ready - (input ?? 0),
      firstPaintMs: performance.getEntriesByName("first-paint", "paint")[0]?.startTime,
      firstContentfulPaintMs: performance.getEntriesByName("first-contentful-paint", "paint")[0]?.startTime }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function traceMetrics(file: string, timing: Awaited<ReturnType<typeof timings>>) {
  const trace: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (!isRecord(trace) || !Array.isArray(trace.traceEvents)) throw new Error("Missing trace events")
  const events = trace.traceEvents.filter(isRecord)
  const ready = events.find(({ name }) => name === "bundle-ready")
  const end = events.find(({ name }) => name === "bundle-end")
  if (typeof ready?.ts !== "number" || typeof end?.ts !== "number") throw new Error("Missing trace marks")
  const startUs = ready.ts - timing.readyMs * 1000
  const endUs = end.ts
  const renderer = events.filter((event) => event.pid === ready.pid && event.tid === ready.tid)
  function duration(names: string[]) {
    // Chrome timeline events nest. Count the union so script execution and its
    // callbacks, or nested style/layout events, are never summed twice.
    const intervals = renderer.flatMap(({ name, ph, ts, dur }) => {
      if (ph !== "X" || typeof name !== "string" || !names.includes(name) || typeof ts !== "number" || typeof dur !== "number") return []
      const start = Math.max(startUs, ts)
      const end = Math.min(endUs, ts + dur)
      return start < end ? [{ start, end }] : []
    }).sort((a, b) => a.start - b.start)
    let coveredUntil = startUs
    let total = 0
    for (const { start, end } of intervals) {
      total += Math.max(0, end - Math.max(start, coveredUntil))
      coveredUntil = Math.max(end, coveredUntil)
    }
    return total / 1000
  }
  const eventTiming = renderer.filter(({ name, ts }) => name === "EventTiming" && typeof ts === "number" && ts >= startUs && ts <= endUs)
  return {
    scriptingMs: duration(["EvaluateScript", "EvaluateModule", "FunctionCall", "v8.compile", "v8.run", "RunMicrotasks", "EventDispatch"]),
    styleLayoutMs: duration(["UpdateLayoutTree", "Layout", "RecalculateStyles"]),
    paintMs: duration(["PrePaint", "Paint", "CompositeLayers", "Layerize"]),
    eventTiming,
  }
}

function serveProfilingBuild(directory: string) {
  execFileSync(process.execPath, ["apps/web/node_modules/vite/bin/vite.js", "build", "--configLoader", "native",
    "--config", "apps/web/test-fixtures/bundle-profile.config.ts", "--outDir", directory, "--logLevel", "warn"], { stdio: "inherit" })
  const shell = readFileSync(path.join(directory, "index.html"), "utf8")
  return async (page: Page, origin: string) => {
    await page.route(`${origin}/assets/**`, (route) => {
      const file = path.basename(new URL(route.request().url()).pathname)
      const contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css"
        : file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".woff2") ? "font/woff2" : undefined
      return route.fulfill({ path: path.join(directory, file), contentType })
    })
    await page.route(`${origin}/**`, async (route) => {
      if (!route.request().isNavigationRequest()) return route.fallback()
      // The shell embeds no data (decision 0192): keep the server's headers.
      const response = await route.fetch()
      await route.fulfill({ response, body: shell })
    })
  }
}

test.use({ seed: gitFixtureRoot, trace: "off", screenshot: "off" })

test("bundle boundaries production and React profiling @extended", async ({ browser, browserName, live }, info) => {
  test.skip(browserName !== "chromium", "Chromium CDP and Event Timing capture")
  test.setTimeout(600_000)
  const profileDir = mkdtempSync(path.join(tmpdir(), "zero-bundle-profile-"))
  const reports: unknown[] = []
  const save = () => writeFileSync(info.outputPath("bundle-boundaries-measurements.json"), JSON.stringify({
    revision: process.env.ZERO_BUNDLE_REVISION,
    browser: browser.version(), node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
    fixture: "live copy of tests/browser/git-fixture.ts, one Go server for the run",
    extendedFixture: process.env.ZERO_BROWSER_EXTENDED === "1", sourceFile, viewport, repetitions,
    protocol: "Five fresh Chromium contexts per build and scenario. Cold navigation starts at the document time origin. First-open samples start at trusted pointerdown from an already settled Source or Welcome; review also prepares the Uncommitted list. Readiness marks the frame after the named content becomes visible. The trace includes two animation frames and a 250 ms tail. Network covers actual same-origin /assets/ responses, including worker requests visible to Playwright. Profiling uses the same API endpoints with a separately built profiling React root.",
    reports,
  }, null, 2))
  try {
    // Finish production measurements before building or loading any profiler.
    for (const build of ["production", "profiling"]) {
      const serveProfile = build === "profiling" ? serveProfilingBuild(profileDir) : undefined
      for (const scenario of scenarios) for (let run = 1; run <= repetitions; run++) {
        const context = await browser.newContext({ viewport })
        try {
          const page = await context.newPage()
          const assets = recordAssets(context, live.origin)
          if (serveProfile) {
            await serveProfile(page, live.origin)
            await collectProfiles(page)
          }
          const from = scenario.from
          const url = new URL(from === source || scenario.ready === source ? "/view" : "/", live.origin)
          url.searchParams.set("project", live.root)
          if (url.pathname === "/view") url.searchParams.set("path", sourceFile)
          const open = async () => {
            const response = await page.goto(url.href, { waitUntil: "domcontentloaded" })
            expect(response?.ok()).toBe(true)
            await expect(page.locator('script[src*="/@vite/client"]')).toHaveCount(0)
            await expect(page.locator('script[type="module"][src^="/assets/"]')).toHaveCount(1)
          }
          if (from) {
            await page.addInitScript(watchReady, { selector: from, input: false, mark: "bundle-setup-ready" })
            await open()
            await page.waitForFunction(() => performance.getEntriesByName("bundle-setup-ready").length > 0, undefined, { timeout: 15_000 })
          } else {
            await page.addInitScript(watchReady, { selector: scenario.ready, input: false, mark: "bundle-ready" })
          }
          const target = await actionFor(page, scenario)
          if (target) {
            await expect(target).toBeVisible()
            await settle(page)
            if (serveProfile) {
              const setupRenders = await page.evaluate(() => window.readZeroReactProfile())
              expect(setupRenders.some(({ phase }) => phase === "mount")).toBe(true)
            }
          }
          const action = async () => {
            if (target) {
              await page.evaluate(watchReady, { selector: scenario.ready, input: true, mark: "bundle-ready" })
              await target.click()
            } else await open()
            await page.waitForFunction(() => performance.getEntriesByName("bundle-ready").length > 0, undefined, { timeout: 15_000 })
            await confirmReady(page, scenario)
            await settle(page)
            await page.evaluate(() => performance.mark("bundle-end"))
          }
          if (serveProfile) {
            await action()
            const timing = await timings(page)
            const renders = await page.evaluate(() => window.readZeroReactProfile())
            // An already-mounted native dialog can open with zero React work.
            if (!target) expect(renders.some(({ phase }) => phase === "mount")).toBe(true)
            reports.push({ build, scenario: scenario.name, run, timing, renders })
          } else {
            const session = await context.newCDPSession(page)
            await session.send("Performance.enable")
            const trace = `${scenario.name}-${run}.trace.json`
            const file = info.outputPath(trace)
            const cdp = await productionSample(session, file, action)
            await session.detach()
            const timing = await timings(page)
            if (target) expect(timing.input).toBeDefined()
            const network = await assets(timing.timeOrigin + (timing.input ?? 0), timing.timeOrigin + timing.end)
            if (!target) expect(network.transferredBytes).toBeGreaterThan(0)
            reports.push({ build, scenario: scenario.name, run, timing, network, trace, timeline: traceMetrics(file, timing), cdp })
          }
          save()
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    save()
    rmSync(profileDir, { recursive: true, force: true })
  }
})
