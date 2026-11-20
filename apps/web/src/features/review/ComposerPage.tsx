import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"

import { fetchFeedback } from "../../api/feedback-data.ts"
import { Button } from "../../components/ui/button.tsx"
import { IconButton } from "../../components/ui/icon-button.tsx"
import { StatusMessage } from "../../components/ui/notice.tsx"
import { SectionToggle } from "../../components/ui/section-toggle.tsx"
import { TextArea } from "../../components/ui/text-field.tsx"
import { desktopBridge, hostsComposer, type ComposerCapture, type WalkDirection } from "../../lib/desktop-bridge.ts"
import { readStoredTheme } from "../../settings/theme.ts"
import { useTheme } from "../../settings/ThemeProvider.tsx"
import { canWalk, composerKey, pickLabel, pickOrigin, sentFacts, targetLabel } from "./composer-model.ts"
import { sendComment } from "./composer-send.ts"

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const sendKeys = mac ? "⌘↵" : "Ctrl+Enter"
const walkKeys: Readonly<Record<WalkDirection, string>> = mac ? { parent: "⌥↑", child: "⌥↓" } : { parent: "Alt+↑", child: "Alt+↓" }

// useBranch reads the branch a project's comments join, as the Feedback
// view does: the feedback of the checkout's branch. "" until it is read,
// for a detached HEAD, and for a folder that is no repository.
function useBranch(project: string): string {
  const [read, setRead] = useState({ project: "", branch: "" })
  useEffect(() => {
    if (!project) return
    const controller = new AbortController()
    fetchFeedback({ project, id: "", compare: null }, controller.signal).then((feedback) => {
      if (!controller.signal.aborted) setRead({ project, branch: feedback.branch })
    }, () => {
      // The comment still says its folder; sending reports what fails.
    })
    return () => controller.abort()
  }, [project])
  return read.project === project ? read.branch : ""
}

// ComposerPage is the composer (decision 0184): the whole page at
// /composer, which the desktop app shows in its own small web view beside
// a pick on the Browser's page, never inside that page. It reads the pick
// that waits on mount and whenever the app says one came or ended
// (zero:composer), names it, lists what the comment sends, and posts the
// comment itself. The app keeps the page for its window's life, hidden
// between picks, so each pick starts it clean.
export function ComposerPage() {
  const bridge = useMemo(() => desktopBridge(), [])
  const hosted = hostsComposer(bridge)
  const readCapture = hosted ? bridge?.composerCapture ?? null : null
  const walkCapture = hosted ? bridge?.composerWalk ?? null : null
  const resize = hosted ? bridge?.composerResize ?? null : null
  const close = hosted ? bridge?.composerClose ?? null : null
  const { theme, setTheme } = useTheme()
  const [capture, setCapture] = useState<ComposerCapture | null>(null)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [listed, setListed] = useState(false)
  const reads = useRef(0)
  const sending = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const factsID = useId()
  const branch = useBranch(capture?.project ?? "")

  // The page outlives theme changes made in the workspace: each pick reads
  // the stored theme again.
  const followTheme = useRef(() => {})
  useEffect(() => {
    followTheme.current = () => {
      const stored = readStoredTheme()
      if (stored !== theme) setTheme(stored)
    }
  }, [setTheme, theme])

  // show starts the composer on a pick, or clears it when none waits.
  const show = useCallback((next: ComposerCapture | null) => {
    setCapture(next)
    setDraft("")
    setError("")
    setListed(false)
    if (next) followTheme.current()
  }, [])

  useEffect(() => {
    if (!readCapture) return
    let mounted = true
    const read = () => {
      const turn = ++reads.current
      void readCapture().then((next) => {
        // Only the newest read lands.
        if (mounted && turn === reads.current) show(next)
      })
    }
    read()
    window.addEventListener("zero:composer", read)
    return () => {
      mounted = false
      window.removeEventListener("zero:composer", read)
    }
  }, [readCapture, show])

  // The text field takes the keyboard for each pick, and keeps it after a
  // walk.
  useEffect(() => {
    if (capture) field.current?.focus({ preventScroll: true })
  }, [capture])

  // The app sizes the web view to the composer's content.
  useEffect(() => {
    if (!root || !resize) return
    const report = () => resize(Math.ceil(root.getBoundingClientRect().height))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(root)
    return () => observer.disconnect()
  }, [resize, root])

  const cancel = useCallback(() => {
    if (sending.current) return
    void close?.(false)
  }, [close])

  // A walk keeps the comment: only the pick changes. No answer leaves the
  // pick as it was.
  const walk = useCallback((direction: WalkDirection) => {
    if (!capture || !walkCapture || sending.current || !canWalk(capture, direction)) return
    const turn = ++reads.current
    void walkCapture(direction).then((next) => {
      if (turn === reads.current && next) setCapture(next)
    })
  }, [capture, walkCapture])

  const send = useCallback(() => {
    const body = draft.trim()
    if (!capture || !body || sending.current) return
    sending.current = true
    setBusy(true)
    setError("")
    sendComment(capture, body).then(() => {
      sending.current = false
      setBusy(false)
      // Sent: nothing here can send it again.
      reads.current++
      show(null)
      void close?.(true)
    }, (failure: unknown) => {
      sending.current = false
      setBusy(false)
      setError(failure instanceof Error ? failure.message : "Couldn't add the comment.")
    })
  }, [capture, close, draft, show])

  useEffect(() => {
    if (!capture) return
    function onKey(event: KeyboardEvent) {
      const key = composerKey(event)
      if (!key) return
      event.preventDefault()
      if (key.kind === "close") cancel()
      else if (key.kind === "send") send()
      else walk(key.direction)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cancel, capture, send, walk])

  if (!capture) return <div className="composer-page" />

  const label = pickLabel(capture)
  const origin = pickOrigin(capture)
  const target = targetLabel(capture.project, branch)
  const walks = capture.kind === "element"
  return (
    <div className="composer-page">
      <section ref={setRoot} className="composer" aria-label={`Comment on ${label}`}>
        <header className="composer-head">
          <div className="composer-pick">
            <span className="composer-pick-label" title={label}>{label}</span>
            {walks && (
              <span className="composer-walk" role="group" aria-label="Change the selection">
                <IconButton size="xs" label="Select parent" title={`Select parent (${walkKeys.parent})`} icon={<ChevronUpIcon aria-hidden="true" />}
                  disabledReason={capture.canWalkUp ? undefined : "No parent to select"} onClick={() => walk("parent")} />
                <IconButton size="xs" label="Select child" title={`Select child (${walkKeys.child})`} icon={<ChevronDownIcon aria-hidden="true" />}
                  disabledReason={capture.canWalkDown ? undefined : "Select a parent first"} onClick={() => walk("child")} />
              </span>
            )}
          </div>
          {origin && <p className="composer-origin" title={origin}>{origin}</p>}
        </header>
        <div className="composer-body">
          <TextArea ref={field} className="composer-field" rows={3} value={draft} disabled={busy} placeholder="What should change here?"
            aria-label={`Comment on ${label}`} aria-keyshortcuts="Control+Enter Meta+Enter Escape"
            onChange={(event) => setDraft(event.target.value)} />
          <span className="feedback-hint">Markdown · {sendKeys} to comment · Esc to cancel</span>
          {error && <StatusMessage tone="error" role="alert" className="composer-error">{error}</StatusMessage>}
        </div>
        <div className="composer-sent">
          <SectionToggle expanded={listed} onExpandedChange={setListed} aria-controls={factsID}>What's sent</SectionToggle>
          {listed && (
            <dl id={factsID} className="composer-facts">
              {sentFacts(capture).map((fact) => (
                <div key={fact.label} className="composer-fact">
                  <dt>{fact.label}</dt>
                  {fact.values.map((value, index) => <dd key={`${index}:${value}`} data-plain={fact.label === "Screenshot" || undefined}>{value}</dd>)}
                </div>
              ))}
            </dl>
          )}
        </div>
        <footer className="composer-foot">
          <p className="composer-target" title={`Comments go to ${target}`}>
            <span className="visually-hidden">Comments go to </span>{target}
          </p>
          <Button size="sm" variant="ghost" disabled={busy} title="Cancel (Esc)" onClick={cancel}>Cancel</Button>
          <Button size="sm" disabled={busy || !draft.trim()} title={draft.trim() ? `Comment (${sendKeys})` : "Write a comment first"} onClick={send}>
            {busy ? "Sending…" : "Comment"}
          </Button>
        </footer>
      </section>
    </div>
  )
}
