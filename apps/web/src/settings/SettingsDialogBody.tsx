import { RotateCcwIcon, SearchIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { Button } from "../components/ui/button.tsx"
import { DialogShell } from "../components/ui/dialog-shell.tsx"
import { IconButton } from "../components/ui/icon-button.tsx"
import { ListButton } from "../components/ui/list-row.tsx"
import { Notice } from "../components/ui/notice.tsx"
import { Select } from "../components/ui/select.tsx"
import { TextField } from "../components/ui/text-field.tsx"
import { ToggleButton } from "../components/ui/toggle-button.tsx"
import { ViewHeader } from "../components/ui/view-header.tsx"

import { notificationProblem } from "../features/notifications/notifications.ts"
import { desktopBridge, notificationsAvailable, type ExperimentalState, type NotificationStatus } from "../lib/desktop-bridge.ts"
import type { RegisterDialogOpen } from "../workspace/use-deferred-dialog.tsx"

import {
  availableSettings, EXPERIMENTAL_CATEGORY, EXPERIMENTAL_DESCRIPTION, EXPERIMENTAL_TITLE, experimentalLock, experimentalMatches,
  matchSettings, NOTIFICATIONS_CATEGORY, type SettingId,
} from "./settings.ts"
import { useSettingValues, type SettingValue } from "./use-setting-values.ts"


// How long a setting opened from the command palette stays highlighted.
export const REVEAL_MS = 1600

interface SettingItemProps {
  setting: SettingValue
  revealed: boolean
  onReset(): void
}

function SettingItem({ setting, revealed, onReset }: SettingItemProps) {
  const { definition, modified } = setting
  const id = useId()
  const control = useRef<HTMLElement | null>(null)
  const setControl = (element: HTMLElement | null) => { control.current = element }
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)

  function change(value: string) {
    setDraft(value)
    setInvalid(!setting.set(value))
  }

  const describedBy = `${id}-description${invalid ? ` ${id}-error` : ""}`
  return (
    <div className="setting-item" data-setting={definition.id} data-modified={modified || undefined}
      data-revealed={revealed || undefined}>
      <div className="setting-heading">
        <label className="setting-title" htmlFor={id}>
          <span className="setting-category">{definition.category}: </span>
          <span className="setting-name">{definition.title}</span>
        </label>
        {modified && (
          <>
            <span className="setting-modified">Modified</span>
            <IconButton
              className="setting-reset"
              title={`Reset to default (${setting.defaultLabel})`}
              label={`Reset ${definition.title}`}
              icon={<RotateCcwIcon aria-hidden="true" />}
              onClick={() => {
                setDraft(null)
                setInvalid(false)
                setting.reset()
                // The reset control disappears; keep focus on the setting.
                control.current?.focus()
                onReset()
              }}
            />
          </>
        )}
      </div>
      <p className="setting-description" id={`${id}-description`}>{definition.description}</p>
      <div className="setting-control">
        {definition.kind === "number" ? (
          <>
            <TextField
              className="setting-number"
              inputRef={setControl}
              id={id}
              type="number"
              inputMode="numeric"
              min={definition.min}
              max={definition.max}
              step={1}
              value={draft ?? setting.value}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(event) => change(event.target.value)}
              onBlur={() => {
                setDraft(null)
                setInvalid(false)
              }}
            />
            <span className="setting-unit">{definition.unit}</span>
          </>
        ) : (
          <Select ref={setControl} className="setting-select" id={id} value={setting.value} aria-describedby={describedBy}
            onChange={(event) => { setting.set(event.target.value) }}>
            {definition.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        )}
      </div>
      {invalid && definition.kind === "number" && (
        <p className="setting-error" id={`${id}-error`}>
          Enter a whole number from {definition.min} to {definition.max}.
        </p>
      )}
    </div>
  )
}

// ExperimentalSetting is the desktop app's experimental features (decision
// 0184). The app owns the choice: changing it reopens the app's windows, so
// this page goes with it. A build or the environment that decides it locks
// the control and says why.
function ExperimentalSetting({ state }: { state: ExperimentalState }) {
  const id = useId()
  const [failed, setFailed] = useState(false)
  const lock = experimentalLock(state.source)

  function change(value: string) {
    setFailed(false)
    const set = desktopBridge()?.setExperimental
    if (!set) return
    void set(value === "on").then((result) => {
      if (!result) setFailed(true)
    })
  }

  return (
    <div className="setting-item" data-setting="experimental" data-modified={state.source === "setting" || undefined}>
      <div className="setting-heading">
        <label className="setting-title" htmlFor={id}>
          <span className="setting-category">{EXPERIMENTAL_CATEGORY}: </span>
          <span className="setting-name">{EXPERIMENTAL_TITLE}</span>
        </label>
        {state.source === "setting" && <span className="setting-modified">Modified</span>}
      </div>
      <p className="setting-description" id={`${id}-description`}>{EXPERIMENTAL_DESCRIPTION}{lock ? ` ${lock}` : ""}</p>
      <div className="setting-control">
        <Select className="setting-select" id={id} value={state.enabled ? "on" : "off"} disabled={lock !== ""}
          aria-describedby={`${id}-description${failed ? ` ${id}-error` : ""}`}
          onChange={(event) => change(event.target.value)}>
          <option value="off">Off</option>
          <option value="on">On</option>
        </Select>
      </div>
      {failed && <p className="setting-error" id={`${id}-error`}>The app could not change this. Try again.</p>}
    </div>
  )
}

interface SettingsDialogProps {
  registerOpen: RegisterDialogOpen<SettingId>
  notificationStatus: NotificationStatus | null
}

export function SettingsDialogBody({ registerOpen, notificationStatus }: SettingsDialogProps) {
  const { values, modifiedCount, resetAll } = useSettingValues()
  const dialog = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const modifiedFilter = useRef<HTMLButtonElement>(null)
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<string | null>(null)
  const [onlyModified, setOnlyModified] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  // token re-runs the reveal when the same setting is opened again.
  const [revealed, setRevealed] = useState<{ setting: SettingId; token: number } | null>(null)
  const definitions = availableSettings(notificationsAvailable())
  const matches = matchSettings(query, definitions).filter((definition) => !onlyModified || values[definition.id].modified)
  const results = matches.filter((definition) => category === null || definition.category === category)
  // The app's experimental features list after the page's own settings.
  const experimental = desktopBridge()?.experimental ?? null
  const experimentalMatched = experimental !== null && experimentalMatches(query) && (!onlyModified || experimental.source === "setting")
  const experimentalShown = experimentalMatched && (category === null || category === EXPERIMENTAL_CATEGORY)
  const categories = [...new Set(results.map((definition) => definition.category))]
  const allCategories = [...new Set(definitions.map((definition) => definition.category)), ...(experimental ? [EXPERIMENTAL_CATEGORY] : [])]
  const count = (item: string | null) => (item === EXPERIMENTAL_CATEGORY ? 0 : matches.filter((definition) => item === null || definition.category === item).length)
    + (experimentalMatched && (item === null || item === EXPERIMENTAL_CATEGORY) ? 1 : 0)
  const shown = results.length + (experimentalShown ? 1 : 0)
  const problem = notificationProblem(notificationStatus)

  function clearFilters() {
    setQuery("")
    setCategory(null)
    setOnlyModified(false)
    search.current?.focus()
  }

  const show = useCallback((setting?: SettingId) => {
    const element = dialog.current
    if (!element) return
    setQuery("")
    setCategory(null)
    setOnlyModified(false)
    if (!element.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      element.showModal()
    }
    if (setting) setRevealed((current) => ({ setting, token: (current?.token ?? 0) + 1 }))
    else search.current?.focus()
  }, [])

  function close() {
    dialog.current?.close()
    returnFocus.current?.focus({ preventScroll: true })
  }

  function cancel() {
    if (query) {
      setQuery("")
      search.current?.focus()
    } else close()
  }

  useEffect(() => {
    if (!revealed) return
    const item = list.current?.querySelector<HTMLElement>(`[data-setting="${revealed.setting}"]`)
    item?.scrollIntoView({ block: "nearest" })
    const control = item?.querySelector<HTMLElement>("input, select")
    control?.focus()
    if (control instanceof HTMLInputElement) control.select()
    const timer = window.setTimeout(() => setRevealed(null), REVEAL_MS)
    return () => window.clearTimeout(timer)
  }, [revealed])

  useLayoutEffect(() => {
    registerOpen(show)
    return () => registerOpen(null)
  }, [registerOpen, show])

  return (
    <DialogShell
      ref={dialog}
      variant="panel"
      backdrop="transparent"
      className="settings-dialog"
      aria-labelledby="settings-title"
      onCancel={(event) => { event.preventDefault(); cancel() }}
      onClick={(event) => { if (event.target === dialog.current) close() }}
      onClose={() => setRevealed(null)}
    >
      <div className="settings-shell">
        <ViewHeader
          variant="dialog"
          className="settings-header"
          title="Settings"
          titleId="settings-title"
          actions={<IconButton className="settings-close" label="Close settings" icon={<XIcon aria-hidden="true" />}
                onClick={close} />}
        />
        <TextField
          className="settings-search"
          inputRef={search}
          icon={<SearchIcon aria-hidden="true" />}
          trailing={query ? <IconButton className="settings-search-clear" label="Clear settings search"
            icon={<XIcon aria-hidden="true" />} onClick={() => { setQuery(""); search.current?.focus() }} /> : undefined}
          type="search"
          placeholder="Search settings"
          aria-label="Search settings"
          aria-controls="settings-list"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCategory(null)
          }}
          onKeyDown={(event) => {
            // WebKit's search input can consume Escape before dialog cancel.
            if (event.key === "Escape") {
              event.preventDefault()
              cancel()
            }
          }}
        />
        <div className="settings-tools">
          <span role="status">{shown} {shown === 1 ? "setting" : "settings"}</span>
          <ToggleButton ref={modifiedFilter} size="text" className="settings-modified-filter" pressed={onlyModified}
            label="Show modified settings"
            onPressedChange={setOnlyModified}>Show modified <span>{modifiedCount}</span></ToggleButton>
        </div>
        <div className="settings-body">
          <nav className="settings-categories" aria-label="Settings categories">
            {[null, ...allCategories].map((item) => (
              <ListButton key={item ?? "all"} selected={category === item} aria-current={category === item ? "true" : undefined}
                aria-controls="settings-list" onClick={() => { setCategory(item); list.current?.scrollTo(0, 0) }}>
                <span>{item ?? "All settings"}</span>
                <span className="settings-category-count">{count(item)}</span>
              </ListButton>
            ))}
          </nav>
          <div ref={list} className="settings-list" id="settings-list">
            {shown ? categories.map((category) => (
              <section key={category} aria-label={category}>
                <h3 className="settings-group-title">{category}</h3>
                {category === NOTIFICATIONS_CATEGORY && problem && <Notice tone="warning">{problem}</Notice>}
                {results.filter((definition) => definition.category === category).map((definition) => (
                  <SettingItem key={`${definition.id}-${resetKey}`} setting={values[definition.id]}
                    revealed={revealed?.setting === definition.id}
                    onReset={() => { if (onlyModified) modifiedFilter.current?.focus() }} />
                ))}
              </section>
            )) : null}
            {experimentalShown && experimental && (
              <section aria-label={EXPERIMENTAL_CATEGORY}>
                <h3 className="settings-group-title">{EXPERIMENTAL_CATEGORY}</h3>
                <ExperimentalSetting state={experimental} />
              </section>
            )}
            {shown ? null : (
              <div className="settings-empty">
                <p>{query.trim() ? `No settings match “${query.trim()}”.` : onlyModified ? "No modified settings in this category." : "No settings in this category."}</p>
                <Button variant="outline" onClick={clearFilters}>Clear filters</Button>
              </div>
            )}
          </div>
        </div>
        <footer className="settings-footer">
          <span>{notificationsAvailable() ? "Saved for this connection." : "Saved in this browser."} Changes apply immediately.</span>
          <Button
            variant="ghost"
            className="settings-reset-all"
            disabled={modifiedCount === 0}
            onClick={() => {
              resetAll()
              setResetKey((key) => key + 1)
              // Reset all disables itself; return focus to the search field.
              search.current?.focus()
            }}
          >
            <RotateCcwIcon aria-hidden="true" />
            Reset all
          </Button>
        </footer>
      </div>
    </DialogShell>
  )
}
