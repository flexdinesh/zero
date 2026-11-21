import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

import { fetchProjects } from "../../api/projects-data.ts"
import { localPlace, type AgentPlace } from "../../lib/agent-place.ts"

const PlaceContext = createContext<AgentPlace>(localPlace)

// ServerPlaceProvider reads once where the served projects are from this
// page's side and the serving machine's name (decision 0187), for every
// surface that tells the user where agents run: local until known or when
// projects cannot be listed.
export function ServerPlaceProvider({ children }: { children: ReactNode }) {
  const [place, setPlace] = useState(localPlace)
  useEffect(() => {
    const abort = new AbortController()
    fetchProjects(abort.signal).then((value) => setPlace({ place: value.place, host: value.host }), () => undefined)
    return () => abort.abort()
  }, [])
  return <PlaceContext.Provider value={place}>{children}</PlaceContext.Provider>
}

// useServerPlace is the nearest ServerPlaceProvider's place.
export function useServerPlace(): AgentPlace {
  return useContext(PlaceContext)
}
