import { useCallback, useMemo, useRef, type KeyboardEvent } from "react"

import { Button } from "../../components/ui/button.tsx"
import { ListRow } from "../../components/ui/list-row.tsx"
import { StatusMessage } from "../../components/ui/notice.tsx"
import { useRowWindow } from "../../components/ui/use-row-window.ts"
import { FileIcon } from "../../components/FileIcon.tsx"
import { displayOrder, statusLetters, statusNames, type CompareFile, type FileList } from "./compare-files.ts"
import type { ChangesView } from "./source-control-layout.ts"
import { fileParts } from "./source-control-panes.ts"
import { FilesTree, type CollapseRequest } from "./FilesTree.tsx"
import { FileStatsText } from "./DiffStatsText.tsx"
import { pureRename } from "./diff-stats.ts"
import { statsLabel, type CompareStats } from "./use-compare-stats.ts"

interface UncommittedPaneProps {
  list: FileList
  stats: CompareStats | null
  warnings: readonly string[]
  view: ChangesView
  // activePath is the Uncommitted review's current file (decision 0137).
  activePath: string
  itemHeight: number
  visible: boolean
  mobile: boolean
  collapseRequest: CollapseRequest | null
  onExpandedChange(expanded: boolean): void
  // onOpen reviews a file; focusDocument moves focus to the review.
  onOpen(path: string, focusDocument: boolean): void
  onRetry(): void
}

// UncommittedPane lists the working tree's changes (decision 0040): a flat
// list of names and folders by default, or a tree. Opening a file shows it in
// the Uncommitted review.
export function UncommittedPane({
  activePath, collapseRequest, itemHeight, list, mobile, stats, view, visible, warnings, onExpandedChange, onOpen, onRetry,
}: UncommittedPaneProps) {
  return (
    <div className="changes-pane">
      {list.kind === "loading" && <div className="source-control-message"><StatusMessage>Reading changes…</StatusMessage></div>}
      {list.kind === "error" && (
        <div className="source-control-message" role="alert">
          <StatusMessage tone="error">{list.message}</StatusMessage>
          <Button variant="outline" onClick={onRetry}>Retry</Button>
        </div>
      )}
      {list.kind === "ready" && list.files.length === 0 && (
        <div className="source-control-message"><StatusMessage>No changes since last commit.</StatusMessage></div>
      )}
      {list.kind === "ready" && list.truncated && (
        <div className="source-control-message"><StatusMessage>Showing the first {list.files.length.toLocaleString()} changes.</StatusMessage></div>
      )}
      {list.kind === "ready" && (view === "tree"
        ? list.files.length > 0 && <FilesTree key={itemHeight} files={list.files} stats={stats?.byPath ?? null} activePath={activePath} itemHeight={itemHeight}
          label="Uncommitted changes" collapseRequest={collapseRequest} onExpandedChange={onExpandedChange} onOpen={onOpen} />
        : <FlatFiles files={list.files} stats={stats} activePath={activePath} visible={visible} mobile={mobile} onOpen={onOpen} />)}
      {warnings.length > 0 && (
        <details className="warnings">
          <summary>Some paths could not be read</summary>
          <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
      )}
    </div>
  )
}

interface FlatFilesProps {
  files: readonly CompareFile[]
  stats: CompareStats | null
  activePath: string
  visible: boolean
  mobile: boolean
  onOpen(path: string, focusDocument: boolean): void
}

// FlatFiles lists changed files by path, as VS Code's list view does: click
// or Space opens and keeps focus; Enter and double-click move it to the
// review. Rows follow the review's order, the Files tree's (decision 0117).
function FlatFiles({ activePath, files: changed, mobile, stats, visible, onOpen }: FlatFilesProps) {
  const files = useMemo(() => displayOrder(changed), [changed])
  const keys = useMemo(() => files.map((file) => file.path), [files])
  const desktopScroll = useRef<HTMLDivElement>(null)
  const focusHeader = useCallback(() => desktopScroll.current?.closest(".scm-pane")
    ?.querySelector<HTMLElement>(".scm-pane-toggle")?.focus(), [])
  const rowWindow = useRowWindow({ keys, scroll: desktopScroll, sharedScroll: mobile,
    visible, selectedKey: activePath, onEmptyFocus: focusHeader })
  const { focusRow, positions, tabKey: tabPath } = rowWindow

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = positions.get(tabPath) ?? -1
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = files[index + (event.key === "ArrowDown" ? 1 : -1)]
      if (next) focusRow(next.path)
    } else if (event.key === "Home" || event.key === "End") {
      const next = event.key === "Home" ? files[0] : files.at(-1)
      if (next) focusRow(next.path)
    } else if (event.key === " " || event.key === "Enter") {
      if (tabPath) onOpen(tabPath, event.key === "Enter")
    } else {
      return
    }
    event.preventDefault()
  }

  return (
    <div ref={desktopScroll} className="changes-scroll" hidden={!files.length}>
      <div ref={rowWindow.region} className="changes-list row-window" role="listbox" aria-label="Uncommitted changes"
        style={rowWindow.regionStyle} data-windowed={rowWindow.windowed || undefined} onKeyDown={onKeyDown}
        onFocusCapture={rowWindow.onFocus} onBlurCapture={rowWindow.onBlur}>
        <div ref={rowWindow.estimateProbe} className="row-window-estimate" aria-hidden="true" />
        {rowWindow.indexes.map((index) => {
          const file = files[index]
          if (!file) return null
          const { name, folder } = fileParts(file.path)
          const fileStats = stats?.byPath.get(file.path)
          // A rename without line changes says so in its status already.
          const renamed = pureRename(fileStats, file.oldPath)
          const lines = renamed ? "" : statsLabel(fileStats)
          const selected = file.path === activePath
          return (
            <ListRow indent="nested" key={file.path} data-path={file.path} data-window-key={file.path} role="option"
              style={rowWindow.rowStyle(index)} aria-posinset={index + 1} aria-setsize={files.length} aria-selected={selected} selected={selected}
              tabIndex={file.path === tabPath ? 0 : -1} className="changes-row" data-status={file.status}
              aria-label={`${file.path}, ${statusNames[file.status]}${lines ? `, ${lines}` : ""}`}
              title={file.oldPath ? `${file.path}\nRenamed from ${file.oldPath}` : file.path}
              onClick={() => onOpen(file.path, false)}
              onDoubleClick={() => onOpen(file.path, true)}>
              <FileIcon path={file.path} />
              <span className="changes-row-name">{name}</span>
              <span className="changes-row-folder">{folder}</span>
              {(lines || renamed) && <span className="changes-row-stats"><FileStatsText stats={fileStats} oldPath={file.oldPath} /></span>}
              <span className="commit-file-status" data-status={file.status} aria-hidden="true">{statusLetters[file.status]}</span>
            </ListRow>
          )
        })}
      </div>
    </div>
  )
}
