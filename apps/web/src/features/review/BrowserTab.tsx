import {
  AppWindowIcon, ArrowLeftIcon, ArrowRightIcon, CornerDownLeftIcon, MessageSquarePlusIcon, RotateCwIcon, TimerIcon, XIcon,
} from "lucide-react"
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"

import { Button } from "../../components/ui/button.tsx"
import { IconButton } from "../../components/ui/icon-button.tsx"
import { Kbd } from "../../components/ui/kbd.tsx"
import { ListRow } from "../../components/ui/list-row.tsx"
import { Notice, StatusMessage } from "../../components/ui/notice.tsx"
import { ProgressBar } from "../../components/ui/progress-bar.tsx"
import { TextField } from "../../components/ui/text-field.tsx"
import { CommentTarget } from "../feedback/CommentTarget.tsx"
import { browserPhase, currentPage, failureText } from "./browser-model.ts"
import { pageLabel, reviewChoices, type ReviewChoice } from "./review-model.ts"
import type { ProjectBrowser } from "./use-project-browser.ts"

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const locationKeys = mac ? "⌘L" : "Ctrl+L"

interface BrowserTabProps {
  browser: ProjectBrowser
  // name is the project's folder name; branch its checked-out branch, ""
  // when detached; folder says it is no repository.
  name: string
  branch: string
  folder: boolean
}

// BrowserTab steers the project's guest window (decision 0181): the page of
// the developer's app shows in a window of its own, apart from Zero and the
// files, and this tab holds its address, history, state, and failures, and
// says which project and branch a screen comment joins.
export function BrowserTab({ browser, name, branch, folder }: BrowserTabProps) {
  const { state, recent, available, open, act, registerField } = browser
  const lastURL = recent[0] ?? ""
  const page = currentPage(state, lastURL)
  const phase = browserPhase(state, lastURL)
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const listID = useId()
  const query = draft ?? ""
  const choices = draft === null ? recent.map((url) => ({ url, typed: false })) : reviewChoices(recent, query)
  const active = draft === null ? undefined : choices[Math.min(activeIndex, choices.length - 1)]

  useEffect(() => {
    registerField(() => {
      input.current?.focus()
      input.current?.select()
    })
    return () => registerField(null)
  }, [registerField])

  // Ctrl/Cmd+L takes the address, as a browser's does.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.code !== "KeyL" || event.altKey || event.shiftKey || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return
      event.preventDefault()
      input.current?.focus()
      input.current?.select()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  function go(choice: ReviewChoice | undefined) {
    if (!choice) return
    setDraft(null)
    setActiveIndex(0)
    open(choice.url)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (draft === null) setDraft("")
      if (!choices.length) return
      const current = active ? choices.indexOf(active) : -1
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((current + step + choices.length) % choices.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      // An untouched field reloads what it shows.
      go(draft === null ? (page ? { url: page, typed: true } : undefined) : active)
    } else if (event.key === "Escape" && draft !== null) {
      event.preventDefault()
      setDraft(null)
      setActiveIndex(0)
      input.current?.select()
    }
  }

  if (!available) {
    return (
      <div className="project-browser">
        <h1 className="visually-hidden">Browser</h1>
        <StatusMessage>The browser opens pages of your app in Zero's desktop app, on the computer that serves this project.</StatusMessage>
      </div>
    )
  }

  const optionID = (index: number) => `${listID}-${index}`
  const typedInvalid = draft !== null && query.trim() !== "" && choices.length === 0
  const failure = state?.failure ? failureText(state.failure) : null
  const shownPage = page ? pageLabel(page) : ""

  return (
    <div className="project-browser">
      <h1 className="visually-hidden">Browser</h1>
      <div className="project-browser-head">
        <div className="project-browser-bar">
          <div className="project-browser-controls">
            <IconButton size="md" label="Back" icon={<ArrowLeftIcon aria-hidden="true" />}
              disabledReason={state?.canGoBack ? undefined : "No earlier page"} onClick={() => act("back")} />
            <IconButton size="md" label="Forward" icon={<ArrowRightIcon aria-hidden="true" />}
              disabledReason={state?.canGoForward ? undefined : "No later page"} onClick={() => act("forward")} />
            {state?.loading ? (
              <IconButton size="md" label="Stop loading" icon={<XIcon aria-hidden="true" />} onClick={() => act("stop")} />
            ) : (
              <IconButton size="md" label="Reload" icon={<RotateCwIcon aria-hidden="true" />}
                disabledReason={state ? undefined : "No page window"} onClick={() => act("reload")} />
            )}
          </div>
          <TextField
            className="project-browser-address"
            inputClassName="project-browser-address-input"
            inputRef={input}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="localhost:5173/settings"
            aria-label="Page address"
            title={`Page address (${locationKeys})`}
            role="combobox"
            aria-controls={listID}
            aria-expanded={draft !== null && choices.length > 0}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionID(choices.indexOf(active)) : undefined}
            invalid={typedInvalid}
            value={draft ?? page}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => { if (draft !== null && draft.trim() === "") setDraft(null) }}
            onChange={(event) => {
              setDraft(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={onKeyDown}
            trailing={draft !== null ? <Kbd>Enter</Kbd> : <Kbd>{locationKeys}</Kbd>}
          />
        </div>
        <ProgressBar active={Boolean(state?.loading)} label="Loading page" />
      </div>

      <CommentTarget name={name} branch={branch} folder={folder} />

      <div className="project-browser-state" role="status" aria-live="polite">
        {phase === "empty" && (
          <StatusMessage>Type the address of a page in your app. It opens in a window of its own, apart from Zero and your files.</StatusMessage>
        )}
        {phase === "closed" && (
          <div className="project-browser-row">
            <StatusMessage>The page window is closed.</StatusMessage>
            <Button variant="outline" size="sm" onClick={() => open(lastURL)}>
              <AppWindowIcon aria-hidden="true" />Reopen {pageLabel(lastURL)}
            </Button>
          </div>
        )}
        {phase === "loading" && <StatusMessage>Loading {shownPage}…</StatusMessage>}
        {phase === "shown" && (
          <div className="project-browser-row">
            <StatusMessage>Showing {shownPage} in its page window.</StatusMessage>
            <Button variant="outline" size="sm" onClick={() => act("show")}>
              <AppWindowIcon aria-hidden="true" />Show Page
            </Button>
          </div>
        )}
      </div>
      {failure && (
        <Notice tone="error" className="project-browser-failure">
          <p className="project-browser-failure-title">{failure.title}</p>
          <p>{failure.detail}</p>
          <Button variant="outline" size="sm" onClick={() => {
            if (state?.failure?.kind === "load" || state?.failure?.kind === "certificate") open(state.failure.url || page)
            else act("reload")
          }}>{failure.retry}</Button>
        </Notice>
      )}

      {phase === "shown" && (
        <section className="project-browser-section" aria-labelledby={`${listID}-comment`}>
          <h2 id={`${listID}-comment`}>Comment on the page</h2>
          <div className="project-browser-actions">
            <Button variant="outline" size="sm" onClick={() => act("comment")}>
              <MessageSquarePlusIcon aria-hidden="true" />Comment on Screen<Kbd>F8</Kbd>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => act("commentDelayed")}>
              <TimerIcon aria-hidden="true" />In 3 Seconds<Kbd>⇧F8</Kbd>
            </Button>
          </div>
          <p className="project-browser-hint">Captures what the page window shows. The delay leaves time to open a menu or hover.</p>
        </section>
      )}

      <section className="project-browser-section" aria-labelledby={`${listID}-recent`}>
        <h2 id={`${listID}-recent`}>{draft === null ? "Recent pages" : "Pages"}</h2>
        {choices.length === 0 ? (
          <p className="project-browser-hint">
            {typedInvalid ? "Enter an http or https address, like localhost:5173." : "Pages you open here are listed for this project."}
          </p>
        ) : (
          <div id={listID} className="project-browser-pages" role="listbox" aria-label="Pages">
            {choices.map((choice, index) => (
              <ListRow
                key={`${choice.typed ? "typed" : "recent"}:${choice.url}`}
                id={optionID(index)}
                density="pick"
                active={choice === active}
                className="project-browser-page"
                role="option"
                aria-selected={choice === active}
                aria-label={choice.typed ? `Open ${choice.url}` : `Open ${choice.url}, recent`}
                title={choice.url}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => go(choice)}
              >
                <AppWindowIcon className="project-browser-page-icon" aria-hidden="true" />
                <span className="project-browser-page-title">{pageLabel(choice.url)}</span>
                {choice.typed && <span className="project-browser-page-note">Open</span>}
                {choice === active && <CornerDownLeftIcon className="project-browser-page-enter" aria-hidden="true" />}
              </ListRow>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
