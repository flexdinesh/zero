import { FunnelIcon, XIcon } from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"

import type { ProjectsResponse } from "@zero/contracts"
import { IconButton } from "../../components/ui/icon-button.tsx"
import { ListButton } from "../../components/ui/list-row.tsx"
import { Chevron } from "../../components/ui/section-toggle.tsx"
import { TextField } from "../../components/ui/text-field.tsx"
import { readMemory, rememberedProjects } from "../../workspace/workspace-memory.ts"
import { OptionIcon, OptionText } from "./ProjectPicker.tsx"
import type { ProjectRow } from "./project-picker.ts"
import { enterTarget, holdsLast, projectListSections, type ProjectListEntry } from "./project-list.ts"

interface ProjectListProps {
  response: ProjectsResponse
  // current marks the open project; last marks the one last opened.
  current: string
  last?: string
  // enter opens the filter's target on Enter (decision 0153).
  enter?: boolean
  autoFocus?: boolean
  // status is the caller's loading or error line, shown above the rows.
  status?: ReactNode
  onOpen(project: string): void
}

// ProjectList lists the served projects as the picker does, under a filter:
// Welcome's Projects (decision 0052) and the choose-project page (0153).
export function ProjectList({ response, current, last = "", enter = false, autoFocus = false, status, onOpen }: ProjectListProps) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const remembered = useMemo(() => rememberedProjects(readMemory()), [])
  const sections = useMemo(() => projectListSections(response, remembered, current, query), [current, query, remembered, response])

  const toggle = (group: string) => setExpanded((existing) => {
    const next = new Set(existing)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    return next
  })
  const trimmed = query.trim()
  return (
    <div className="project-list">
      <TextField className="project-list-filter" icon={<FunnelIcon />} type="text" autoComplete="off" spellCheck={false}
        placeholder="Filter projects" aria-label="Filter projects" value={query} autoFocus={autoFocus}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation()
            setQuery("")
          }
          if (event.key === "Enter" && enter) {
            const target = enterTarget(sections, last, query)
            if (target) {
              event.preventDefault()
              onOpen(target)
            }
          }
        }}
        trailing={query && <IconButton size="xs" label="Clear filter" icon={<XIcon aria-hidden="true" />} onClick={() => setQuery("")} />} />
      <div className="project-list-status" role="status" aria-live="polite">
        {status ?? (trimmed && sections.length === 0 ? `No projects match “${trimmed}”.` : "")}
      </div>
      {sections.map((section) => (
        <div key={section.title} className="project-list-group">
          {sections.length > 1 && <h3 className="project-group-title">{section.title}</h3>}
          <ul aria-label={section.title}>
            {section.rows.map((entry) => (
              <ProjectEntry key={entry.row.key} entry={entry} last={last} expanded={expanded.has(entry.row.group)}
                onToggle={() => toggle(entry.row.group)} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

interface ProjectEntryProps {
  entry: ProjectListEntry
  last: string
  expanded: boolean
  onToggle(): void
  onOpen(project: string): void
}

function ProjectEntry({ entry, last, expanded, onToggle, onOpen }: ProjectEntryProps) {
  const { row, worktrees } = entry
  return (
    <li>
      <div className={worktrees.length ? "project-option-row drillable" : "project-option-row"}>
        <ProjectButton row={row} last={holdsLast(entry, last)} onOpen={onOpen} />
        {worktrees.length > 0 && (
          <IconButton size="xs" className="project-drill project-list-expand" aria-expanded={expanded}
            label={`${expanded ? "Hide" : "Show"} ${row.name} worktrees`} icon={<Chevron />} onClick={onToggle} />
        )}
      </div>
      {expanded && worktrees.length > 0 && (
        <ul className="project-list-worktrees" aria-label={`${row.name} worktrees`}>
          {worktrees.map((member) => (
            <li key={member.key} className="project-option-row">
              <ProjectButton row={member} last={last !== "" && member.id === last} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function ProjectButton({ row, last, onOpen }: { row: ProjectRow; last: boolean; onOpen(project: string): void }) {
  const inert = row.disabled || row.current
  return (
    <ListButton density="pick" className={row.disabled ? "project-option disabled" : "project-option"}
      aria-current={row.current || undefined} aria-disabled={row.disabled || undefined} title={row.path}
      onClick={() => { if (!inert) onOpen(row.id) }}>
      <OptionIcon row={row} />
      <OptionText row={row} last={last} />
    </ListButton>
  )
}
