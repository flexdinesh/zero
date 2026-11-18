'use client'

// The README cover (decision 0164): an agent resolves review feedback from
// its CLI. The reader comments on a line in zero's Source view and asks the
// agent to resolve it; the agent runs `zero feedback show`, edits the file
// (the line changes live in zero), and `zero feedback reply --resolve`, and
// its reply lands in the thread. Every file and message is synthetic.

import { CircleCheckIcon, CircleDotIcon, ChevronRightIcon, FileCodeIcon, MessageSquarePlusIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Caret, Collapse, Draft, Prompt, Roll, Stage, States, Window, type Act } from '../kit'
import { Tabs, ZeroWindow, fn, kw, num, str } from './app'
import './cover.css'

type S = {
  selected: boolean
  composer: boolean
  draft: string
  typing: boolean
  posted: boolean
  input: string
  sent: boolean
  step: number
  edited: boolean
  answer: boolean
  resolved: boolean
  folded: boolean
}

const COMMENT = 'Use clock.now() here, so tests can fake time.'
const ANSWER = 'Switched to clock.now(), as sessionAge does. The expiry test now fakes the clock.'
const ASK = 'Resolve my zero feedback'
const CLEAR = '/clear'
const PATH = 'src/middleware/session.ts'

const initial: S = {
  selected: false,
  composer: false,
  draft: '',
  typing: false,
  posted: false,
  input: '',
  sent: false,
  step: 0,
  edited: false,
  answer: false,
  resolved: false,
  folded: false,
}

const POSTER: S = { ...initial, selected: true, composer: true, draft: COMMENT, posted: true, sent: true, step: 6, edited: true, answer: true, resolved: true }

// The lines before and after the commented one.
const before: ReactNode[] = [
  <>{kw('import')} {'{'} clock {'}'} {kw('from')} {str('"../clock"')}</>,
  <>{kw('const')} maxAge = {num('30')} * {num('60')} * {num('1000')}</>,
  <>{kw('export function')} {fn('requireSession')}(req, res, next) {'{'}</>,
  <>{'  '}{kw('const')} at = req.session?.issuedAt ?? {num('0')}</>,
]

const after: ReactNode[] = [
  <>{'    '}{kw('return')} res.status({num('401')}).end()</>,
  '  }',
  <>{'  '}{fn('next')}()</>,
  '}',
  ' ',
  <>{kw('export const')} {fn('sessionAge')} = (session) =&gt;</>,
  <>{'  '}clock.{fn('now')}() - session.issuedAt</>,
  ' ',
  <>{kw('export function')} {fn('touch')}(session) {'{'}</>,
  <>{'  '}session.issuedAt = clock.{fn('now')}()</>,
  '}',
]

const LINE = before.length + 1

async function script(a: Act<S>) {
  a.mark('start')
  await a.wait(400)

  // The reader comments on a line in zero.
  await a.move({ at: 'line', x: 0.3, y: 0.5 })
  await a.wait(150)
  await a.click()
  await a.set({ selected: true })
  await a.wait(350)
  await a.key('c')
  await a.set({ composer: true, typing: true })
  await a.wait(400)
  await a.type('draft', COMMENT, { interval: 24 })
  await a.wait(250)
  await a.key('ctrl+enter')
  await a.set({ typing: false, posted: true })
  await a.wait(600)

  // Then asks the agent to resolve it.
  await a.move('input')
  await a.wait(120)
  await a.click()
  await a.type('input', ASK, { interval: 30 })
  await a.wait(200)
  await a.key('enter')
  await a.set({ sent: true, input: '' })
  await a.wait(500)

  // The agent reads the thread, fixes the line, and replies.
  await a.set({ step: 1 })
  await a.wait(600)
  await a.set({ step: 2 })
  await a.wait(1000)
  await a.set({ step: 3 })
  await a.wait(350)
  await a.set({ edited: true })
  await a.wait(1000)
  await a.set({ step: 4 })
  await a.wait(600)
  await a.set({ step: 5 })
  await a.wait(150)
  await a.set({ answer: true })
  await a.wait(350)
  await a.set({ resolved: true })
  await a.wait(500)
  await a.set({ step: 6 })
  await a.wait(900)
  a.mark('poster')
  await a.wait(1600)

  // The thread folds, as the app folds a resolved one, and the agent's
  // session clears for the next round.
  await a.set({ folded: true })
  await a.wait(700)
  await a.type('input', CLEAR, { interval: 45 })
  await a.wait(200)
  await a.key('enter')
  await a.snap({ ...initial })
  // Held a frame so the recorder sees it before the next loop's mark.
  a.mark('loop')
  await a.wait(50)
}

function Line({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="zs-line zs-src">
      <span className="zs-ln">
        <span>{n}</span>
      </span>
      <span className="zs-code">{children}</span>
    </div>
  )
}

function Thread({ s }: { s: S }) {
  return (
    <div className="cv-thread">
      <Collapse open={!s.folded}>
        <div className="cv-thread-head">
          <span className="cv-thread-status" data-resolved={s.resolved || undefined}>
            <States value={!s.posted ? 'new' : s.resolved ? 'resolved' : 'open'} states={{ new: <MessageSquarePlusIcon />, open: <CircleDotIcon />, resolved: <CircleCheckIcon /> }} />
            <Roll>{!s.posted ? 'New comment' : s.resolved ? 'Resolved' : 'Open'}</Roll>
          </span>
          <span className="cv-dim">session.ts:{LINE}</span>
        </div>
        <div className="cv-message">
          <span className="cv-author">
            you<span className="cv-time" data-show={s.posted || undefined}>just now</span>
          </span>
          <Draft className="cv-draft" value={s.draft} full={COMMENT} editing={s.typing} placeholder="Leave a comment" />
        </div>
        <Collapse open={!s.posted}>
          <div className="cv-composer-foot">
            <span className="cv-hint">Ctrl+Enter</span>
            <span className="cv-button">Cancel</span>
            <span className="cv-button cv-button-primary">Comment</span>
          </div>
        </Collapse>
        <Collapse open={s.answer} reveal="drop">
          <div className="cv-message">
            <span className="cv-author cv-agent">
              agent<span className="cv-time" data-show>just now</span>
            </span>
            <span className="cv-words">{ANSWER}</span>
            <span className="cv-event">resolved this</span>
          </div>
        </Collapse>
      </Collapse>
      <Collapse open={s.folded}>
        <div className="cv-folded">
          <CircleCheckIcon />
          <span>{COMMENT}</span>
        </div>
      </Collapse>
    </div>
  )
}

// A tool call in the agent's transcript: a dot that turns green when done.
function Tool({ open, done, children }: { open: boolean; done: boolean; children: ReactNode }) {
  return (
    <Collapse open={open}>
      <div className="cv-tool">
        <span className="cv-tool-dot" data-done={done || undefined} />
        <span className="cv-tool-name">{children}</span>
      </div>
    </Collapse>
  )
}

function Out({ open, children, kind }: { open: boolean; children: ReactNode; kind?: 'add' | 'del' }) {
  return (
    <Collapse open={open}>
      <div className="cv-tool-out" data-kind={kind}>
        {children}
      </div>
    </Collapse>
  )
}

function Agent({ s }: { s: S }) {
  return (
    <>
      <Prompt path="~/api">agent</Prompt>
      <div className="cv-transcript">
        <Collapse open={s.sent}>
          <div className="cv-user">› {ASK}</div>
        </Collapse>
        <Tool open={s.step >= 1} done={s.step >= 2}>
          zero feedback show
        </Tool>
        <Out open={s.step >= 2}>1 thread awaiting you · session.ts:{LINE}</Out>
        <Tool open={s.step >= 3} done={s.edited}>
          Edit {PATH}
        </Tool>
        <Out open={s.edited} kind="del">
          - if (Date.now() - at &gt; maxAge) {'{'}
        </Out>
        <Out open={s.edited} kind="add">
          + if (clock.now() - at &gt; maxAge) {'{'}
        </Out>
        <Tool open={s.step >= 4} done={s.step >= 5}>
          zero feedback reply fb-q7rk2m 1 --resolve
        </Tool>
        <Out open={s.step >= 5}>replied to thread 1 (resolved)</Out>
        <Collapse open={s.step >= 6}>
          <div className="cv-summary">Fixed and resolved. session.ts now reads clock.now(), as sessionAge does.</div>
        </Collapse>
      </div>
      <div className="cv-input" data-target="input" data-cursor="text">
        <span className="cv-input-sigil">›</span>
        <span>{s.input}</span>
        <Caret still={s.input.length > 0} />
        {s.input.length === 0 ? <span className="cv-placeholder">Ask the agent</span> : null}
      </div>
    </>
  )
}

export function CoverScene() {
  return (
    <Stage
      width={880}
      height={540}
      initial={initial}
      poster={POSTER}
      script={script}
      cursor={{ at: { x: 400, y: 120 } }}
      keys="bottom-left"
      className="zs cv"
    >
      {(s) => (
        <>
          <ZeroWindow className="cv-window" title="session.ts · api" active="files" badge={s.posted && !s.resolved ? 1 : undefined}>
            <Tabs tabs={[{ name: 'session.ts', icon: <FileCodeIcon />, active: true }, { name: 'clock.ts' }]} />
            <div className="cv-crumbs">
              {PATH.split('/').map((part, index, parts) => (
                <span key={part} className="cv-crumb" data-file={index === parts.length - 1 || undefined}>
                  {part}
                  {index < parts.length - 1 ? <ChevronRightIcon /> : null}
                </span>
              ))}
            </div>
            <div className="zs-lines cv-source">
              {before.map((code, index) => (
                <Line key={index} n={index + 1}>
                  {code}
                </Line>
              ))}
              <div className="zs-line zs-src cv-line" data-selected={s.selected || undefined} data-marker={s.edited || undefined} data-target="line" data-cursor="pointer">
                <span className="zs-ln">
                  <span>{LINE}</span>
                </span>
                <span className="zs-code">
                  {'  '}
                  {kw('if')} (<Roll>{s.edited ? 'clock.now()' : 'Date.now()'}</Roll> - at &gt; maxAge) {'{'}
                </span>
              </div>
              <Collapse open={s.composer} reveal="drop">
                <Thread s={s} />
              </Collapse>
              {after.map((code, index) => (
                <Line key={index} n={LINE + index + 1}>
                  {code}
                </Line>
              ))}
            </div>
          </ZeroWindow>

          <Window chrome="terminal" title="agent — ~/api" className="cv-terminal">
            <Agent s={s} />
          </Window>
          <span data-target="rest" className="cv-rest" />
        </>
      )}
    </Stage>
  )
}
