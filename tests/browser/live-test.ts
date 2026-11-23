import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { test as base } from "@playwright/test"

import { serverPort, startProcess, stopProcess, type ManagedProcess } from "../../scripts/browser-process.ts"
import { createLiveFixture } from "./live-fixture.ts"

// servedAsHome serves the fixture as the server's home folder, which zero
// treats as too broad to scan by default (decision 0194).
export const test = base.extend<{ seed: string | undefined; servedAsHome: boolean; live: { root: string; origin: string } }>({
  seed: [undefined, { option: true }],
  servedAsHome: [false, { option: true }],
  live: async ({ seed, servedAsHome }, use, info) => {
    const binary = process.env.ZERO_BROWSER_BINARY
    if (!binary) throw new Error("Run live-update tests through scripts/test-browser.ts")
    const parent = process.env.ZERO_BROWSER_LIVE_ROOT ?? tmpdir()
    mkdirSync(parent, { recursive: true })
    const directory = mkdtempSync(path.join(parent, "case-"))
    const root = path.join(directory, "repository")
    let proc: ManagedProcess | undefined
    let output = ""
    let completed = false
    try {
      if (seed) cpSync(seed, root, { recursive: true })
      else createLiveFixture(root)
      // Stay in Playwright's process group so runner cancellation also stops
      // this server if its worker exits before fixture teardown.
      proc = startProcess(binary, [root, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
        ...process.env, XDG_CACHE_HOME: path.join(directory, "cache"),
        // Keep zero's own config, state, and data out of the served folder.
        ...(servedAsHome ? {
          HOME: root,
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_STATE_HOME: path.join(directory, "state"),
          XDG_DATA_HOME: path.join(directory, "data"),
        } : {}),
      }, true, undefined, "child")
      proc.child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString() })
      const port = await serverPort(proc)
      await use({ root, origin: `http://127.0.0.1:${port}` })
      completed = true
    } finally {
      if (proc) await stopProcess(proc)
      try {
        if (!completed || info.status !== info.expectedStatus) {
          writeFileSync(path.join(directory, "server.log"), output)
          const artifacts = process.env.ZERO_BROWSER_ARTIFACT_DIR
          const destination = artifacts
            ? path.join(artifacts, "live", path.basename(directory))
            : info.outputPath("live-fixture")
          cpSync(directory, destination, { recursive: true })
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  },
})
