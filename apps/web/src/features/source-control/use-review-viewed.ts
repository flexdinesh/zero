import { useCallback, useEffect, useMemo, useState } from "react"

import { desktopBridge, type ViewedFiles } from "../../lib/desktop-bridge.ts"
import { mergeFiles, migrateViewed, readViewed, viewedKey, viewedState, withViewed, writeViewed, type ViewedMarks } from "./review-viewed.ts"

// DesktopViewed is the desktop app's one store of marks by identity
// (decision 0188).
interface DesktopViewed {
  viewedMarks(identity: string): Promise<ViewedFiles | null>
  setViewedMarks(identity: string, files: ViewedFiles): void
}

function desktopViewed(identity: string): DesktopViewed | null {
  if (!identity) return null
  const bridge = desktopBridge()
  const { viewedMarks, setViewedMarks } = bridge ?? {}
  return viewedMarks && setViewedMarks ? { viewedMarks, setViewedMarks } : null
}

// localMarks reads this browser's marks with the project's path-keyed ones
// moved under its identity, saving the move.
function localMarks(project: string, identity: string): ViewedMarks {
  const stored = readViewed()
  const migrated = migrateViewed(stored, project, identity)
  if (migrated !== stored) writeViewed(migrated)
  return migrated
}

// useReviewViewed holds the project's Viewed marks (decisions 0053, 0188):
// keyed by its repository's identity, else its path. In the desktop app one
// store holds an identity's marks for every window, local or remote; else
// this browser remembers them. Marks made elsewhere load when this window
// regains focus.
export function useReviewViewed(project: string, identity: string) {
  const key = viewedKey(project, identity)
  // The identity arrives with the project's page.
  const desktop = useMemo(() => desktopViewed(identity), [identity])
  const [marks, setMarks] = useState<ViewedMarks>(() => localMarks(project, identity))
  useEffect(() => {
    let current = true
    const reload = () => {
      if (!desktop) {
        setMarks(localMarks(project, identity))
        return
      }
      void desktop.viewedMarks(identity).then((files) => {
        if (!current || files === null) return
        // Marks this browser kept before the app's store hold too, once.
        const stored = localMarks(project, identity)
        const local = stored[identity]
        let merged: ViewedFiles = files
        if (local && Object.keys(local).length > 0) {
          merged = mergeFiles(files, local)
          desktop.setViewedMarks(identity, merged)
          const { [identity]: _moved, ...rest } = stored
          writeViewed(rest)
        }
        setMarks({ [identity]: merged })
      })
    }
    reload()
    window.addEventListener("focus", reload)
    return () => {
      current = false
      window.removeEventListener("focus", reload)
    }
  }, [desktop, identity, project])
  const state = useCallback((path: string, blob: string) => viewedState(marks, key, path, blob), [key, marks])
  const viewed = useCallback((path: string, blob: string) => state(path, blob) === "viewed", [state])
  const mark = useCallback((path: string, blob: string, next: boolean) => {
    if (desktop) {
      const updated = withViewed(marks, key, path, blob, next)
      desktop.setViewedMarks(identity, updated[key] ?? {})
      setMarks(updated)
      return
    }
    // Marks apply to the latest stored set, so concurrent tabs keep theirs.
    const updated = withViewed(localMarks(project, identity), key, path, blob, next)
    writeViewed(updated)
    setMarks(updated)
  }, [desktop, identity, key, marks, project])
  return { isViewed: viewed, state, mark }
}
