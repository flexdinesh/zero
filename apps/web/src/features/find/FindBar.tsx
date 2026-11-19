import { ArrowDownIcon, ArrowUpIcon, SearchIcon, TextSelectIcon, XIcon } from "lucide-react"
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react"

import { IconButton } from "../../components/ui/icon-button.tsx"
import { TextField } from "../../components/ui/text-field.tsx"
import { ToggleButton, ToggleGlyph } from "../../components/ui/toggle-button.tsx"
import { useFindSession, type FindSession } from "./FindProvider.tsx"

const mac = typeof navigator !== "undefined" && navigator.platform.includes("Mac")
const alt = mac ? "⌥" : "Alt+"
const nextKey = mac ? "Enter, ⌘G" : "Enter, F3"
const previousKey = mac ? "Shift+Enter, ⇧⌘G" : "Shift+Enter, Shift+F3"

type Option = "matchCase" | "wholeWord" | "regex"

const toggles: ReadonlyArray<{ option: Option; label: string; code: string; icon: ReactNode }> = [
  { option: "matchCase", label: "Match Case", code: "KeyC", icon: <ToggleGlyph>Aa</ToggleGlyph> },
  { option: "wholeWord", label: "Match Whole Word", code: "KeyW", icon: <ToggleGlyph underline>ab</ToggleGlyph> },
  { option: "regex", label: "Use Regular Expression", code: "KeyR", icon: <ToggleGlyph>.*</ToggleGlyph> },
]

// FindBar is find in file's band under the document toolbar (decision
// 0172), shown while find is open: the query with its options, the count,
// Previous, Next, Find in Selection, and Close.
export function FindBar() {
  const session = useFindSession()
  return session ? <FindBarBody session={session} /> : null
}

function FindBarBody({ session }: { session: FindSession }) {
  const input = useRef<HTMLInputElement>(null)
  const { focusRequest, query, invalid } = session
  useLayoutEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusRequest])

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const toggle = event.altKey && !event.ctrlKey && !event.metaKey ? toggles.find((item) => item.code === event.code) : undefined
    if (toggle) {
      session.setOption(toggle.option, !query[toggle.option])
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyL") {
      if (!session.selectionReason) session.setInSelection(!session.inSelection)
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      session.step(event.shiftKey ? -1 : 1)
    } else if (event.key === "Escape") {
      session.close()
    } else {
      return
    }
    event.preventDefault()
  }

  const stepReason = session.hasMatches ? undefined : "No matches"
  const message = invalid || session.status || session.count
  return (
    <div className="find-bar" role="search" aria-label="Find in file">
      <TextField className="find-field" inputRef={input} inputClassName="find-input" type="text" autoComplete="off" spellCheck={false}
        icon={<SearchIcon />} placeholder="Find" aria-label="Find" value={query.pattern} invalid={invalid !== ""}
        aria-describedby="find-count" aria-keyshortcuts="Control+F Meta+F"
        onChange={(event) => session.setPattern(event.target.value)} onKeyDown={onKeyDown}
        trailing={toggles.map((toggle) => (
          <ToggleButton key={toggle.option} label={toggle.label} pressed={query[toggle.option]}
            title={`${toggle.label} (${alt}${toggle.code.slice(3)})`}
            onPressedChange={(pressed) => session.setOption(toggle.option, pressed)}>
            {toggle.icon}
          </ToggleButton>
        ))} />
      <span id="find-count" className="find-count" role="status" aria-live="polite" title={message}
        data-tone={invalid ? "error" : undefined}>
        {message}
      </span>
      <div className="find-actions">
        <IconButton label="Previous Match" title={`Previous Match (${previousKey})`} disabledReason={stepReason}
          icon={<ArrowUpIcon aria-hidden="true" />} onClick={() => session.step(-1)} />
        <IconButton label="Next Match" title={`Next Match (${nextKey})`} disabledReason={stepReason}
          icon={<ArrowDownIcon aria-hidden="true" />} onClick={() => session.step(1)} />
        <ToggleButton className="find-in-selection" label="Find in Selection" pressed={session.inSelection}
          aria-disabled={session.selectionReason ? true : undefined}
          title={session.selectionReason || `Find in Selection (${alt}L)`}
          onPressedChange={(pressed) => { if (!session.selectionReason) session.setInSelection(pressed) }}>
          <TextSelectIcon aria-hidden="true" />
        </ToggleButton>
      </div>
      <IconButton className="find-close" label="Close" title="Close (Escape)" icon={<XIcon aria-hidden="true" />} onClick={session.close} />
    </div>
  )
}
