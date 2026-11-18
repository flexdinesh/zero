import { useEffect, useLayoutEffect, useMemo, useState, type KeyboardEvent } from "react"

import { DialogShell } from "../components/ui/dialog-shell.tsx"
import { Kbd } from "../components/ui/kbd.tsx"
import { ListRow } from "../components/ui/list-row.tsx"
import { TextField } from "../components/ui/text-field.tsx"
import type { HighlightRange } from "../features/search/search-engine.ts"
import { highlightedParts } from "../features/search/search-highlights.ts"
import { themeOptions, type Theme } from "../settings/theme.ts"
import { useTheme } from "../settings/ThemeProvider.tsx"
import { initialActiveIndex, matchThemes, pickOrder } from "./color-theme-pick.ts"
import { useNativePicker, usePickerScroll, type PickerBodyProps } from "./use-native-picker.ts"

function Highlighted({ text, ranges }: { text: string; ranges: readonly HighlightRange[] }) {
  return highlightedParts(text, ranges).map((part, index) => (
    part.highlighted ? <mark key={index}>{part.text}</mark> : part.text
  ))
}

interface ColorThemePickerProps {
  registerOpen(open: (() => void) | null): void
}

// ColorThemePicker is VS Code's Color Theme quick pick: the active row
// previews its theme, Enter or click keeps it, Escape restores the stored one.
export function ColorThemePicker({ registerOpen }: ColorThemePickerProps) {
  const { dialog, body, show, close } = useNativePicker()

  useEffect(() => {
    registerOpen(show)
    return () => { registerOpen(null) }
  }, [registerOpen, show])

  return (
    <DialogShell
      ref={dialog}
      variant="palette"
      backdrop="transparent"
      className="search-dialog command-palette"
      aria-labelledby="color-theme-title"
      onCancel={(event) => { event.preventDefault(); close(true) }}
      onClick={(event) => { if (event.target === dialog.current) close(true) }}
    >
      {body && <ColorThemePickerBody {...body} />}
    </DialogShell>
  )
}

function ColorThemePickerBody({ initialQuery, dialog, input, close }: PickerBodyProps) {
  const { theme, setTheme, previewTheme } = useTheme()
  const [query, setQuery] = useState(initialQuery)
  const { groups, order } = useMemo(() => {
    const groups = matchThemes(themeOptions, query)
    return { groups, order: pickOrder(groups) }
  }, [query])
  const [activeIndex, setActiveIndex] = useState(() => initialActiveIndex(order, theme))
  const active = order[Math.min(activeIndex, order.length - 1)]
  const list = usePickerScroll(dialog, "data-theme-option", active?.option.value, query)

  // The preview belongs to this open picker and ends before it disappears.
  useLayoutEffect(() => () => previewTheme(null), [previewTheme])

  function commit(value: Theme | undefined) {
    if (!value) return
    setTheme(value)
    close(true)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!order.length) return
      const current = active ? order.indexOf(active) : 0
      const step = event.key === "ArrowDown" ? 1 : -1
      const next = (current + step + order.length) % order.length
      setActiveIndex(next)
      previewTheme(order[next]?.option.value ?? null)
    } else if (event.key === "Enter") {
      event.preventDefault()
      commit(active?.option.value)
    } else if (event.key === "Escape") {
      event.preventDefault()
      close(true)
    }
  }

  const activeID = active ? `color-theme-option-${active.option.value}` : undefined

  return (
    <div className="search-shell">
      <h2 id="color-theme-title" className="visually-hidden">Color Theme</h2>
      <TextField
        variant="palette"
        className="command-field"
        trailing={<Kbd>Esc</Kbd>}
        inputRef={input}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="Select Color Theme (Up/Down Keys to Preview)"
        aria-label="Color theme"
        role="combobox"
        aria-controls="color-theme-results"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-activedescendant={activeID}
        value={query}
        onChange={(event) => {
          const next = pickOrder(matchThemes(themeOptions, event.target.value))
          setQuery(event.target.value)
          setActiveIndex(0)
          previewTheme(next[0]?.option.value ?? null)
        }}
        onKeyDown={onKeyDown}
      />
      {order.length === 0 && (
        <div className="search-status" role="status">No matching themes</div>
      )}
      <div ref={list} id="color-theme-results" className="search-results command-results" role="listbox" aria-label="Color themes">
        {groups.map((group) => (
          <div
            key={group.title ?? "system"}
            className="search-group"
            role={group.title ? "group" : "none"}
            aria-label={group.title ?? undefined}
          >
            {group.title && <div className="search-group-title" aria-hidden="true">{group.title}</div>}
            {group.matches.map((match) => (
              <ListRow
                key={match.option.value}
                id={`color-theme-option-${match.option.value}`}
                data-theme-option={match.option.value}
                density="pick"
                active={match === active}
                className="command-option"
                role="option"
                aria-selected={match === active}
                aria-label={match.option.label}
                onClick={() => commit(match.option.value)}
              >
                <span className="command-title"><Highlighted text={match.option.label} ranges={match.label} /></span>
              </ListRow>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
