import { FolderOpenIcon } from "lucide-react"
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"

import type { ProjectsResponse } from "@zero/contracts"
import { Button } from "../../components/ui/button.tsx"
import { isAbort } from "../../api/http.ts"
import { checkoutsOf, fetchProjects, landing, lastOpened, repoKey } from "../../api/projects-data.ts"
import { desktopBridge, type ProjectMatch } from "../../lib/desktop-bridge.ts"
import { useDelayedFlag } from "../../lib/use-delayed-flag.ts"
import { TitleBar } from "../../workspace/TitleBar.tsx"
import { useDesktopOpenFolder } from "../../workspace/use-desktop-open-folder.ts"
import { readMemory } from "../../workspace/workspace-memory.ts"
import { usePresence } from "../live-updates/use-presence.ts"
import { ProjectList } from "./ProjectList.tsx"
import { ProjectPicker } from "./ProjectPicker.tsx"
import type { PickerOpenOptions } from "./project-picker.ts"

type Load =
  | { kind: "loading"; previous: ProjectsResponse | null }
  | { kind: "ready"; value: ProjectsResponse }
  | { kind: "error"; message: string; previous: ProjectsResponse | null }

function loaded(load: Load): ProjectsResponse | null {
  return load.kind === "ready" ? load.value : load.previous
}

const title = "Choose a project · Zero"

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// useElsewhere asks the desktop app which other open connections serve a
// checkout of the identity, when this server has none (decision 0188).
function useElsewhere(identity: string) {
  const [found, setFound] = useState<{ identity: string; matches: ProjectMatch[] }>({ identity: "", matches: [] })
  useEffect(() => {
    const findProject = desktopBridge()?.findProject
    if (!identity || !findProject) return
    let current = true
    void findProject(identity).then((matches) => {
      if (current) setFound({ identity, matches })
    })
    return () => {
      current = false
    }
  }, [identity])
  const open = useCallback((match: ProjectMatch) => desktopBridge()?.openProject?.(match.connection, match.project), [])
  return { matches: found.identity === identity ? found.matches : [], open }
}

// ChooseProject is what a link that names no project shows (decisions 0153,
// 0191): the served projects, the last opened one marked, and nothing
// loaded until one is picked. It paints before projects are listed, and
// says so when no folder is served (decision 0193). A link that names a
// repository identity (repo=, decision 0188) lists its checkouts, or says
// this server has none and lists every project; the pick keeps the link's
// target.
export function ChooseProject() {
  usePresence()
  const navigate = useNavigate()
  const search = useSearch({ strict: false })
  const hash = useRouterState({ select: (state) => state.location.hash })
  const repo = typeof search.repo === "string" ? repoKey(search.repo) : ""
  const [showAll, setShowAll] = useState(false)
  const [load, setLoad] = useState<Load>({ kind: "loading", previous: null })
  const controller = useRef<AbortController | null>(null)
  const openPicker = useRef<(options?: PickerOpenOptions) => void>(() => {})

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
  useEffect(() => {
    document.title = title
  }, [])

  const open = useCallback((project: string) => {
    const { project: _project, repo: _repo, ...target } = search
    if (Object.values(target).some((value) => value !== undefined)) void navigate({ to: "/view", search: { project, ...target }, hash })
    else void navigate({ to: "/", search: { project }, hash: "" })
  }, [hash, navigate, search])
  const registerPicker = useCallback((next: ((options?: PickerOpenOptions) => void) | null) => {
    openPicker.current = next ?? (() => {})
  }, [])
  const openFolder = useCallback(() => openPicker.current({ browse: true }), [])
  useDesktopOpenFolder(openFolder)

  const response = loaded(load)
  const last = response ? lastOpened(response, readMemory()) : ""
  const checkouts = response && repo ? checkoutsOf(response, repo).length : 0
  const identity = checkouts > 0 && !showAll ? repo : ""
  const elsewhere = useElsewhere(response && repo && checkouts === 0 ? repo : "")
  const scanning = useDelayedFlag(load.kind === "loading" && response === null, 150)
  // Serving no folder there is nothing to choose: the page says so, as the
  // workspace did (decision 0193).
  const noFolder = response !== null && !repo && landing(response).kind === "none"
  const status = load.kind === "error" ? <>
    <span>{load.message}</span>
    <Button variant="outline" onClick={() => {
      setLoad((current) => ({ kind: "loading", previous: loaded(current) }))
      read()
    }}>Retry</Button>
  </> : undefined
  return (
    <>
      <TitleBar title={title} />
      <main className="choose-project">
        <div className="choose-project-body">
          <h1 className="choose-project-title">{identity ? "Choose a checkout" : "Choose a project"}</h1>
          {noFolder ? <p className="choose-project-summary">No folder is open.</p> : response && (identity
            ? <p className="choose-project-summary">
              {count(checkouts, "checkout", "checkouts")} of <span className="choose-project-identity">{repo}</span>.{" "}
              <Button variant="link" size="inline" onClick={() => setShowAll(true)}>Show all projects</Button>
            </p>
            : <p className="choose-project-summary">
              {repo && checkouts === 0 && <>No checkout of <span className="choose-project-identity">{repo}</span> on this server.{" "}</>}
              Serving {count(response.roots.length, "folder", "folders")}.
            </p>)}
          {elsewhere.matches.length > 0 && (
            <ul className="choose-project-elsewhere" aria-label="Open elsewhere">
              {elsewhere.matches.map((match) => (
                <li key={`${match.connection}\n${match.project}`}>
                  <Button variant="outline" title={match.project} onClick={() => elsewhere.open(match)}>Open in {match.label}</Button>
                </li>
              ))}
            </ul>
          )}
          {noFolder ? response?.manageRoots === true && (
            <Button variant="outline" onClick={openFolder}><FolderOpenIcon aria-hidden="true" />Open folder…</Button>
          ) : response
            ? <ProjectList key={identity} response={response} current="" last={last} enter autoFocus status={status} identity={identity} onOpen={open} />
            : <div className="project-list-status" role="status" aria-live="polite">{status ?? (scanning ? "Scanning for projects…" : "")}</div>}
          {!noFolder && response?.manageRoots && (
            <div className="choose-project-actions">
              <Button variant="link" size="inline" onClick={openFolder}><FolderOpenIcon aria-hidden="true" />Open folder…</Button>
            </div>
          )}
        </div>
      </main>
      <ProjectPicker project="" registerOpen={registerPicker} onOpen={open} />
    </>
  )
}
