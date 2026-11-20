import { AppWindowIcon, ArrowLeftIcon, ArrowRightIcon, CornerDownLeftIcon, RotateCwIcon, XIcon } from "lucide-react"
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"

import { Button } from "../../components/ui/button.tsx"
import { IconButton } from "../../components/ui/icon-button.tsx"
import { Kbd } from "../../components/ui/kbd.tsx"
import { ListButton, ListRow } from "../../components/ui/list-row.tsx"
import { Notice } from "../../components/ui/notice.tsx"
import { ProgressBar } from "../../components/ui/progress-bar.tsx"
import { TextField } from "../../components/ui/text-field.tsx"
import type { BrowserFailure } from "../../lib/desktop-bridge.ts"
import { useOverlayLayer } from "../../lib/overlay-layers.ts"
import { blockingFailure, currentPage, failureText, refusedFailure, stageView } from "./browser-model.ts"
import { pageLabel, reviewChoices, type ReviewChoice } from "./review-model.ts"
import { useBrowserStage } from "./use-browser-stage.ts"
import type { ProjectBrowser } from "./use-project-browser.ts"

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const locationKeys = mac ? "⌘L" : "Ctrl+L"

interface BrowserTabProps {
  browser: ProjectBrowser
  project: string
}

// BrowserTab is the project's Browser tab (decision 0184): a browser's
// controls above a stage. The desktop app draws the page of the developer's
// app, the guest, over the stage's rectangle; Zero's page is under it and
// draws there only what stands in for the page: the prompt before one
// opens, a failure, or the guest's snapshot while an overlay is open.
export function BrowserTab({ browser, project }: BrowserTabProps) {
  const { state, recent, open, act, registerField } = browser
  const page = currentPage(state, recent[0] ?? "")
  const view = stageView(state)
  const failure = blockingFailure(state)
  const { attach, cover } = useBrowserStage(project, view === "page")

  return (
    <div className="browser-tab">
      <h1 className="visually-hidden">Browser</h1>
      <div className="browser-bar" role="group" aria-label="Browser controls">
        <IconButton label="Back" icon={<ArrowLeftIcon aria-hidden="true" />}
          disabledReason={state?.canGoBack ? undefined : "No earlier page"} onClick={() => act("back")} />
        <IconButton label="Forward" icon={<ArrowRightIcon aria-hidden="true" />}
          disabledReason={state?.canGoForward ? undefined : "No later page"} onClick={() => act("forward")} />
        {state?.loading ? (
          <IconButton label="Stop loading" icon={<XIcon aria-hidden="true" />} onClick={() => act("stop")} />
        ) : (
          <IconButton label="Reload" icon={<RotateCwIcon aria-hidden="true" />}
            disabledReason={state ? undefined : "No page open"} onClick={() => act("reload")} />
        )}
        <AddressField page={page} recent={recent} onOpen={open} registerField={registerField} />
        {/* Layer 4: the Comment toggle and the pins toggle go here, at the bar's end. */}
      </div>
      <ProgressBar active={Boolean(state?.loading)} label="Loading page" />
      <RefusedNotice failure={refusedFailure(state)} />
      <div ref={attach} className="browser-stage" data-view={view}>
        {cover && <img className="browser-stage-cover" src={cover} alt="" draggable={false} />}
        {view === "empty" && <EmptyStage recent={recent} onOpen={open} />}
        {failure && <FailedStage failure={failure} onRetry={() => {
          if (failure.kind === "crashed") act("reload")
          else open(failure.url || page)
        }} />}
      </div>
    </div>
  )
}

interface AddressFieldProps {
  // page is the address the tab stands for, shown while the field is not
  // being edited.
  page: string
  recent: readonly string[]
  onOpen(url: string): void
  registerField(focus: (() => void) | null): void
}

// AddressField is the address of the guest's page over the project's recent
// pages: typing lists the typed page and the recent ones that match, arrows
// choose, Enter opens, and Escape or leaving the field puts back the
// address the guest shows. Its list drops over the stage, so it counts as
// an overlay while open.
function AddressField({ page, recent, onOpen, registerField }: AddressFieldProps) {
  const input = useRef<HTMLInputElement>(null)
  // draft is what the reviewer typed; null while the field shows the page.
  const [draft, setDraft] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const listID = useId()
  const query = draft ?? ""
  const choices = draft === null ? [] : reviewChoices(recent, query)
  const active = choices[Math.min(activeIndex, choices.length - 1)]
  const invalid = draft !== null && query.trim() !== "" && choices.length === 0
  const listed = draft !== null && (choices.length > 0 || invalid)
  useOverlayLayer(listed)

  useEffect(() => {
    registerField(() => {
      input.current?.focus()
      input.current?.select()
    })
    return () => registerField(null)
  }, [registerField])

  function restore() {
    setDraft(null)
    setActiveIndex(0)
  }

  function go(choice: ReviewChoice | undefined) {
    if (!choice) return
    restore()
    onOpen(choice.url)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (draft === null) {
        setDraft("")
        return
      }
      if (!choices.length) return
      const current = active ? choices.indexOf(active) : -1
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((current + step + choices.length) % choices.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      // An untouched field opens what it shows again.
      go(draft === null ? (page ? { url: page, typed: true } : undefined) : active)
    } else if (event.key === "Escape" && draft !== null) {
      event.preventDefault()
      restore()
      input.current?.select()
    }
  }

  const optionID = (index: number) => `${listID}-${index}`
  return (
    <div className="browser-address">
      <TextField
        className="browser-address-field"
        inputRef={input}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="Address, like localhost:5173"
        aria-label="Page address"
        title={`Page address (${locationKeys})`}
        role="combobox"
        aria-controls={listID}
        aria-expanded={listed && choices.length > 0}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionID(choices.indexOf(active)) : undefined}
        aria-describedby={invalid ? `${listID}-hint` : undefined}
        invalid={invalid}
        value={draft ?? page}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={restore}
        onChange={(event) => {
          setDraft(event.target.value)
          setActiveIndex(0)
        }}
        onKeyDown={onKeyDown}
        trailing={<Kbd>{draft !== null ? "Enter" : locationKeys}</Kbd>}
      />
      {listed && (
        <div className="ui-popover browser-address-list">
          {invalid ? (
            <p id={`${listID}-hint`} className="browser-address-hint">Enter an http or https address, like localhost:5173.</p>
          ) : (
            <div id={listID} role="listbox" aria-label="Pages">
              {choices.map((choice, index) => (
                <ListRow
                  key={`${choice.typed ? "typed" : "recent"}:${choice.url}`}
                  id={optionID(index)}
                  density="pick"
                  active={choice === active}
                  className="browser-page"
                  role="option"
                  aria-selected={choice === active}
                  aria-label={choice.typed ? `Open ${choice.url}` : `Open ${choice.url}, recent`}
                  title={choice.url}
                  // The field keeps the keyboard, so the list stays open for the click.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => go(choice)}
                  onMouseMove={choice === active ? undefined : () => setActiveIndex(index)}
                >
                  <AppWindowIcon className="browser-page-icon" aria-hidden="true" />
                  <span className="browser-page-address">{pageLabel(choice.url)}</span>
                  {choice.typed && <span className="browser-page-note">Open</span>}
                  {choice === active && <CornerDownLeftIcon className="browser-page-enter" aria-hidden="true" />}
                </ListRow>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function failureKey(failure: BrowserFailure): string {
  return `${failure.kind}\n${failure.url}\n${failure.description}`
}

// RefusedNotice says the guest refused a navigation and kept its page: a
// bar above the stage, which leaves the page showing.
function RefusedNotice({ failure }: { failure: BrowserFailure | null }) {
  const [dismissed, setDismissed] = useState("")
  if (!failure || dismissed === failureKey(failure)) return null
  const text = failureText(failure)
  return (
    <Notice tone="warning" layout="bar" className="browser-notice">
      <span className="browser-notice-text"><strong>{text.title}.</strong> {text.detail}</span>
      <IconButton size="xs" label="Dismiss" icon={<XIcon aria-hidden="true" />} onClick={() => setDismissed(failureKey(failure))} />
    </Notice>
  )
}

// EmptyStage fills the stage before the project has a page open.
function EmptyStage({ recent, onOpen }: { recent: readonly string[]; onOpen(url: string): void }) {
  const titleID = useId()
  return (
    <div className="browser-state">
      <h2 className="browser-state-title">Open a page of your app</h2>
      <p className="browser-state-detail">Enter its address above, like localhost:5173. The page shows here, beside your files.</p>
      {recent.length > 0 && (
        <div className="browser-state-pages">
          <h3 id={titleID} className="browser-state-label">Recent pages</h3>
          <ul aria-labelledby={titleID}>
            {recent.map((url) => (
              <li key={url}>
                <ListButton className="browser-page" title={url} onClick={() => onOpen(url)}>
                  <AppWindowIcon className="browser-page-icon" aria-hidden="true" />
                  <span className="browser-page-address">{pageLabel(url)}</span>
                </ListButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// FailedStage fills the stage when the guest has no page to show.
function FailedStage({ failure, onRetry }: { failure: BrowserFailure; onRetry(): void }) {
  const text = failureText(failure)
  return (
    <div className="browser-state" role="alert">
      <h2 className="browser-state-title">{text.title}</h2>
      <p className="browser-state-detail">{text.detail}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>{text.retry}</Button>
    </div>
  )
}
