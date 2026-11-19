import { AppWindowIcon, CornerDownLeftIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"

import { DialogShell } from "../../components/ui/dialog-shell.tsx"
import { Kbd } from "../../components/ui/kbd.tsx"
import { ListRow } from "../../components/ui/list-row.tsx"
import { TextField } from "../../components/ui/text-field.tsx"
import { desktopBridge } from "../../lib/desktop-bridge.ts"
import { pageLabel, parseRecent, recentStorageKey, rememberURL, reviewChoices, type RecentURLs, type ReviewChoice } from "./review-model.ts"

function readRecent(): RecentURLs {
  try {
    return parseRecent(JSON.parse(window.localStorage.getItem(recentStorageKey) ?? "null"))
  } catch {
    // Unavailable or malformed storage remembers nothing.
    return {}
  }
}

function writeRecent(recent: RecentURLs) {
  try {
    window.localStorage.setItem(recentStorageKey, JSON.stringify(recent))
  } catch {
    // The page still opens; it is only not remembered.
  }
}

interface ReviewURLDialogProps {
  project: string
  registerOpen(open: (() => void) | null): void
}

// ReviewURLDialog asks which page of the developer's app to review in the
// desktop app's review window (decision 0177): a typed URL, or one of the
// project's recent pages. It registers only where the app can open one.
export function ReviewURLDialog({ project, registerOpen }: ReviewURLDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState("")
  const [recent, setRecent] = useState<readonly string[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const choices = reviewChoices(recent, query)
  const active = choices[Math.min(activeIndex, choices.length - 1)]
  const openReview = useMemo(() => desktopBridge()?.openReview ?? null, [])

  const show = useCallback(() => {
    if (!dialog.current || dialog.current.open) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const remembered = readRecent()[project] ?? []
    setRecent(remembered)
    // The last page comes back selected, so Enter reopens it.
    setQuery("")
    setActiveIndex(0)
    dialog.current.showModal()
    input.current?.focus()
  }, [project])

  const close = useCallback((restoreFocus: boolean) => {
    if (dialog.current?.open) dialog.current.close()
    if (restoreFocus) returnFocus.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!openReview) return
    registerOpen(show)
    return () => { registerOpen(null) }
  }, [openReview, registerOpen, show])

  function open(choice: ReviewChoice | undefined) {
    if (!choice || !openReview) return
    writeRecent(rememberURL(readRecent(), project, choice.url))
    close(false)
    openReview(project, choice.url)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!choices.length) return
      const current = active ? choices.indexOf(active) : 0
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((current + step + choices.length) % choices.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      open(active)
    } else if (event.key === "Escape") {
      event.preventDefault()
      close(true)
    }
  }

  const optionID = (index: number) => `review-url-option-${index}`
  const status = choices.length > 0 ? "" : query.trim() ? "Enter an http or https address, like localhost:5173" : "Type the address of a page in your app"

  return (
    <DialogShell
      ref={dialog}
      variant="palette"
      backdrop="transparent"
      className="search-dialog command-palette"
      aria-labelledby="review-url-title"
      onCancel={(event) => { event.preventDefault(); close(true) }}
      onClick={(event) => { if (event.target === dialog.current) close(true) }}
    >
      <div className="search-shell">
        <h2 id="review-url-title" className="visually-hidden">Review URL</h2>
        <TextField
          variant="palette"
          className="command-field"
          trailing={<Kbd>Esc</Kbd>}
          inputRef={input}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="Review a page: localhost:5173/settings"
          aria-label="Page to review"
          role="combobox"
          aria-controls="review-url-results"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={active ? optionID(choices.indexOf(active)) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={onKeyDown}
        />
        {status && <div className="search-status" role="status">{status}</div>}
        <div id="review-url-results" className="search-results command-results" role="listbox" aria-label="Pages">
          {choices.map((choice, index) => (
            <ListRow
              key={`${choice.typed ? "typed" : "recent"}:${choice.url}`}
              id={optionID(index)}
              density="pick"
              active={choice === active}
              className="command-option review-url-option"
              role="option"
              aria-selected={choice === active}
              aria-label={choice.typed ? `Review ${choice.url}` : `Review ${choice.url}, recent`}
              title={choice.url}
              onClick={() => open(choice)}
              onMouseMove={choice === active ? undefined : () => setActiveIndex(index)}
            >
              <AppWindowIcon className="review-url-icon" aria-hidden="true" />
              <span className="command-title review-url-title">{pageLabel(choice.url)}</span>
              <span className="command-value">{choice.typed ? "Open in review window" : "Recent"}</span>
              {choice === active && <CornerDownLeftIcon className="review-url-enter" aria-hidden="true" />}
            </ListRow>
          ))}
        </div>
      </div>
    </DialogShell>
  )
}
