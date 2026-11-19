import { ChevronRightIcon } from "lucide-react"
import { useEffect, useState, type KeyboardEvent } from "react"

import { DialogShell } from "../components/ui/dialog-shell.tsx"
import { Kbd } from "../components/ui/kbd.tsx"
import { ListRow } from "../components/ui/list-row.tsx"
import { TextField } from "../components/ui/text-field.tsx"
import { desktopBridge, notificationsAvailable } from "../lib/desktop-bridge.ts"

import { availableCommands, matchCommands, type CommandAction } from "./commands.ts"
import type { HighlightRange } from "../features/search/search-engine.ts"
import { highlightedParts } from "../features/search/search-highlights.ts"
import { settingsShortcutLabel } from "./shortcut-labels.ts"
import { useSettingValues } from "../settings/use-setting-values.ts"
import { useNativePicker, usePickerScroll, type PickerBodyProps } from "./use-native-picker.ts"

function Highlighted({ text, ranges }: { text: string; ranges: readonly HighlightRange[] }) {
  return highlightedParts(text, ranges).map((part, index) => (
    part.highlighted ? <mark key={index}>{part.text}</mark> : part.text
  ))
}

export interface CommandPaletteOptions {
  // query seeds the field, e.g. with what followed `>` in Quick Open.
  query?: string
  // returnFocus overrides where focus returns on Escape.
  returnFocus?: HTMLElement | null
}

interface CommandPaletteProps {
  registerOpen(open: ((options?: CommandPaletteOptions) => void) | null): void
  onRun(action: CommandAction): void
  wordWrap: boolean | null
  // onExitToFiles runs when Backspace erases the `>` prompt, as in VS Code.
  onExitToFiles(returnFocus: HTMLElement | null): void
}

// CommandPalette lists commands like VS Code's: Ctrl/Cmd+Shift+P or F1 opens
// it, typing filters, arrows move, Enter runs, Escape closes, and Backspace
// in an empty field returns to Quick Open.
export function CommandPalette({ registerOpen, onRun, onExitToFiles, wordWrap }: CommandPaletteProps) {
  const { dialog, body, show, close } = useNativePicker()

  useEffect(() => {
    registerOpen(show)
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return
      const palette = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p"
      const f1 = event.key === "F1" && !event.metaKey && !event.ctrlKey && !event.shiftKey
      if (!palette && !f1) return
      event.preventDefault()
      show()
    }
    document.addEventListener("keydown", shortcut)
    return () => {
      registerOpen(null)
      document.removeEventListener("keydown", shortcut)
    }
  }, [registerOpen, show])

  return (
    <DialogShell
      ref={dialog}
      variant="palette"
      backdrop="transparent"
      className="search-dialog command-palette"
      aria-labelledby="command-palette-title"
      onCancel={(event) => { event.preventDefault(); close(true) }}
      onClick={(event) => { if (event.target === dialog.current) close(true) }}
    >
      {body && <CommandPaletteBody {...body} onRun={onRun} onExitToFiles={onExitToFiles} wordWrap={wordWrap} />}
    </DialogShell>
  )
}

type CommandPaletteBodyProps = PickerBodyProps & Pick<CommandPaletteProps, "onRun" | "onExitToFiles" | "wordWrap">

function CommandPaletteBody({ initialQuery, dialog, input, close, onRun, onExitToFiles, wordWrap }: CommandPaletteBodyProps) {
  const { values } = useSettingValues()
  const [query, setQuery] = useState(initialQuery)
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = matchCommands(availableCommands(notificationsAvailable(), wordWrap !== null, Boolean(desktopBridge()?.openReview)), query)
  const active = matches[Math.min(activeIndex, matches.length - 1)]
  const list = usePickerScroll(dialog, "data-command", active?.command.id, query)

  function run(action: CommandAction | undefined) {
    if (!action) return
    close(action.kind === "toggle-word-wrap")
    onRun(action)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!matches.length) return
      const current = active ? matches.indexOf(active) : 0
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((current + step + matches.length) % matches.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      run(active?.command.action)
    } else if (event.key === "Backspace" && query === "") {
      event.preventDefault()
      onExitToFiles(close(false))
    } else if (event.key === "Escape") {
      event.preventDefault()
      close(true)
    }
  }

  const activeID = active ? `command-option-${active.command.id}` : undefined

  return (
    <div className="search-shell">
      <h2 id="command-palette-title" className="visually-hidden">Command palette</h2>
      <TextField
        variant="palette"
        className="command-field"
        icon={<span className="command-prompt">&gt;</span>}
        trailing={<Kbd>Esc</Kbd>}
        inputRef={input}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="Type a command"
        aria-label="Command"
        role="combobox"
        aria-controls="command-results"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-activedescendant={activeID}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
        }}
        onKeyDown={onKeyDown}
      />
      {matches.length === 0 && (
        <div className="search-status" role="status">No matching commands</div>
      )}
      <div ref={list} id="command-results" className="search-results command-results" role="listbox" aria-label="Commands">
        {matches.map((match, index) => {
          const { command } = match
          // Value-bearing actions show their state; others show a shortcut.
          let value: string | null = null
          if (command.action.kind === "open-setting") value = values[command.action.setting].label
          else if (command.action.kind === "select-color-theme") value = values.theme.label
          else if (command.action.kind === "toggle-word-wrap") value = wordWrap ? "On" : "Off"
          const detail = value ?? command.shortcut ?? (command.action.kind === "open-settings" ? settingsShortcutLabel : "")
          return (
            <ListRow
              key={command.id}
              id={`command-option-${command.id}`}
              data-command={command.id}
              density="pick"
              active={match === active}
              className="command-option"
              role="option"
              aria-selected={match === active}
              aria-label={`${command.category}: ${command.title}${detail ? `, ${detail}` : ""}`}
              onClick={() => run(command.action)}
              onMouseMove={match === active ? undefined : () => setActiveIndex(index)}
            >
              <span className="command-category"><Highlighted text={command.category} ranges={match.category} /></span>
              <ChevronRightIcon className="command-separator" aria-hidden="true" />
              <span className="command-title"><Highlighted text={command.title} ranges={match.title} /></span>
              {value !== null
                ? <span className="command-value">{detail}</span>
                : detail && <kbd className="command-value">{detail}</kbd>}
            </ListRow>
          )
        })}
      </div>
    </div>
  )
}
