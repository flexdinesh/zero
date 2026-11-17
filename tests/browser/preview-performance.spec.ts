import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { expect, type CDPSession, type TestInfo } from "@playwright/test"

import { test } from "./live-test.ts"
import { resizeBox } from "./resize.ts"

test.use({ trace: "off", screenshot: "off" })

// Run unchanged on both revisions. This measures the embedded production UI,
// not Vite's development server. Artifacts are retained by tools/validate.
const workloads = [
  { name: "small-fences", markdown: Array.from({ length: 600 }, (_, index) => `\`\`\`json\n${JSON.stringify({ index, enabled: true, message: "preview workload" }, null, 2)}\n\`\`\``).join("\n\n") },
  { name: "large-fence", markdown: `\`\`\`javascript\n${"const message = 'preview workload';\n".repeat(Math.ceil(250 * 1024 / 36))}\`\`\`` },
  { name: "diagrams", markdown: Array.from({ length: 12 }, (_, index) => `\`\`\`mermaid\nflowchart LR\nA${index}[Start] --> B${index}{Ready?}\nB${index} --> C${index}[Render]\nB${index} --> D${index}[Wait]\n\`\`\``).join("\n\n") },
]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function artifact(info: TestInfo, name: string, body: string) {
  const destination = info.outputPath(name)
  writeFileSync(destination, body)
  await info.attach(name, { path: destination, contentType: "application/json" })
}

async function traceContents(session: CDPSession): Promise<string> {
  const completed = new Promise<string>((resolve, reject) => {
    session.once("Tracing.tracingComplete", (event: unknown) => {
      if (record(event) && typeof event.stream === "string") resolve(event.stream)
      else reject(new Error("Performance trace has no stream"))
    })
  })
  await session.send("Tracing.end")
  const handle = await completed
  let contents = ""
  try {
    for (;;) {
      const chunk: unknown = await session.send("IO.read", { handle })
      if (!record(chunk) || typeof chunk.data !== "string") throw new Error("Invalid trace stream")
      contents += chunk.data
      if (chunk.eof === true) return contents
    }
  } finally {
    await session.send("IO.close", { handle })
  }
}

for (const workload of workloads) for (let repeat = 0; repeat < 5; repeat++) {
test(`preview production ${workload.name} sample ${repeat} @extended`, async ({ browser, browserName, live }, info) => {
  test.skip(browserName !== "chromium", "Chromium performance trace")
  test.setTimeout(180_000)
  for (const workload of workloads) writeFileSync(path.join(live.root, `${workload.name}.md`), `# Preview workload\n\n${workload.markdown}\n`)
  const results: unknown[] = []
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } })
    await context.addInitScript((project) => {
      sessionStorage.setItem(`zero-preview:${project}`, "1")
      const longTasks: number[] = []
      const interactions: number[] = []
      new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((entry) => entry.duration))
        document.documentElement.dataset.previewLongTasks = JSON.stringify(longTasks)
      }).observe({ type: "longtask", buffered: true })
      const interactionOptions = { type: "event", buffered: true, durationThreshold: 16 }
      new PerformanceObserver((list) => {
        interactions.push(...list.getEntries().map((entry) => entry.duration))
        document.documentElement.dataset.previewInteractions = JSON.stringify(interactions)
      }).observe(interactionOptions)
    }, live.root)
    try {
        const page = await context.newPage()
        const session = await context.newCDPSession(page)
        for (const temperature of ["cold", "warm"]) {
          await session.send("Tracing.start", { categories: "devtools.timeline,v8,blink.user_timing,toplevel,latencyInfo,benchmark", transferMode: "ReturnAsStream" })
          await page.goto(`${live.origin}/view?project=${encodeURIComponent(live.root)}&path=${workload.name}.md`)
          await expect(page.getByRole("heading", { name: "Preview workload" })).toBeVisible()
          if (workload.name === "diagrams") await expect(page.locator(".mermaid-diagram svg").first()).toBeVisible()
          else await expect(page.locator(".code-block .hl-keyword, .code-block .hl-string").first()).toBeVisible()
          // Fixed measurement windows, not correctness waits: include late work
          // from all fences in the original eager implementation.
          await page.waitForTimeout(1000)
          const initialDiagramWidth = workload.name === "diagrams" ? await page.locator(".mermaid-frame").first().evaluate((element) => element.getBoundingClientRect().width) : null
          await page.evaluate(() => performance.mark("preview-resize-start"))
          const separator = page.getByRole("separator", { name: "Resize file tree" })
          const box = await resizeBox(separator)
          await page.mouse.move(box.x + box.width / 2, box.y + 100)
          await page.mouse.down()
          for (let step = 1; step <= 24; step++) {
            await page.mouse.move(box.x + box.width / 2 + step * 10, box.y + 100)
            await page.waitForTimeout(16)
          }
          await page.mouse.up()
          const resizedDiagramWidth = initialDiagramWidth === null ? null : await page.locator(".mermaid-frame").first().evaluate((element) => element.getBoundingClientRect().width)
          if (initialDiagramWidth !== null && resizedDiagramWidth !== null) expect(resizedDiagramWidth).toBeLessThan(initialDiagramWidth - 32)
          await page.evaluate(() => performance.mark("preview-resize-end"))
          await page.waitForTimeout(400)
          await page.locator(".code-block, .mermaid-lazy").last().scrollIntoViewIfNeeded()
          await page.waitForTimeout(400)
          const metrics = await page.evaluate(() => ({
            longTasks: JSON.parse(document.documentElement.dataset.previewLongTasks ?? "[]"),
            interactions: JSON.parse(document.documentElement.dataset.previewInteractions ?? "[]"),
            navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
          }))
          results.push({ workload: workload.name, repeat, temperature, viewport: [1000, 900], browser: browser.version(), initialDiagramWidth, resizedDiagramWidth, ...metrics })
          const trace = await traceContents(session)
          await artifact(info, `${workload.name}-${repeat}-${temperature}.json`, trace)
          await page.getByRole("separator", { name: "Resize file tree" }).dblclick()
        }
        await page.close()
    } finally {
      await context.close()
    }
  await artifact(info, "preview-metrics.json", JSON.stringify(results, null, 2))
})
}

test("preview React profiling measurements @extended", async ({ browser, browserName, live }, info) => {
  test.skip(browserName !== "chromium", "Separate profiling-enabled React build")
  test.setTimeout(600_000)
  // Build only inside tools/validate's private container. The original binary
  // and production traces above remain independent of profiling overhead.
  const directory = mkdtempSync(path.join(tmpdir(), "zero-preview-profile-"))
  const config = path.join(process.cwd(), "apps/web/.preview-profile.config.ts")
  const assets = path.join(directory, "assets")
  writeFileSync(config, `
import config from "./vite.config.ts"
import { defineConfig } from "vite"
export default defineConfig((env) => {
  const base = config(env)
  return {
    ...base,
    build: { ...base.build, outDir: ${JSON.stringify(assets)} },
    resolve: { ...base.resolve, alias: { ...base.resolve.alias, "react-dom/client": "react-dom/profiling" } },
    plugins: [...base.plugins, {
      name: "preview-react-measurements",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/apps/web/src/main.tsx")) return
        return 'import { Profiler } from "react";\\n' + code
          .replaceAll("createRoot(root).render(", 'createRoot(root).render(<Profiler id="workspace" onRender={(id, phase, duration, base, start) => performance.measure("zero-react:" + phase, {start, duration})}>')
          .replaceAll("</ThemeProvider>,", "</ThemeProvider></Profiler>,")
      },
    }],
  }
})
`)
  try {
    execFileSync("pnpm", ["--filter", "@zero/web", "exec", "vite", "build", "--configLoader", "native", "--config", config], { stdio: "pipe", timeout: 90_000 })
    const shell = readFileSync(path.join(assets, "index.html"), "utf8")
    const origin = live.origin
    const results: unknown[] = []
    for (const workload of workloads) {
      writeFileSync(path.join(live.root, `${workload.name}.md`), `# Preview workload\n\n${workload.markdown}\n`)
      for (let repeat = 0; repeat < 5; repeat++) {
        const context = await browser.newContext({ viewport: { width: 1000, height: 900 } })
        try {
          await context.addInitScript((project) => sessionStorage.setItem(`zero-preview:${project}`, "1"), live.root)
          const page = await context.newPage()
          // Keep the real server's initial data/API and CSP. Only this separate
          // profiling context receives the profiling-enabled production assets.
          await page.route(`${origin}/view?**`, async (route) => {
            const response = await route.fetch()
            const html = await response.text()
            const data = /<template id="app-data">([\s\S]*?)<\/template>/.exec(html)?.[1]
            if (data === undefined) throw new Error("Server shell has no initial data")
            await route.fulfill({ response, body: shell.replace("{{APP_DATA}}", data) })
          })
          await page.route(`${origin}/assets/**`, async (route) => {
            const name = new URL(route.request().url()).pathname.slice("/assets/".length)
            const contentType = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".woff2") ? "font/woff2" : "application/octet-stream"
            await route.fulfill({ body: readFileSync(path.join(assets, name)), contentType })
          })
          for (const temperature of ["cold", "warm"]) {
            await page.goto(`${origin}/view?project=${encodeURIComponent(live.root)}&path=${workload.name}.md`)
            await expect(page.getByRole("heading", { name: "Preview workload" })).toBeVisible()
            if (workload.name === "diagrams") await expect(page.locator(".mermaid-diagram svg").first()).toBeVisible()
            else await expect(page.locator(".code-block .hl-keyword, .code-block .hl-string").first()).toBeVisible()
            const separator = page.getByRole("separator", { name: "Resize file tree" })
            const initialDiagramWidth = workload.name === "diagrams" ? await page.locator(".mermaid-frame").first().evaluate((element) => element.getBoundingClientRect().width) : null
            const box = await resizeBox(separator)
            await page.mouse.move(box.x + box.width / 2, box.y + 100)
            await page.mouse.down()
            for (let step = 1; step <= 24; step++) {
              await page.mouse.move(box.x + box.width / 2 + step * 10, box.y + 100)
              await page.waitForTimeout(16)
            }
            await page.mouse.up()
            const resizedDiagramWidth = initialDiagramWidth === null ? null : await page.locator(".mermaid-frame").first().evaluate((element) => element.getBoundingClientRect().width)
            if (initialDiagramWidth !== null && resizedDiagramWidth !== null) expect(resizedDiagramWidth).toBeLessThan(initialDiagramWidth - 32)
            await page.waitForTimeout(400)
            const timings = await page.evaluate(() => performance.getEntriesByType("measure").filter((entry) => entry.name.startsWith("zero-react:")).map((entry) => ({ phase: entry.name, duration: entry.duration })))
            expect(timings.length, "profiling build must emit actual React timings").toBeGreaterThan(0)
            results.push({ workload: workload.name, repeat, temperature, viewport: [1000, 900], browser: browser.version(), initialDiagramWidth, resizedDiagramWidth, timings })
            await separator.dblclick()
          }
        } finally {
          await context.close()
        }
      }
    }
    await artifact(info, "preview-react-metrics.json", JSON.stringify(results, null, 2))
  } finally {
    rmSync(config, { force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})
