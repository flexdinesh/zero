// Records the README cover (decision 0164): one loop of CoverScene, stepped
// frame by frame at 60 fps on the kit's virtual clock, encoded as an animated WebP,
// and the loop's frame at the scene's `poster` mark as a PNG, in light and
// dark. Run `mise run readme:cover`; `-- --keep` keeps the frames for review.

import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser } from '@playwright/test'
import { createServer } from 'vite'

const FPS = 60
// A loop longer than this means the scene never reached its end mark.
const MAX_FRAMES = FPS * 40
// Frames are captured at 2x and scaled to this width in the WebP.
const WEBP_WIDTH = 1320

const here = import.meta.dirname
const out = path.resolve(here, '../../../docs/readme')
const run = promisify(execFile)
const keep = process.argv.includes('--keep')

type Theme = 'light' | 'dark'

async function stepFrame(page: import('@playwright/test').Page): Promise<string | null> {
  const mark = await page.evaluate(async () => {
    const cover = window.__cover
    if (cover === undefined) throw new Error('cover: not in record mode')
    return cover.step()
  })
  return mark
}

async function recordLoop(browser: Browser, url: string, theme: Theme) {
  const context = await browser.newContext({ viewport: { width: 960, height: 560 }, deviceScaleFactor: 2, colorScheme: theme })
  const page = await context.newPage()
  await page.goto(`${url}?record=${FPS}`)
  const frame = page.locator('.cover-frame')
  await frame.waitFor()
  await page.waitForFunction(() => window.__cover !== undefined)
  await page.evaluate(async () => {
    await document.fonts.ready
  })

  // The first loop warms up: the cursor learns when it first moves, and
  // later loops hide it until then.
  let frames = 0
  while ((await stepFrame(page)) !== 'loop') {
    if (++frames > MAX_FRAMES) throw new Error(`cover: ${theme} warm-up never reached its loop mark`)
  }

  // The second loop, from the frame after the first loop's end mark up to
  // the next: its last frame leads straight into its first.
  const dir = await mkdtemp(path.join(tmpdir(), `zero-cover-${theme}-`))
  let cleared = false
  let poster = false
  let count = 0
  for (;;) {
    const mark = await stepFrame(page)
    if (mark !== 'loop') cleared = true
    else if (cleared) break
    if (count >= MAX_FRAMES) throw new Error(`cover: ${theme} loop never reached its end mark`)
    const shot = path.join(dir, `f${String(count).padStart(4, '0')}.png`)
    await frame.screenshot({ path: shot, omitBackground: true })
    if (mark === 'poster' && !poster) {
      await copyFile(shot, path.join(out, `cover-${theme}.png`))
      poster = true
    }
    count++
  }
  await context.close()
  if (!poster) throw new Error(`cover: ${theme} loop never reached its poster mark`)
  return { dir, count }
}

async function encode(dir: string, theme: Theme) {
  const target = path.join(out, `cover-${theme}.webp`)
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(dir, 'f%04d.png'),
    '-vf', `scale=${WEBP_WIDTH}:-2:flags=lanczos`,
    '-c:v', 'libwebp_anim', '-quality', '82', '-compression_level', '6',
    '-pix_fmt', 'yuva420p', '-loop', '0',
    target,
  ])
  return target
}

async function main() {
  await mkdir(out, { recursive: true })
  const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } })
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  if (url === undefined) throw new Error('cover: the capture server has no local URL')
  const browser = await chromium.launch()
  try {
    for (const theme of ['light', 'dark'] satisfies Theme[]) {
      const { dir, count } = await recordLoop(browser, url, theme)
      const target = await encode(dir, theme)
      if (keep) console.log(`${theme}: frames kept in ${dir}`)
      else await rm(dir, { recursive: true, force: true })
      console.log(`${theme}: ${count} frames (${(count / FPS).toFixed(1)} s) -> ${path.relative(process.cwd(), target)}`)
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

await main()
