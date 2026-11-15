import { FolderOpenIcon } from "lucide-react"
import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"

import type { ProjectsResponse } from "@zero/contracts"
import { Button } from "../../components/ui/button.tsx"
import { isAbort } from "../../api/http.ts"
import { fetchProjects, lastOpened } from "../../api/projects-data.ts"
import { useDelayedFlag } from "../../lib/use-delayed-flag.ts"
import { TitleBar } from "../../workspace/TitleBar.tsx"
import { useDesktopOpenFolder } from "../../workspace/use-desktop-open-folder.ts"
import { readMemory } from "../../workspace/workspace-memory.ts"
import { usePresence } from "../live-updates/use-presence.ts"
import { ProjectList } from "./ProjectList.tsx"
import { ProjectPicker, type PickerOpenOptions } from "./ProjectPicker.tsx"

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

// ChooseProject is what a link that names no project shows while there is a
// choice (decision 0153): the served projects, the last opened one marked,
// and nothing loaded until one is picked.
export function ChooseProject() {
  usePresence()
  const navigate = useNavigate()
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
    void navigate({ to: "/", search: { project }, hash: "" })
  }, [navigate])
  const registerPicker = useCallback((next: ((options?: PickerOpenOptions) => void) | null) => {
    openPicker.current = next ?? (() => {})
  }, [])
  const openFolder = useCallback(() => openPicker.current({ browse: true }), [])
  useDesktopOpenFolder(openFolder)

  const response = loaded(load)
  const last = response ? lastOpened(response, readMemory()) : ""
  const scanning = useDelayedFlag(load.kind === "loading" && response === null, 150)
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
          <h1 className="choose-project-title">Choose a project</h1>
          {response && <p className="choose-project-summary">Serving {count(response.roots.length, "folder", "folders")}.</p>}
          {response
            ? <ProjectList response={response} current="" last={last} enter autoFocus status={status} onOpen={open} />
            : <div className="project-list-status" role="status" aria-live="polite">{status ?? (scanning ? "Scanning for projects…" : "")}</div>}
          {response?.manageRoots && (
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
