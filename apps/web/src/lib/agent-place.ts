import type { ServerPlace } from "@zero/contracts"

// AgentPlace is where the served projects are from this page's side, and
// the serving machine's host name ("" when unknown), as /api/projects reports
// them (decision 0187). Agents and zero commands run there.
export interface AgentPlace {
  place: ServerPlace
  host: string
}

// localPlace is the assumption until the server says otherwise: the page
// changes nothing for a local server.
export const localPlace: AgentPlace = { place: "local", host: "" }

// sandboxZero is where zero is inside a sandbox (`InstallDir`, decision
// 0127): it is not on PATH there.
export const sandboxZero = "/tmp/.zero/zero"

// zeroCommand is how an agent where the projects are runs zero.
export function zeroCommand({ place }: AgentPlace): string {
  return place === "sandbox" ? sandboxZero : "zero"
}

// takesHttp reports whether a copied prompt may offer HTTP to this page's
// origin: only a local server's. A remote origin needs the page's own
// credentials, and the agent there has the CLI anyway.
export function takesHttp({ place }: AgentPlace): boolean {
  return place === "local"
}

// machineLabel names the machine an agent runs on in the page's chrome:
// the host name, else a description; "" for a local server.
export function machineLabel({ host, place }: AgentPlace): string {
  if (place === "local") return ""
  if (place === "sandbox") return host ? `sandbox ${host}` : "the sandbox"
  return host || "the remote machine"
}

// agentWhere is "on devbox" or "in the sandbox": where the user's agent
// runs, "" for a local server.
export function agentWhere(place: AgentPlace): string {
  if (place.place === "local") return ""
  return place.place === "sandbox" ? "in the sandbox" : `on ${machineLabel(place)}`
}

// whereToRun is a copied prompt's first line: which machine runs it, and
// how to reach zero there; "" for a local server.
export function whereToRun(place: AgentPlace): string {
  if (place.place === "remote") {
    const machine = place.host ? `${place.host}, the machine that serves this project` : "the machine that serves this project"
    return `Run this on ${machine}: the files and zero are there, not on the reviewer's computer.\n`
  }
  if (place.place === "sandbox") {
    return `Run this inside the sandbox${place.host ? ` (${place.host})` : ""} that serves this project, where zero is ${sandboxZero}.
From its host instead, prefix each command with: docker exec <container>
`
  }
  return ""
}
