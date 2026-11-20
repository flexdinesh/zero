import { AppWindowIcon, XIcon } from "lucide-react"
import { useId } from "react"

import { IconButton } from "../../components/ui/icon-button.tsx"
import { ListRow } from "../../components/ui/list-row.tsx"
import { StatusMessage } from "../../components/ui/notice.tsx"
import { ViewHeader } from "../../components/ui/view-header.tsx"
import { useRovingRows } from "../../lib/use-roving-rows.ts"
import { pageLabel } from "./review-model.ts"
import type { ProjectBrowser } from "./use-project-browser.ts"

interface BrowserViewProps {
  browser: ProjectBrowser
  mobile: boolean
  onDismiss(): void
  // onOpen shows a page in the project's Browser tab and brings the tab
  // forward.
  onOpen(url: string): void
}

// BrowserView is the Browser activity (decision 0184): the project's pages,
// most recent first, with the one its Browser tab shows marked. Choosing a
// page opens it in the tab.
export function BrowserView({ browser, mobile, onDismiss, onOpen }: BrowserViewProps) {
  const { recent, state } = browser
  const pagesID = useId()
  const current = state ? recent.indexOf(state.url) : -1
  const open = (index: number) => {
    const url = recent[index]
    if (!url) return
    onOpen(url)
    if (mobile) onDismiss()
  }
  const { container, tabIndex, setFocused, onKeyDown } = useRovingRows(recent.length, current, open)
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
                <ListRow key={url} role="option" aria-selected={index === current} selected={index === current}
                  tabIndex={index === tabIndex ? 0 : -1} className="browser-page" title={url}
                  onFocus={() => setFocused(index)} onClick={() => open(index)}>
                  <AppWindowIcon className="browser-page-icon" aria-hidden="true" />
                  <span className="browser-page-address">{pageLabel(url)}</span>
                </ListRow>
              ))}
            </div>
          )}
        </section>
        {/* Layer 4: the "On this page" section, the shown page's threads, goes here. */}
      </div>
      {/* Layer 4: the "Comments go to <folder> · <branch>" footer goes here (CommentTarget). */}
    </div>
  )
}
