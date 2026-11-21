import { Menu } from "@base-ui/react/menu"
import { CheckIcon, ChevronDownIcon, ClipboardCopyIcon, EllipsisIcon, GitBranchIcon, ImageIcon, XIcon } from "lucide-react"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"

import { FileIcon } from "../../components/FileIcon.tsx"
import { Button } from "../../components/ui/button.tsx"
import { CopyButton } from "../../components/ui/copy-button.tsx"
import { IconButton } from "../../components/ui/icon-button.tsx"
import { ListRow } from "../../components/ui/list-row.tsx"
import { menuItemClass, menuPopupClass, menuPositionerClass, menuSeparatorClass } from "../../components/ui/menu.ts"
import { Notice, StatusMessage } from "../../components/ui/notice.tsx"
import { SegmentedControl, SegmentedItem } from "../../components/ui/segmented-control.tsx"
import { ViewHeader } from "../../components/ui/view-header.tsx"
import type { Feedback, FeedbackThread } from "@zero/contracts"
import { useClipboardCopy } from "../../lib/clipboard.ts"
import { shareableOrigin } from "../../lib/shareable-origin.ts"
import { agentWhere, machineLabel } from "../../lib/agent-place.ts"
import { useServerPlace } from "../projects/ServerPlaceProvider.tsx"
import { useRovingRows } from "../../lib/use-roving-rows.ts"
import { SidebarBody } from "../../workspace/SidebarBody.tsx"
import { commitAge, commitDate } from "../source-control/compare.ts"
import {
  activity, branchLabel, feedbackMarkdown, feedbackMeta, feedbackPrompt, filterChoices, groupByFile, isUnseen, matchesFilter,
  placeLabel, screenRoute, statusLabels, statusWords, threadRoute, threadTitle, type ThreadRoute,
} from "./feedback-model.ts"
import { FeedbackStatusIcon, FeedbackThreadZone } from "./FeedbackThreadZone.tsx"
import { VisualThumb } from "./VisualTarget.tsx"
import { isVisualThread } from "./visual-model.ts"
import type { FeedbackActions } from "./use-feedback.ts"
import type { FeedbackViewState } from "./use-feedback-view.ts"
import { OverlayLayer } from "../../lib/overlay-layers.ts"

interface FeedbackViewProps {
  // project is the absolute path the copied prompt names.
  project: string
  // branch is the checkout's branch, "" when detached.
  branch: string
  view: FeedbackViewState
  mobile: boolean
  visible: boolean
  onDismiss(): void
  onOpenThread(route: ThreadRoute): void
  navigate(href: string): void
}

// emptyHint is the empty view's guidance, naming where the agent runs when
// the project is not local (decision 0187).
function emptyHint(where: string): string {
  return `Select lines in a diff or file and press C to comment. Then copy the prompt for your agent${where ? ` ${where}` : ""}.`
}
function copyIcon(status: "idle" | "copied" | "failed") {
  return status === "copied" ? <CheckIcon aria-hidden="true" /> : status === "failed" ? <XIcon aria-hidden="true" /> : <ClipboardCopyIcon aria-hidden="true" />
}

// CopyPrompt copies the prompt that sends an agent to the threads waiting
// on it: an icon in the view header, or a labeled button in the empty view.
// When the project is not local, both name the machine the agent runs on
// (decision 0187).
function CopyPrompt({ feedback, project, labeled = false }: { feedback: Feedback | null; project: string; labeled?: boolean }) {
  const { status, copy } = useClipboardCopy()
  const place = useServerPlace()
  const machine = machineLabel(place)
  const where = agentWhere(place)
  const id = feedback && feedback.threads.length > 0 ? feedback.id : ""
  const onClick = () => {
    if (feedback && id) void copy(feedbackPrompt({ origin: shareableOrigin(window.location.origin), project, id, branch: feedback.branch, place }))
  }
  const reason = id ? undefined : "Comment on code first"
  const copied = where ? `Copied: paste into your agent ${where}` : "Prompt copied"
  return (
    <>
      {labeled
        ? <Button variant="outline" data-status={status} disabled={!id} title={reason ?? (status === "copied" ? copied : undefined)} onClick={onClick}>
          {copyIcon(status)}{status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : machine ? `Copy prompt for ${machine}` : "Copy prompt"}
        </Button>
        : <IconButton label={machine ? `Copy Prompt for ${machine}` : "Copy Prompt"}
          title={status === "failed" ? "Copy failed" : status === "copied" && where ? copied : where ? `Copy Prompt: send your agent ${where} to these threads` : "Copy Prompt: send your agent to these threads"}
          disabledReason={reason} tone={status === "copied" ? "success" : status === "failed" ? "destructive" : "default"} data-status={status}
          icon={copyIcon(status)} onClick={onClick} />}
      <span className="visually-hidden" role="status">{status === "copied" ? copied : status === "failed" ? "Copy failed" : ""}</span>
    </>
  )
}

// BranchPicker chooses whose feedback the view shows: the checkout's branch
// by default, or any branch with feedback in the repository.
function BranchPicker({ branch: checkout, view }: { branch: string; view: FeedbackViewState }) {
  // The checkout's feedback names its branch once read.
  const branch = view.selectedId === "" && view.session.feedback ? view.session.feedback.branch : checkout
  const entries = view.list.result ?? []
  const current = entries.find((entry) => entry.branch === branch)
  const others = entries.filter((entry) => entry !== current)
  const value = view.selectedId === "" || view.selectedId === current?.id ? "" : view.selectedId
  const shown = value === "" ? branch : view.session.feedback?.branch ?? others.find((entry) => entry.id === value)?.branch ?? ""
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button variant="ghost" size="sm" className="feedback-branch" aria-label={`Branch: ${branchLabel(shown)}`} />}>
        <GitBranchIcon aria-hidden="true" />
        <span className="feedback-branch-name" data-detached={shown ? undefined : true}>{branchLabel(shown)}</span>
        <ChevronDownIcon aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={menuPositionerClass} sideOffset={4} align="start">
          <Menu.Popup className={menuPopupClass} aria-label="Feedback branches">
            <Menu.RadioGroup value={value} onValueChange={(next: unknown) => {
              if (typeof next === "string") view.show(next)
            }}>
              {[{ id: "", branch, current: true }, ...others.map((entry) => ({ id: entry.id, branch: entry.branch, current: false }))].map((choice) => {
                const summary = choice.current ? current : entries.find((entry) => entry.id === choice.id)
                return (
                  <Menu.RadioItem key={choice.id || "current"} className={menuItemClass} value={choice.id}>
                    <Menu.RadioItemIndicator className="feedback-branch-check" keepMounted>
                      <CheckIcon aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                    <span className="feedback-branch-name" data-detached={choice.branch ? undefined : true}>{branchLabel(choice.branch)}</span>
                    {summary && <span className="feedback-branch-detail">{summary.open.toLocaleString()} open</span>}
                  </Menu.RadioItem>
                )
              })}
            </Menu.RadioGroup>
            <OverlayLayer />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

export function FeedbackSidebarView(props: FeedbackViewProps) {
  const { actions } = props.view.session
  // A completion belongs to the session that started it, even if the body
  // is hidden and is still displaying that session's previous snapshot.
  const current = useRef<FeedbackActions | null>(null)
  useLayoutEffect(() => {
    current.current = actions
    return () => { current.current = null }
  }, [actions])
  const isCurrent = useCallback((request: FeedbackActions) => current.current === request, [])
  return <SidebarBody visible={props.visible}><FeedbackView {...props} isCurrent={isCurrent} /></SidebarBody>
}

// A thread opens where it was written. An outdated thread opens in place
// with the text it was about (decision 0120).
export function FeedbackView({ branch, mobile, navigate, onDismiss, onOpenThread, project, view, visible, isCurrent }: FeedbackViewProps & {
  isCurrent(actions: FeedbackActions): boolean
}) {
  const { actions, feedback } = view.session
  const [confirmation, setConfirmation] = useState<{ actions: FeedbackActions; busy: boolean; error: string } | null>(null)
  const markdown = useClipboardCopy()
  const shownThreads = useMemo(() => (feedback?.threads ?? [])
    .filter((thread) => matchesFilter(thread, view.filter) && (!view.path || thread.location?.path === view.path)), [feedback, view.filter, view.path])
  const remove = () => {
    if (!confirmation || confirmation.actions !== actions || confirmation.busy || !feedback?.id) return
    setConfirmation({ actions, busy: true, error: "" })
    actions.removeFeedback().then(() => {
      if (!isCurrent(actions)) return
      setConfirmation(null)
      view.show("")
    }, (error: unknown) => {
      if (isCurrent(actions)) setConfirmation({ actions, busy: false, error: error instanceof Error ? error.message : "Couldn't delete the feedback." })
    })
  }
  const hasThreads = (feedback?.threads.length ?? 0) > 0
  return (
    <div className="feedback-view">
      <ViewHeader className="explorer-header sidebar-header" title="Feedback" actions={<>
        <CopyPrompt feedback={feedback} project={project} />
        <Menu.Root>
          <Menu.Trigger render={<IconButton label="More Feedback Actions" tone={markdown.status === "copied" ? "success" : "default"}
            icon={markdown.status === "copied" ? <CheckIcon aria-hidden="true" /> : <EllipsisIcon aria-hidden="true" />} />} />
          <Menu.Portal>
            <Menu.Positioner className={menuPositionerClass} sideOffset={4} align="end">
              <Menu.Popup className={menuPopupClass} aria-label="Feedback actions">
                <Menu.Item className={menuItemClass} disabled={!feedback || shownThreads.length === 0}
                  onClick={() => { if (feedback) void markdown.copy(feedbackMarkdown(feedback, shownThreads)) }}>
                  Copy as Markdown
                </Menu.Item>
                <Menu.Separator className={menuSeparatorClass} />
                <Menu.Item className={menuItemClass} disabled={!feedback?.id || confirmation?.actions === actions}
                  onClick={() => setConfirmation({ actions, busy: false, error: "" })}>Delete feedback</Menu.Item>
                <OverlayLayer />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <span className="visually-hidden" role="status">{markdown.status === "copied" ? "Threads copied as Markdown" : markdown.status === "failed" ? "Copy failed" : ""}</span>
        {mobile && <IconButton label="Close feedback" icon={<XIcon aria-hidden="true" />} onClick={onDismiss} />}
      </>} />
      <div className="feedback-scroll">
        <div className="feedback-heading">
          <BranchPicker branch={branch} view={view} />
          {feedback?.id && (
            <p className="feedback-meta">
              <code className="feedback-id">{feedback.id}</code>
              <CopyButton text={feedback.id} label={`Copy feedback id ${feedback.id}`} className="feedback-id-copy" />
              <span className="feedback-meta-counts">{feedbackMeta(feedback, view.unseen)}</span>
            </p>
          )}
        </div>
        {confirmation?.actions === actions && feedback?.id && (
          <Notice tone="warning" layout="bar" role="group" aria-label="Delete feedback" className="feedback-confirm">
            <span>Delete every thread on {branchLabel(feedback.branch)}? Zero keeps no copy.</span>
            {confirmation.error && <span role="alert">{confirmation.error}</span>}
            <span className="feedback-confirm-actions">
              <Button size="sm" variant="destructive" disabled={confirmation.busy} onClick={remove}>Delete</Button>
              <Button size="sm" variant="outline" disabled={confirmation.busy} onClick={() => setConfirmation(null)}>Cancel</Button>
            </span>
          </Notice>
        )}
        {hasThreads && (
          <SegmentedControl size="sm" className="feedback-filter" aria-label="Show threads">
            {filterChoices.map((choice) => (
              <SegmentedItem key={choice.value} pressed={view.filter === choice.value} onClick={() => view.setFilter(choice.value)}>{choice.label}</SegmentedItem>
            ))}
          </SegmentedControl>
        )}
        {view.path && (
          <p className="feedback-narrowed">
            <span className="feedback-narrowed-label">Only <code>{view.path}</code></span>
            <IconButton size="xs" label="Show Every File" icon={<XIcon aria-hidden="true" />} onClick={view.clearPath} />
          </p>
        )}
        <FeedbackBody view={view} threads={shownThreads} project={project} navigate={navigate} visible={visible} onOpenThread={(route) => {
          onOpenThread(route)
          if (mobile) onDismiss()
        }} />
      </div>
    </div>
  )
}

interface BodyProps {
  view: FeedbackViewState
  visible: boolean
  threads: readonly FeedbackThread[]
  project: string
  navigate(href: string): void
  onOpenThread(route: ThreadRoute): void
}

function FeedbackBody({ navigate, onOpenThread, project, threads, view, visible }: BodyProps) {
  const { load, feedback } = view.session
  const place = useServerPlace()
  if (load.kind === "missing") {
    return (
      <div className="feedback-note">
        <StatusMessage>This feedback was deleted.</StatusMessage>
        <Button variant="outline" onClick={() => view.show("")}>Show this branch's feedback</Button>
      </div>
    )
  }
  if (load.kind === "error" && !feedback) {
    return (
      <div className="feedback-note">
        <StatusMessage tone="error" role="alert">{load.message}</StatusMessage>
        <Button variant="outline" onClick={view.session.retry}>Retry</Button>
      </div>
    )
  }
  if (!feedback) return <div className="feedback-note"><StatusMessage>Loading feedback…</StatusMessage></div>
  if (feedback.threads.length === 0) {
    return (
      <div className="feedback-note">
        <StatusMessage>{emptyHint(agentWhere(place))}</StatusMessage>
        <CopyPrompt feedback={feedback} project={project} labeled />
      </div>
    )
  }
  return <>
    {load.kind === "error" && <StatusMessage tone="error" role="alert" className="feedback-stale">{load.message}</StatusMessage>}
    {threads.length === 0
      ? <div className="feedback-note"><StatusMessage>{view.filter === "resolved" ? "No resolved threads." : view.filter === "awaiting" ? "Nothing awaits the agent." : "No open threads."}</StatusMessage></div>
      : <ThreadRows key={feedback.id} feedback={feedback} threads={threads} view={view} visible={visible} navigate={navigate} onOpenThread={onOpenThread} />}
  </>
}

interface RowsProps {
  feedback: Feedback
  threads: readonly FeedbackThread[]
  view: FeedbackViewState
  visible: boolean
  navigate(href: string): void
  onOpenThread(route: ThreadRoute): void
}

function ThreadRows({ feedback, navigate, onOpenThread, threads, view, visible }: RowsProps) {
  const groups = useMemo(() => groupByFile(threads), [threads])
  const ordered = useMemo(() => groups.flatMap((group) => group.threads), [groups])
  const [expanded, setExpanded] = useState<number | null>(null)
  const now = useMemo(() => feedback.updatedAt ? Date.now() : 0, [feedback.updatedAt])
  const open = (index: number) => {
    const thread = ordered[index]
    if (!thread) return
    // A visual thread opens its screen tab (decision 0182).
    const route = isVisualThread(thread) ? screenRoute(feedback.project, feedback.id, thread.number) : threadRoute(feedback.project, thread)
    if (route) onOpenThread(route)
    else setExpanded((current) => current === thread.number ? null : thread.number)
  }
  const { container, tabIndex, setFocused, onKeyDown } = useRovingRows(ordered.length, -1, open)
  return (
    <div ref={container} className="feedback-rows" role="listbox" aria-label="Threads"
      onKeyDown={(event) => {
        // Keys inside an expanded thread belong to its controls.
        if (event.target instanceof Element && event.target.closest(".feedback-thread")) return
        onKeyDown(event)
      }}>
      {groups.map((group) => (
        <div key={group.kind === "file" ? group.path : "screens"} role="group" aria-label={group.kind === "file" ? group.path : "Screenshots"} className="feedback-group">
          <div className="feedback-group-header" aria-hidden="true">
            {group.kind === "file"
              ? <><FileIcon path={group.path} /><span className="feedback-group-path" title={group.path}>{group.path}</span></>
              : <><ImageIcon className="feedback-group-icon" /><span className="feedback-group-name">Screenshots</span></>}
          </div>
          {group.threads.map((thread) => {
            const index = ordered.indexOf(thread)
            const visual = isVisualThread(thread) ? thread.visual : null
            const outdated = thread.location?.state === "outdated"
            // Outdated threads open in place.
            const inline = outdated
            const fresh = isUnseen(view.seen, feedback.id, thread)
            const last = thread.messages.at(-1)
            const age = last ? commitAge(last.createdAt, now).long : ""
            const title = threadTitle(thread)
            const detail = visual
              ? `#${thread.number} · ${statusWords[thread.status]} · ${placeLabel(thread)} · ${activity(thread)} ${age}`
              : `${placeLabel(thread)} · ${activity(thread)} ${age}`
            return [
              <ListRow indent="nested" key={thread.number} role="option" aria-selected={false} tabIndex={index === tabIndex ? 0 : -1}
                className="feedback-row" data-visual={visual ? true : undefined} data-new={fresh || undefined} aria-expanded={inline ? expanded === thread.number : undefined}
                title={`Thread ${thread.number}: ${title}\n${detail}${last ? `\n${commitDate(last.createdAt)}` : ""}`}
                aria-label={`Thread ${thread.number}, ${statusLabels[thread.status]}${fresh ? ", new reply" : ""}: ${title}, ${detail}${outdated ? ", outdated" : ""}`}
                onFocus={() => setFocused(index)} onClick={() => open(index)}>
                {visual
                  ? <VisualThumb project={feedback.project} feedbackId={feedback.id} visual={visual} />
                  : <FeedbackStatusIcon status={thread.status} className="feedback-row-icon feedback-status-icon" />}
                <span className="feedback-row-text">
                  <span className="feedback-row-title">{title}</span>
                  <span className="feedback-row-meta">
                    {detail}{outdated && <span className="feedback-row-outdated"> · outdated</span>}
                  </span>
                </span>
                {fresh && <span className="feedback-row-new" title="New reply" aria-hidden="true" />}
              </ListRow>,
              inline && expanded === thread.number && (
                <div key={`${thread.number}-thread`} className="feedback-inline">
                  <FeedbackThreadZone thread={thread} feedbackId={feedback.id} project={feedback.project} actions={view.session.actions} navigate={navigate} visible={visible}
                    before={thread.anchor?.text && thread.anchor.text.length > 0
                      ? <pre className="feedback-original" aria-label="The code this thread was about">{thread.anchor.text.join("\n")}</pre>
                      : undefined} />
                </div>
              ),
            ]
          })}
        </div>
      ))}
    </div>
  )
}
