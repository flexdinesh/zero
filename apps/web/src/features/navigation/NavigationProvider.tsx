import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, type ReactNode, type RefObject } from "react"
import type { NavigationLocation } from "@zero/contracts"

import type { DocumentMode } from "../documents/DocumentModeToggle.tsx"
import type { SourceNavigation } from "../documents/SourceDocument.tsx"
import { navigationEligibility, type NavigationKind } from "./code-navigation.ts"
import { NavigationDialog } from "./NavigationDialog.tsx"
import { NavigationStatusPanel, type NavigationStatusPanelProps } from "./NavigationStatusPanel.tsx"
import type { SourceTarget } from "./source-position.ts"
import { useCodeNavigation } from "./use-code-navigation.ts"
import { useNavigationStatus } from "./use-navigation-status.ts"

export interface NavigationCaret {
  path: string
  target: SourceTarget
}

type NavigationCommand = (kind: NavigationKind) => void
type StatusDetails = Pick<NavigationStatusPanelProps, "status" | "onCheck">
const SourceContext = createContext<SourceNavigation | null | undefined>(undefined)
const StatusContext = createContext<StatusDetails | undefined>(undefined)

interface NavigationProviderProps {
  children: ReactNode
  project: string
  path: string
  textFile: boolean
  languageServers: boolean
  source: boolean
  supported: boolean
  mode: DocumentMode | null
  isLoading: boolean
  caret: RefObject<NavigationCaret | null>
  openLocation(location: NavigationLocation): void
  registerCommand(command: NavigationCommand | null): void
}

// One project owner. Polling and navigation dialogs update their consumers,
// while the workspace children retain their parent's identity.
export function NavigationProvider({ children, project, path, textFile, languageServers, source, supported, mode, isLoading, caret, openLocation, registerCommand }: NavigationProviderProps) {
  const { status, check, refresh } = useNavigationStatus(project, path, textFile, languageServers)
  const { panel, request, explain, close } = useCodeNavigation(project, languageServers, openLocation, refresh)
  const reason = navigationEligibility(source, supported, languageServers, status)
  const navigable = reason === ""
  const navigation = useMemo((): SourceNavigation | null => navigable ? {
    onPoint(target) { caret.current = { path, target } },
    onNavigate(kind, target) {
      if (target) caret.current = { path, target }
      const remembered = caret.current?.path === path ? caret.current.target : null
      if (remembered) request(kind, path, remembered)
      else explain(kind, "Click a name in the code first, then try again.")
    },
  } : null, [caret, explain, navigable, path, request])
  const run = useCallback((kind: NavigationKind) => {
    if (navigation) navigation.onNavigate(kind, null)
    else explain(kind, reason)
  }, [explain, navigation, reason])
  useLayoutEffect(() => {
    registerCommand(run)
    return () => registerCommand(null)
  }, [registerCommand, run])
  useEffect(() => { close() }, [close, path, mode, languageServers])
  useEffect(() => { if (isLoading) close() }, [close, isLoading])
  const openResult = useCallback((location: NavigationLocation) => { close(); openLocation(location) }, [close, openLocation])
  const details = useMemo(() => ({ status, onCheck: check }), [check, status])
  return <SourceContext.Provider value={navigation}><StatusContext.Provider value={details}>
    {children}
    <NavigationDialog panel={panel} onClose={close} onOpen={openResult} />
  </StatusContext.Provider></SourceContext.Provider>
}

export function useSourceNavigation(): SourceNavigation | undefined {
  const navigation = useContext(SourceContext)
  if (navigation === undefined) throw new Error("useSourceNavigation requires NavigationProvider")
  return navigation ?? undefined
}

export function NavigationStatus({ onOpenSetting }: Pick<NavigationStatusPanelProps, "onOpenSetting">) {
  const details = useContext(StatusContext)
  if (details === undefined) throw new Error("NavigationStatus requires NavigationProvider")
  return <NavigationStatusPanel {...details} onOpenSetting={onOpenSetting} />
}
