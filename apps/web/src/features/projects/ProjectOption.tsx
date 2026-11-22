import { CheckIcon, CornerDownLeftIcon, FolderGit2Icon, FolderIcon, FolderOpenIcon, FolderSearchIcon, GitForkIcon, HistoryIcon } from "lucide-react"

import type { PickerRow } from "./project-picker.ts"

// OptionIcon and OptionText draw a row's icon and text; Welcome's project
// list shares them.
export function OptionIcon({ row }: { row: PickerRow }) {
  switch (row.kind) {
    case "browse": return <FolderSearchIcon aria-hidden="true" />
    case "open": return <CornerDownLeftIcon aria-hidden="true" />
    case "directory": return row.isProject ? <FolderGit2Icon aria-hidden="true" /> : <FolderIcon aria-hidden="true" />
    case "project":
      switch (row.projectKind) {
        case "repo": return <FolderGit2Icon aria-hidden="true" />
        case "worktree": return <GitForkIcon className="worktree-icon" aria-hidden="true" />
        case "opened": return <FolderOpenIcon aria-hidden="true" />
        case "folder": return <FolderIcon aria-hidden="true" />
      }
  }
}

// OptionPath truncates from the start so the deepest folders stay visible.
function OptionPath({ path, title = path }: { path: string; title?: string }) {
  return <span className="project-option-path project-option-path-tail" title={title}><span dir="ltr">{path}</span></span>
}

// last marks the project last opened when choosing one (decision 0153).
export function OptionText({ row, last = false }: { row: PickerRow; last?: boolean }) {
  switch (row.kind) {
    case "browse":
      return <>
        <span className="project-option-name">Open folder…</span>
        <span className="project-option-grow" />
        <kbd className="project-option-meta">/</kbd>
      </>
    case "open":
      return <>
        <span className="project-option-name">Open</span>
        <OptionPath path={`${row.path}/`} />
      </>
    case "directory":
      return <>
        <span className="project-option-name">{row.name}</span>
        <span className="project-option-grow" />
        {row.problem
          ? <span className="project-option-meta project-option-problem" title={row.problem}>{row.note}</span>
          : row.isProject && <span className="project-option-meta">git · opens whole</span>}
      </>
    case "project":
      return <>
        {row.repository && row.projectKind !== "opened" && <span className="project-option-meta">{row.repository} ›</span>}
        <span className="project-option-name">{row.name}</span>
        {row.branch && row.branch !== row.name && <span className="project-option-branch">{row.branch}</span>}
        {row.location
          ? row.location !== row.name && <OptionPath path={row.location} title={row.path} />
          : <span className="project-option-path" title={row.path}>served folder</span>}
        <span className="project-option-grow" />
        {row.identity && <span className="project-option-meta project-option-identity" title={row.identity}>{row.identity}</span>}
        {row.disabled && <span className={row.problem ? "project-option-meta project-option-problem" : "project-option-meta"} title={row.problem || undefined}>{row.note}</span>}
        {row.worktrees > 1 && <span className="project-option-meta">{row.worktrees} worktrees</span>}
        {row.current && <span className="project-option-current"><CheckIcon aria-hidden="true" />Current</span>}
        {last && !row.current && <span className="project-option-current"><HistoryIcon aria-hidden="true" />Last opened</span>}
      </>
  }
}
