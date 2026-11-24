// Pure model of the Browser's pages (decision 0184): which addresses the
// address field accepts and remembers per project.

// reviewURL reads what the reviewer typed as the page to open: an
// absolute http or https URL with a host and no credentials; a bare
// localhost, dotted host, or host:port takes https, or http when
// defaultsToHTTP says its host is this machine or the local network
// (decision 0195). null for anything else. The desktop app checks again.
export function reviewURL(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > 2048 || /\s/.test(text)) return null
  const schemed = text.includes("://")
  // A bare address names a host: localhost, a dotted name, or a port.
  if (!schemed && !/^(?:localhost|[^/?#:]*\.[^/?#:]*|[^/?#:]+:\d+)(?:[:/?#]|$)/i.test(text)) return null
  let parsed: URL
  try {
    parsed = new URL(schemed ? text : `https://${text}`)
    if (!schemed && defaultsToHTTP(parsed.hostname)) parsed = new URL(`http://${text}`)
  } catch {
    return null
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host || parsed.username || parsed.password) return null
  return parsed.href
}

// defaultsToHTTP reports a host a bare address opens over http (decision
// 0195): this machine (localhost, *.localhost, 127.0.0.0/8, [::1]), a
// private IPv4 address (10/8, 172.16/12, 192.168/16), or a .local name,
// where dev servers serve plain http. hostname is a URL's, lowercase.
export function defaultsToHTTP(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "[::1]") return true
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!octets) return false
  const first = Number(octets[1])
  const second = Number(octets[2])
  return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

// pageLabel is a page without its scheme, "localhost:5173/settings?tab=2",
// unless the bare label would open another address: then the scheme stays,
// "http://example.test/", so http and https of one page read apart.
export function pageLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const bare = `${parsed.host}${parsed.pathname}${parsed.search}`
    return reviewURL(bare) === `${parsed.origin}${parsed.pathname}${parsed.search}` ? bare : `${parsed.protocol}//${bare}`
  } catch {
    return url
  }
}

// pageKey names the page an address belongs to (decision 0184): its origin
// and path, plus the hash when the hash is a route (#/… or #!…), without
// the route's own query. The query never counts. "" for anything that is
// not an http or https address.
export function pageKey(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ""
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) return ""
  const route = /^#[/!]/.test(parsed.hash) ? parsed.hash.split("?")[0] ?? "" : ""
  return `${parsed.origin}${parsed.pathname}${route}`
}

// samePage reports two addresses of one page.
export function samePage(left: string, right: string): boolean {
  const key = pageKey(left)
  return key !== "" && key === pageKey(right)
}

// RecentURLs is the pages opened per project, most recent first, as
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

// forgetURL removes url from project's pages (decision 0195); a project
// left with none is dropped, and the others keep their order.
export function forgetURL(recent: RecentURLs, project: string, url: string): RecentURLs {
  return Object.fromEntries(Object.entries(recent)
    .map(([each, urls]): [string, readonly string[]] => [each, each === project ? urls.filter((kept) => kept !== url) : urls])
    .filter(([, urls]) => urls.length > 0))
}

// ReviewChoice is one suggestion under the address field: the typed page,
// or a remembered one.
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

// TabPages is the address each of a project's Browser tabs last showed
// (decision 0195), as zero-browser-tabs stores them: by project, then by
// tab number. A tab whose page closed, past the window's page limit or
// with the app, offers it again.
export type TabPages = Readonly<Record<string, Readonly<Record<string, string>>>>

export const tabPagesStorageKey = "zero-browser-tabs"
const tabPagesProjects = 50

export function parseTabPages(value: unknown): TabPages {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const pages: Record<string, Record<string, string>> = {}
  for (const [project, tabs] of Object.entries(value)) {
    if (typeof tabs !== "object" || tabs === null || Array.isArray(tabs)) continue
    const kept: Record<string, string> = {}
    for (const [tab, url] of Object.entries(tabs)) {
      if (/^[1-9]\d?$/.test(tab) && typeof url === "string" && reviewURL(url) === url) kept[tab] = url
    }
    if (Object.keys(kept).length > 0) pages[project] = kept
  }
  return pages
}

// tabPage is the address tab of project last showed, "" for none.
export function tabPage(pages: TabPages, project: string, tab: number): string {
  return pages[project]?.[String(tab)] ?? ""
}

// withTabPage remembers url as what tab of project shows, or forgets the
// tab for "". The project moves last, and the oldest projects go first past
// the limit.
export function withTabPage(pages: TabPages, project: string, tab: number, url: string): TabPages {
  const { [String(tab)]: _previous, ...others } = pages[project] ?? {}
  const tabs = url ? { ...others, [String(tab)]: url } : others
  const { [project]: _project, ...rest } = pages
  const kept = Object.fromEntries(Object.entries(rest).slice(-(tabPagesProjects - 1)))
  return Object.keys(tabs).length > 0 ? { ...kept, [project]: tabs } : kept
}
