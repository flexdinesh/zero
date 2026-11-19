// Pure model of UI review in the desktop app (decision 0177): which URLs
// the Review URL palette accepts and remembers per project.

// reviewURL reads what the reviewer typed as the page to review: an
// absolute http or https URL with a host and no credentials; a bare
// localhost, dotted host, or host:port takes http. null for anything else. The desktop app checks
// again.
export function reviewURL(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > 2048 || /\s/.test(text)) return null
  const schemed = text.includes("://")
  // A bare address names a host: localhost, a dotted name, or a port.
  if (!schemed && !/^(?:localhost|[^/?#:]*\.[^/?#:]*|[^/?#:]+:\d+)(?:[:/?#]|$)/i.test(text)) return null
  let parsed: URL
  try {
    parsed = new URL(schemed ? text : `http://${text}`)
  } catch {
    return null
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host || parsed.username || parsed.password) return null
  return parsed.href
}

// pageLabel is a page without its scheme: "localhost:5173/settings?tab=2".
export function pageLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

// RecentURLs is the pages reviewed per project, most recent first, as
// zero-review-urls stores them.
export type RecentURLs = Readonly<Record<string, readonly string[]>>

export const recentStorageKey = "zero-review-urls"
const recentPerProject = 8
const recentProjects = 50

export function parseRecent(value: unknown): RecentURLs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const recent: Record<string, string[]> = {}
  for (const [project, urls] of Object.entries(value)) {
    if (!Array.isArray(urls)) continue
    const kept = urls.filter((url): url is string => typeof url === "string" && reviewURL(url) === url)
    if (kept.length > 0) recent[project] = kept.slice(0, recentPerProject)
  }
  return recent
}

// rememberURL puts url first in project's pages; the project moves last,
// and the oldest projects go first past the limit.
export function rememberURL(recent: RecentURLs, project: string, url: string): RecentURLs {
  const urls = [url, ...(recent[project] ?? []).filter((each) => each !== url)].slice(0, recentPerProject)
  const { [project]: _previous, ...rest } = recent
  return { ...Object.fromEntries(Object.entries(rest).slice(-(recentProjects - 1))), [project]: urls }
}

// ReviewChoice is one row of the Review URL palette: the typed page, or a
// remembered one.
export interface ReviewChoice {
  url: string
  typed: boolean
}

// reviewChoices lists the typed page first when it is a valid page not
// remembered, then the remembered pages containing the query.
export function reviewChoices(recent: readonly string[], query: string): ReviewChoice[] {
  const typed = reviewURL(query)
  const needle = query.trim().toLowerCase()
  const matches = recent.filter((url) => url.toLowerCase().includes(needle))
  const first = typed && !recent.includes(typed) ? [{ url: typed, typed: true }] : []
  return [...first, ...matches.map((url) => ({ url, typed: false }))]
}
