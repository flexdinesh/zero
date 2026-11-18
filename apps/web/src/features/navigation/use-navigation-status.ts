import { useCallback, useEffect, useRef, useState } from "react"

import { fetchJSON } from "../../api/http.ts"
import { isNavigationStatus, type NavigationStatus } from "@zero/contracts"
import { LANGUAGE_SERVER_HEADER, navigationStatusQuery, pollsServer, sameNavigationStatus } from "./navigation-status.ts"

const POLL_MS = 3_000

export interface NavigationStatusState {
  // status is null until loaded or when availability could not be checked.
  status: NavigationStatus | null
  // check looks again for installed servers and retries failed ones.
  check(): void
  // refresh reloads the status, e.g. after a navigation started a server.
  refresh(): void
}

// useNavigationStatus follows who answers navigation for the open file.
// It never starts servers; it polls only while one is starting or running.
export function useNavigationStatus(project: string, path: string, textFile: boolean, languageServers: boolean): NavigationStatusState {
  const [status, setStatus] = useState<NavigationStatus | null>(null)
  const controller = useRef<AbortController | null>(null)
  const load = useCallback((refresh: boolean) => {
    controller.current?.abort()
    if (!textFile || !path) {
      setStatus(null)
      return
    }
    const current = new AbortController()
    controller.current = current
    const headers: Record<string, string> = languageServers ? { [LANGUAGE_SERVER_HEADER]: "on" } : {}
    // Any failure shows that availability could not be checked.
    fetchJSON(`/api/navigation-status?${navigationStatusQuery(project, path, refresh)}`, { headers, signal: current.signal },
      isNavigationStatus, () => "Couldn't check language server availability.")
      .then((body) => {
        if (!current.signal.aborted && controller.current === current) setStatus((previous) => sameNavigationStatus(previous, body) ? previous : body)
      }, () => {
        if (!current.signal.aborted && controller.current === current) setStatus(null)
      })
  }, [languageServers, textFile, path, project])

  const check = useCallback(() => load(true), [load])
  const refresh = useCallback(() => load(false), [load])
  useEffect(() => {
    setStatus(null)
    refresh()
    return () => {
      controller.current?.abort()
      controller.current = null
    }
  }, [refresh])

  const polling = pollsServer(status)
  useEffect(() => {
    if (!polling) return
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [polling, refresh])

  return { status, check, refresh }
}
