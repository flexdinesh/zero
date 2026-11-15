import {
  ALargeSmallIcon, ArrowUpRightIcon, BracesIcon, FileSearchIcon, FolderGit2Icon, FolderOpenIcon, GitBranchIcon, LifeBuoyIcon, PaletteIcon, RouteIcon,
  SearchIcon, SquareTerminalIcon,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import { BrandMark } from "../../components/ui/brand-mark.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Kbd } from "../../components/ui/kbd.tsx"
import { isAbort } from "../../api/http.ts"
import type { ProjectsResponse } from "@zero/contracts"
import { fetchProjects } from "../../api/projects-data.ts"
import { useDelayedFlag } from "../../lib/use-delayed-flag.ts"
import { ProjectList } from "../projects/ProjectList.tsx"
import { useManageRoots } from "../projects/use-manage-roots.ts"
import {
  documentationUrl, guideEntries, listsProjects, projectLines, startEntries,
  type ProjectFacts, type WelcomeAction, type WelcomeEntry,
} from "./welcome-model.ts"

const mac = typeof navigator !== "undefined" && navigator.platform.includes("Mac")

const icons: Record<WelcomeAction, ReactNode> = {
  "open-project": <FolderGit2Icon aria-hidden="true" />,
  "open-folder": <FolderOpenIcon aria-hidden="true" />,
  "find-file": <FileSearchIcon aria-hidden="true" />,
  "show-commands": <SquareTerminalIcon aria-hidden="true" />,
  "find-in-files": <SearchIcon aria-hidden="true" />,
  "source-control": <GitBranchIcon aria-hidden="true" />,
  "walkthroughs": <RouteIcon aria-hidden="true" />,
  "language-servers": <BracesIcon aria-hidden="true" />,
  "color-theme": <PaletteIcon aria-hidden="true" />,
  "font-size": <ALargeSmallIcon aria-hidden="true" />,
  "review-uncommitted": <GitBranchIcon aria-hidden="true" />,
  "report-problem": <LifeBuoyIcon aria-hidden="true" />,
}

type Load =
  | { kind: "loading"; previous: ProjectsResponse | null }
  | { kind: "ready"; value: ProjectsResponse }
  | { kind: "error"; message: string; previous: ProjectsResponse | null }

function loaded(load: Load): ProjectsResponse | null {
  return load.kind === "ready" ? load.value : load.previous
}

interface WelcomeTabProps {
  project: string
  // roots names the served folders.
  roots: readonly string[]
  facts: ProjectFacts
  onAction(action: WelcomeAction): void
  onOpenProject(project: string): void
  onStartupSetting(): void
}

// WelcomeTab (decision 0052) starts a session: open a project, a file, or a
// command; see the open project's branch, changes, and walkthroughs; switch
// among the served projects; and learn what zero does by doing it. A server
// that manages roots also offers Open folder… (decision 0146).
export function WelcomeTab({ facts, onAction, onOpenProject, onStartupSetting, project, roots }: WelcomeTabProps) {
  const lines = projectLines(facts)
  const manageRoots = useManageRoots()
  return (
    <div className="welcome">
      <header className="welcome-header">
        <p className="welcome-meta">Serving {roots.join(", ")}</p>
        <BrandMark className="welcome-mark" size="display" tone="brand" />
        <h1 className="welcome-title">Zero</h1>
        <p className="welcome-tagline">Browse, search, and review local files.</p>
      </header>
      <div className="welcome-columns">
        <div className="welcome-column">
          <section className="welcome-section" aria-labelledby="welcome-start">
            <h2 id="welcome-start">Start</h2>
            <EntryList entries={startEntries(mac, manageRoots)} onAction={onAction} />
          </section>
          {lines.length > 0 && (
            <section className="welcome-section" aria-labelledby="welcome-project">
              <h2 id="welcome-project">This project</h2>
              <ul className="welcome-facts">
                {lines.map((line) => (
                  <li key={line.key}>
                    {line.action ? (
                      <Button variant="link" size="inline" onClick={() => { if (line.action) onAction(line.action) }}>{line.text}</Button>
                    ) : line.text}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <WelcomeProjects project={project} onOpenProject={onOpenProject} />
        </div>
        <div className="welcome-column">
          <section className="welcome-section" aria-labelledby="welcome-guide">
            <h2 id="welcome-guide">What you can do</h2>
            <EntryList entries={guideEntries(mac)} onAction={onAction} />
            <p className="welcome-help">
              <a className="welcome-docs" href={documentationUrl} target="_blank" rel="noreferrer">
                Documentation<ArrowUpRightIcon aria-hidden="true" /><span className="visually-hidden"> (opens in a new tab)</span>
              </a>
              <Button variant="link" size="inline" className="welcome-report" onClick={() => onAction("report-problem")}>Report a problem…</Button>
            </p>
          </section>
        </div>
      </div>
      <p className="welcome-footer">
        Shown when a project opens with no tabs.{" "}
        <Button variant="link" size="inline" onClick={onStartupSetting}>Change in Settings</Button>
      </p>
    </div>
  )
}

function EntryList({ entries, onAction }: { entries: readonly WelcomeEntry[]; onAction(action: WelcomeAction): void }) {
  return (
    <ul className="welcome-entries">
      {entries.map((entry) => (
        <li key={entry.action} className="welcome-entry">
          {icons[entry.action]}
          <span className="welcome-entry-text">
            <Button variant="link" size="inline" onClick={() => onAction(entry.action)}>{entry.label}</Button>
            {entry.description && <span className="welcome-entry-description">{entry.description}</span>}
          </span>
          {entry.shortcut && <Kbd>{entry.shortcut}</Kbd>}
        </li>
      ))}
    </ul>
  )
}

// WelcomeProjects lists the served projects, as the picker does, once there
// is more than one to choose from.
function WelcomeProjects({ project, onOpenProject }: { project: string; onOpenProject(project: string): void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading", previous: null })
  const controller = useRef<AbortController | null>(null)

  // The list starts loading; Retry marks it loading again.
  const read = useCallback(() => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    fetchProjects(next.signal).then(
      (value) => setLoad({ kind: "ready", value }),
      (error: unknown) => {
        if (isAbort(error)) return
        const message = error instanceof Error && error.message ? error.message : "Couldn't list projects."
        setLoad((current) => ({ kind: "error", message, previous: loaded(current) }))
      },
    )
  }, [])
  useEffect(() => {
    read()
    return () => controller.current?.abort()
  }, [read])

  const response = loaded(load)
  const scanning = useDelayedFlag(load.kind === "loading" && response === null, 150)
  if (response && !listsProjects(response)) return null
  if (!response && load.kind === "loading" && !scanning) return null

  const status = load.kind === "error" ? <>
    <span>{load.message}</span>
    <Button variant="outline" onClick={() => {
      setLoad((current) => ({ kind: "loading", previous: loaded(current) }))
      read()
    }}>Retry</Button>
  </> : undefined
  return (
    <section className="welcome-section welcome-projects" aria-labelledby="welcome-projects">
      <h2 id="welcome-projects">Projects</h2>
      {response
        ? <ProjectList response={response} current={project} status={status} onOpen={onOpenProject} />
        : <div className="project-list-status" role="status" aria-live="polite">{status ?? "Scanning for projects…"}</div>}
    </section>
  )
}
