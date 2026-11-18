import { CornerDownRightIcon, SearchIcon } from "lucide-react"
import { useEffect, useMemo, useState, type KeyboardEvent } from "react"

import { indexFiles, matchFiles, parseQuickOpenQuery, recentFiles, splitPath, type FileIndex } from "./quick-open.ts"

import { FileIcon } from "../../components/FileIcon.tsx"
import { DialogShell } from "../../components/ui/dialog-shell.tsx"
import { Kbd } from "../../components/ui/kbd.tsx"
import { ListRow } from "../../components/ui/list-row.tsx"
import { TextField } from "../../components/ui/text-field.tsx"
import type { HighlightRange } from "../search/search-engine.ts"
import { highlightedParts } from "../search/search-highlights.ts"
import type { HistoryLog } from "../../workspace/navigation-history.ts"
import { useNativePicker, usePickerScroll, type PickerBodyProps } from "../../workspace/use-native-picker.ts"

// Rows shown at once; the status line counts the rest.
const resultLimit = 100

export interface QuickOpenOptions {
  // query seeds the field, e.g. when Backspace leaves the command palette.
  query?: string
  // returnFocus overrides where focus returns on Escape.
  returnFocus?: HTMLElement | null
}

interface QuickOpenProps {
  files: readonly string[]
  log: HistoryLog
  project: string
  // current is the working-tree file on screen; recents leave it out.
  current: string
  // lineTarget names the text document a bare `:42` moves in, or "".
  lineTarget: string
  registerOpen(open: ((options?: QuickOpenOptions) => void) | null): void
  // beforeShow closes the mobile drawer so the popup does not stack on it.
  beforeShow(): void
  onOpen(path: string, line: number | null): void
  onGoToLine(line: number): void
  // onCommands hands `>` and the text after it to the command palette.
  onCommands(text: string, returnFocus: HTMLElement | null): void
}

type Option =
  | { key: string; kind: "file"; path: string; line: number | null; name: readonly HighlightRange[]; directory: readonly HighlightRange[] }
  | { key: string; kind: "line"; line: number }

function Highlighted({ text, ranges }: { text: string; ranges: readonly HighlightRange[] }) {
  return highlightedParts(text, ranges).map((part, index) => (
    part.highlighted ? <mark key={index}>{part.text}</mark> : part.text
  ))
}

const fileWord = (count: number) => `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`

// QuickOpen finds a file by name, as VS Code's and Zed's Cmd/Ctrl+P do:
// recent files first, fuzzy matches as you type, `path:42` and `:42` for a
// line, and `>` for commands. Arrows move, Enter opens, Escape closes.
export function QuickOpen({ files, log, project, current, lineTarget, registerOpen, beforeShow, onOpen, onGoToLine, onCommands }: QuickOpenProps) {
  const { dialog, body, show, close } = useNativePicker(beforeShow)
  const index = useMemo(() => indexFiles(files), [files])
  const fileSet = useMemo(() => new Set(files), [files])

  useEffect(() => {
    registerOpen(show)
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key !== "p" && key !== "k") return
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
      className="search-dialog quick-open"
      aria-labelledby="quick-open-title"
      onCancel={(event) => { event.preventDefault(); close(true) }}
      onClick={(event) => { if (event.target === dialog.current) close(true) }}
    >
      {body && <QuickOpenBody {...body} index={index} fileSet={fileSet} fileCount={files.length} log={log} project={project}
        current={current} lineTarget={lineTarget} onOpen={onOpen} onGoToLine={onGoToLine} onCommands={onCommands} />}
    </DialogShell>
  )
}

interface QuickOpenBodyProps extends PickerBodyProps, Pick<QuickOpenProps, "log" | "project" | "current" | "lineTarget" | "onOpen" | "onGoToLine" | "onCommands"> {
  index: FileIndex
  fileSet: ReadonlySet<string>
  fileCount: number
}

function QuickOpenBody({ initialQuery, dialog, input, close, index, fileSet, fileCount, log, project, current, lineTarget, onOpen, onGoToLine, onCommands }: QuickOpenBodyProps) {
  const [query, setQuery] = useState(initialQuery)
  const [activeIndex, setActiveIndex] = useState(0)
  const parsed = useMemo(() => parseQuickOpenQuery(query), [query])
  const recents = useMemo(() => recentFiles(log, project, fileSet, current), [current, fileSet, log, project])
  const result = useMemo(() => parsed.kind === "files" && parsed.terms.length > 0
    ? matchFiles(index, parsed.terms, resultLimit) : null, [index, parsed])

  let options: Option[] = []
  let status = ""
  let group = ""
  if (parsed.kind === "line") {
    if (lineTarget) options = [{ key: "line", kind: "line", line: parsed.line }]
    else status = "Open a text document to go to a line"
  } else if (parsed.kind === "files" && result) {
    options = result.matches.map((match) => ({
      key: match.path, kind: "file", path: match.path, line: parsed.line, name: match.name, directory: match.directory,
    }))
    if (result.total === 0) status = "No matching files"
    else if (result.total > result.matches.length) status = `Showing ${result.matches.length} of ${result.total.toLocaleString()} matches`
  } else if (parsed.kind === "files") {
    options = recents.map((path) => ({ key: path, kind: "file", path, line: parsed.line, name: [], directory: [] }))
    if (options.length) group = "recently opened"
    else status = fileCount ? `Type to search ${fileWord(fileCount)}` : "No files in this project"
  }
  const active = options[Math.min(activeIndex, options.length - 1)]
  const list = usePickerScroll(dialog, "data-quick-open", active?.key, query)

  function choose(option: Option | undefined) {
    if (!option) return
    close(false)
    if (option.kind === "line") onGoToLine(option.line)
    else onOpen(option.path, option.line)
  }

  function change(value: string) {
    if (value.startsWith(">")) {
      // Close first: the command palette takes focus once this dialog is gone.
      onCommands(value.slice(1), close(false))
      return
    }
    setQuery(value)
    setActiveIndex(0)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!options.length) return
      const position = active ? options.indexOf(active) : 0
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((position + step + options.length) % options.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(active)
    } else if (event.key === "Escape") {
      event.preventDefault()
      close(true)
    }
  }

  const optionID = (option: Option) => `quick-open-option-${options.indexOf(option)}`

  return (
    <div className="search-shell">
      <h2 id="quick-open-title" className="visually-hidden">Go to file</h2>
      <TextField
        variant="palette"
        className="command-field"
        icon={<SearchIcon />}
        trailing={<Kbd>Esc</Kbd>}
        inputRef={input}
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="Search files by name (append : to go to line)"
        aria-label="Go to file"
        role="combobox"
        aria-controls="quick-open-results"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-activedescendant={active ? optionID(active) : undefined}
        value={query}
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="search-status" role="status">{status}</div>
      <div ref={list} id="quick-open-results" className="search-results quick-open-results" role="listbox" aria-label="Files">
        {group && <p className="search-group-title quick-open-group" aria-hidden="true">{group}</p>}
        {options.map((option, position) => {
          const selected = option === active
          const row = {
            id: optionID(option),
            active: selected,
            "aria-selected": selected,
            onClick: () => choose(option),
            onMouseMove: selected ? undefined : () => setActiveIndex(position),
          }
          if (option.kind === "line") {
            const { name } = splitPath(lineTarget)
            return (
              <ListRow key={option.key} {...row} data-quick-open={option.key} density="pick" role="option"
                className="quick-open-option" aria-label={`Go to line ${option.line} in ${name}`}>
                <CornerDownRightIcon className="quick-open-icon" aria-hidden="true" />
                <span className="quick-open-label">
                  <span className="quick-open-title">Go to line {option.line}</span>
                  <span className="quick-open-folder">{name}</span>
                </span>
              </ListRow>
            )
          }
          const { directory, name } = splitPath(option.path)
          const lineNote = option.line ? `line ${option.line}` : ""
          return (
            <ListRow key={option.key} {...row} data-quick-open={option.key} density="pick" role="option"
              className="quick-open-option" title={option.path}
              aria-label={[name, directory, lineNote].filter(Boolean).join(", ")}>
              <FileIcon path={option.path} />
              <span className="quick-open-label">
                <span className="quick-open-name"><Highlighted text={name} ranges={option.name} /></span>
                {directory && <span className="quick-open-folder"><Highlighted text={directory} ranges={option.directory} /></span>}
              </span>
              {lineNote && <span className="quick-open-line">{lineNote}</span>}
            </ListRow>
          )
        })}
      </div>
    </div>
  )
}
