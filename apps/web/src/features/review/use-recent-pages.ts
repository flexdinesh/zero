import { useCallback, useState } from "react"

import { forgetURL, parseRecent, recentStorageKey, rememberURL, type RecentURLs } from "./review-model.ts"

function readRecent(): RecentURLs {
  try {
    return parseRecent(JSON.parse(window.localStorage.getItem(recentStorageKey) ?? "null"))
  } catch {
    // Unavailable or malformed storage remembers nothing.
    return {}
  }
}

function writeRecent(recent: RecentURLs) {
  try {
    window.localStorage.setItem(recentStorageKey, JSON.stringify(recent))
  } catch {
    // The page still opens; it is only not remembered.
  }
}

// RecentPages is a project's remembered pages (decision 0184), most recent
// first, which the reviewer can forget one by one (decision 0195).
export interface RecentPages {
  recent: readonly string[]
  remember(url: string): void
  forget(url: string): void
}

// useRecentPages reads and keeps a project's pages in zero-review-urls.
// Each change reads storage first, so another window's pages survive it.
export function useRecentPages(project: string): RecentPages {
  const [recent, setRecent] = useState<readonly string[]>(() => readRecent()[project] ?? [])
  const update = useCallback((change: (recent: RecentURLs) => RecentURLs) => {
    const next = change(readRecent())
    writeRecent(next)
    setRecent(next[project] ?? [])
  }, [project])
  const remember = useCallback((url: string) => update((all) => rememberURL(all, project, url)), [project, update])
  const forget = useCallback((url: string) => update((all) => forgetURL(all, project, url)), [project, update])
  return { recent, remember, forget }
}
