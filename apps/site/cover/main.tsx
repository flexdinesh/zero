// The README cover's capture page (decision 0164). `?record=<fps>` installs the
// kit's virtual clock before the scene loads and exposes `window.__cover`, so
// `record.ts` steps time one frame at a time; without it the scene plays in
// real time for tuning.

import { installVirtualClock, type ClockControl } from '../src/landing/kit/clock'
import './cover.css'

declare global {
  interface Window {
    /** Advances one frame and returns the stage's `data-mark`. */
    __cover?: { step(): Promise<string | null> }
  }
}

function expose(clock: ClockControl) {
  window.__cover = {
    async step() {
      await clock.step(1)
      while (clock.layoutPending) await clock.flushLayout()
      return document.querySelector('.ss-stage')?.getAttribute('data-mark') ?? null
    },
  }
}

async function mount() {
  // `?record=<fps>` steps that many frames per second (30 by default).
  const record = new URLSearchParams(location.search).get('record')
  if (record !== null) expose(installVirtualClock({ fps: Number(record) || 30 }))
  const [{ createRoot }, { CoverScene }] = await Promise.all([import('react-dom/client'), import('../src/landing/scenes/CoverScene')])
  const root = document.getElementById('root')
  if (root === null) throw new Error('cover: #root is missing')
  createRoot(root).render(
    <div className="landing cover-page">
      <div className="cover-frame">
        <CoverScene />
      </div>
    </div>,
  )
}

void mount()
