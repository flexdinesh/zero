// Pure link to a new GitHub issue for Report a Problem (decision 0151). A
// URL cannot hold the logs, so the body carries the system facts and asks
// for the copied report.

export const ISSUES_URL = "https://github.com/flexdinesh/zero/issues/new"

// MAX_ISSUE_URL bounds the link: browsers and GitHub refuse much longer ones.
export const MAX_ISSUE_URL = 6000

function body(system: string): string {
  return [
    "## What happened", "", "", "## Steps to reproduce", "", "1. ", "", "## What you expected", "", "",
    "## System", "", system, "",
    "## Report", "", "Paste the report Report a Problem copied here, after reading it through.", "",
  ].join("\n")
}

function link(system: string): string {
  return `${ISSUES_URL}?${new URLSearchParams({ body: body(system) }).toString()}`
}

// issueUrl links to a new issue whose body holds system, dropping its last
// lines until the link fits MAX_ISSUE_URL.
export function issueUrl(system: string): string {
  const lines = system.split("\n")
  while (lines.length > 0) {
    const url = link(lines.join("\n"))
    if (url.length <= MAX_ISSUE_URL) return url
    lines.pop()
  }
  return link("")
}
