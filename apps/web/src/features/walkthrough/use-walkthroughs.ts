import { isWalkthrough, isWalkthroughSummary, type Walkthrough, type WalkthroughSummary } from "@zero/contracts"
import { useCallback, useEffect, useRef, useState } from "react"

import { deleteResource, failureReason, fetchJSON, isAbort, RequestError } from "../../api/http.ts"
import { projectUrl } from "../../api/project-url.ts"
import { updateWalkthroughs, type WalkthroughsState } from "./walkthroughs-state.ts"

export type { WalkthroughsState } from "./walkthroughs-state.ts"

// walkthroughUnavailableCode marks a 404 for a walkthrough the store lacks.
const walkthroughUnavailableCode = "walkthroughUnavailable"

// GET /api/walkthroughs answers a bare array of summaries.
function isWalkthroughSummaries(value: unknown): value is WalkthroughSummary[] {
  return Array.isArray(value) && value.every(isWalkthroughSummary)
}

// pollInterval is how often the list rereads while the page is visible:
// agents publish without the browser knowing (decision 0047).
const pollInterval = 5_000

function listError(reason: string): string {
  return `Couldn't read walkthroughs: ${reason}.`
}

// useWalkthroughs lists a project's walkthroughs, rereading every few
// seconds while the page is visible and whenever it returns to view.
export function useWalkthroughs(project: string) {
  const [state, setState] = useState<WalkthroughsState>({ result: null, error: "", loading: false })
  const controller = useRef<AbortController | null>(null)
  const lifetime = useRef<{ project: string } | null>(null)
  const load = useCallback((foreground: boolean) => {
    if (!project || lifetime.current?.project !== project) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    if (foreground) setState((previous) => updateWalkthroughs(previous, { kind: "start" }))
    fetchJSON(projectUrl("/api/walkthroughs", project), { signal: current.signal }, isWalkthroughSummaries, (failure) => listError(failureReason(failure)))
      .then((result) => {
        if (controller.current !== current || current.signal.aborted) return
        setState((previous) => updateWalkthroughs(previous, { kind: "success", result }))
      }, (error: unknown) => {
        if (controller.current !== current || current.signal.aborted || isAbort(error)) return
        setState((previous) => updateWalkthroughs(previous, { kind: "error", error: error instanceof Error ? error.message : listError("unknown error") }))
      })
  }, [project])
  const refresh = useCallback(() => load(true), [load])

  useEffect(() => {
    lifetime.current = { project }
    refresh()
    const background = () => load(false)
    let timer = 0
    const schedule = () => {
      window.clearInterval(timer)
      if (document.visibilityState === "visible") timer = window.setInterval(background, pollInterval)
    }
    const returned = () => {
      if (document.visibilityState === "visible") background()
      schedule()
    }
    schedule()
    document.addEventListener("visibilitychange", returned)
    window.addEventListener("focus", background)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", returned)
      window.removeEventListener("focus", background)
      lifetime.current = null
      controller.current?.abort()
      controller.current = null
    }
  }, [load, project, refresh])

  // remove deletes a walkthrough, then rereads the list.
  const remove = useCallback(async (id: string) => {
    const currentLifetime = lifetime.current
    const url = `/api/walkthroughs?${new URLSearchParams({ project, id }).toString()}`
    await deleteResource(url, {}, (failure) => `Couldn't delete the walkthrough: ${failureReason(failure)}.`)
    if (lifetime.current === currentLifetime) refresh()
  }, [project, refresh])

  return { ...state, refresh, remove }
}

export type Walkthroughs = ReturnType<typeof useWalkthroughs>

export type WalkthroughDetail =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; walkthrough: Walkthrough }
  | { kind: "missing" }
  | { kind: "error"; message: string }

function detailError(reason: string): string {
  return `Couldn't read the walkthrough: ${reason}.`
}

// useWalkthrough reads one walkthrough, again whenever version (its listed
// updatedAt) changes, keeping the last one shown while it rereads.
export function useWalkthrough(project: string, id: string, version: string) {
  const [detail, setDetail] = useState<{ project: string; id: string; detail: WalkthroughDetail }>({ project: "", id: "", detail: { kind: "none" } })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!project || !id) return
    const controller = new AbortController()
    setDetail((previous) => previous.project === project && previous.id === id && previous.detail.kind === "ready" ? previous : { project, id, detail: { kind: "loading" } })
    const url = `/api/walkthrough?${new URLSearchParams({ project, id }).toString()}`
    fetchJSON(url, { signal: controller.signal }, isWalkthrough, (failure) => detailError(failureReason(failure)))
      .then((walkthrough) => {
        if (controller.signal.aborted) return
        setDetail({ project, id, detail: { kind: "ready", walkthrough } })
      }, (error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return
        const missing = error instanceof RequestError && error.failure.kind === "rejected" && error.failure.code === walkthroughUnavailableCode
        setDetail({ project, id, detail: missing ? { kind: "missing" } : { kind: "error", message: error instanceof Error ? error.message : detailError("unknown error") } })
      })
    return () => controller.abort()
  }, [attempt, id, project, version])
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  return { detail: id && detail.project === project && detail.id === id ? detail.detail : { kind: "none" } satisfies WalkthroughDetail, retry }
}
