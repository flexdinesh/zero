import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"

import { useSearchSession, type SearchSession, type SearchSessionOptions } from "./use-search-session.ts"

export interface SearchCommands {
  open(): void
  markStale(shown: boolean): void
}

interface SearchSummary {
  searchPattern: string
  searchFiles: number
}

const SessionContext = createContext<SearchSession | undefined>(undefined)
const SummaryContext = createContext<SearchSummary | undefined>(undefined)

interface SearchProviderProps extends SearchSessionOptions {
  children: ReactNode
  registerCommands(commands: SearchCommands | null): void
}

// One project session survives sidebar hiding and document/tab navigation.
// The workspace uses registered commands; only feature leaves subscribe.
export function SearchProvider({ children, registerCommands, ...options }: SearchProviderProps) {
  const session = useSearchSession(options)
  const { show, markStale } = session
  useEffect(() => {
    registerCommands({ open: show, markStale })
    return () => registerCommands(null)
  }, [registerCommands, show, markStale])
  const searchPattern = session.query.pattern
  const searchFiles = session.results?.files.length ?? 0
  const summary = useMemo(() => ({ searchPattern, searchFiles }), [searchPattern, searchFiles])
  return <SessionContext value={session}><SummaryContext value={summary}>{children}</SummaryContext></SessionContext>
}

export function useSearchSessionState() {
  const session = useContext(SessionContext)
  if (session === undefined) throw new Error("useSearchSessionState requires SearchProvider")
  return session
}

export function useSearchSummary() {
  const summary = useContext(SummaryContext)
  if (summary === undefined) throw new Error("useSearchSummary requires SearchProvider")
  return summary
}
