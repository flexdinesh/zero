import { AppWindowIcon, XIcon } from "lucide-react"
import { useId } from "react"

import { IconButton } from "../../components/ui/icon-button.tsx"
import { ListRow } from "../../components/ui/list-row.tsx"
import { StatusMessage } from "../../components/ui/notice.tsx"
import { ViewHeader } from "../../components/ui/view-header.tsx"
import { useRovingRows } from "../../lib/use-roving-rows.ts"
import { CommentTarget, type CommentTargetProps } from "../feedback/CommentTarget.tsx"
import { commentRow, openCount, type PageThread } from "./browser-comments.ts"
import { pageLabel } from "./review-model.ts"
import { commentKeys, type BrowserComments } from "./use-browser-comments.ts"
import type { ProjectBrowser } from "./use-project-browser.ts"

interface BrowserViewProps {
  browser: ProjectBrowser
  comments: BrowserComments
  // target is the project and branch comments join.
  target: CommentTargetProps
  mobile: boolean
  onDismiss(): void
  // onOpen shows a page in the project's Browser tab and brings the tab
  // forward.
  onOpen(url: string): void
  // onOpenThread opens a thread's screen tab.
  onOpenThread(thread: number): void
}

// BrowserView is the Browser activity (decision 0184): the project's pages,
// most recent first, with the one its Browser tab shows marked, then the
// comments on that page, and where comments go. Choosing a page opens it in
// the tab; choosing a comment opens its thread.
export function BrowserView({ browser, comments, mobile, onDismiss, onOpen, onOpenThread, target }: BrowserViewProps) {
  const { recent, state, forget } = browser
  const pagesID = useId()
  const current = state ? recent.indexOf(state.url) : -1
  const open = (index: number) => {
    const url = recent[index]
    if (!url) return
    onOpen(url)
    if (mobile) onDismiss()
  }
  const remove = (index: number) => {
    const url = recent[index]
    if (url) forget(url)
  }
  const { container, tabIndex, setFocused, onKeyDown } = useRovingRows(recent.length, current, open, remove)
  return (
    <div className="browser-view">
      <ViewHeader className="explorer-header sidebar-header" title="Browser"
        actions={mobile ? <IconButton label="Close browser" icon={<XIcon aria-hidden="true" />} onClick={onDismiss} /> : undefined} />
      <div className="browser-view-scroll">
        <section className="browser-view-section" aria-labelledby={pagesID}>
          <h3 id={pagesID} className="browser-view-heading">Pages</h3>
          {recent.length === 0 ? (
            <StatusMessage className="browser-view-empty">
              Pages of your app that you open show here. Enter an address in the Browser tab to open the first.
            </StatusMessage>
          ) : (
            <div ref={container} role="listbox" aria-labelledby={pagesID} onKeyDown={onKeyDown}>
              {recent.map((url, index) => (
                <div key={url} className="browser-page-row">
                  <ListRow role="option" aria-selected={index === current} selected={index === current}
                    aria-keyshortcuts="Delete" tabIndex={index === tabIndex ? 0 : -1} className="browser-page" title={url}
                    onFocus={() => setFocused(index)} onClick={() => open(index)}>
                    <AppWindowIcon className="browser-page-icon" aria-hidden="true" />
                    <span className="browser-page-address">{pageLabel(url)}</span>
                  </ListRow>
                  <IconButton size="xs" className="browser-page-remove" tabIndex={-1} label={`Remove ${pageLabel(url)}`}
                    title="Remove from Pages (Delete)" icon={<XIcon aria-hidden="true" />} onClick={() => remove(index)} />
                </div>
              ))}
            </div>
          )}
        </section>
        {comments.available && comments.url && (
          <PageComments threads={comments.threads} url={comments.url} onOpen={(thread) => {
            onOpenThread(thread)
            if (mobile) onDismiss()
          }} />
        )}
      </div>
      {comments.available && <div className="browser-view-foot"><CommentTarget {...target} /></div>}
    </div>
  )
}

interface PageCommentsProps {
  threads: readonly PageThread[]
  // url is the address that shows.
  url: string
  onOpen(thread: number): void
}

// PageComments is "On this page": the threads of the page that shows, the
// open ones first, each with its pin's number, what was picked, and the
// comment's first line. A thread written under another query of the page
// says its whole address.
function PageComments({ onOpen, threads, url }: PageCommentsProps) {
  const headingID = useId()
  const rows = threads.map((thread) => commentRow(thread, url))
  const open = (index: number) => {
    const row = rows[index]
    if (row) onOpen(row.number)
  }
  const { container, tabIndex, setFocused, onKeyDown } = useRovingRows(rows.length, -1, open)
  return (
    <section className="browser-view-section" aria-labelledby={headingID}>
      <h3 id={headingID} className="browser-view-heading">
        On this page
        {rows.length > 0 && <span className="browser-view-count">{openCount(threads).toLocaleString()} open</span>}
      </h3>
      {rows.length === 0 ? (
        <StatusMessage className="browser-view-empty">
          To comment on this page, choose Comment in the toolbar or press {commentKeys}, then click what you mean.
        </StatusMessage>
      ) : (
        <div ref={container} role="listbox" aria-labelledby={headingID} onKeyDown={onKeyDown}>
          {rows.map((row, index) => (
            <ListRow key={row.number} role="option" aria-selected={false} tabIndex={index === tabIndex ? 0 : -1} className="browser-comment"
              data-closed={row.closed || undefined}
              aria-label={`Thread ${row.number}, ${row.closed ? "resolved" : "open"}: ${row.name}, ${row.title}${row.address ? `, at ${row.address}` : ""}`}
              title={`Thread ${row.number}: ${row.title}${row.address ? `\n${row.address}` : ""}`}
              onFocus={() => setFocused(index)} onClick={() => open(index)}>
              <span className="browser-pin" aria-hidden="true">{row.number}</span>
              <span className="browser-comment-text">
                <span className="browser-comment-name">{row.name}</span>
                <span className="browser-comment-title">{row.title}</span>
                {row.address && <span className="browser-comment-address">{row.address}</span>}
              </span>
            </ListRow>
          ))}
        </div>
      )}
    </section>
  )
}
