# 0187: Name the machine agents run on

- Status: Accepted
- Date: 2026-11-22
- Extends: [0120](0120-review-feedback-threads.md) (Copy Prompt),
  [0178](0178-agent-facing-visual-thread-output.md) (where to run),
  [0049](0049-copyable-agent-instructions.md) (agent instructions),
  [0098](0098-remote-connections.md), [0127](0127-sandbox-attach-and-stdio-transport.md)

## Context

Feedback is stored on the machine that serves the project (0120), and agents
answer it with the CLI there. In a desktop window on a `--remote` host or a
sandbox, nothing said so: Copy Prompt named the feedback, the host's project
path, and `zero feedback …`, but no machine. A user pasting into an agent on
their own computer learned where to run only from the CLI's error (0178),
after the fact. Two prompts were also wrong outside a local server:

- In a sandbox, zero is `/tmp/.zero/zero` and not on PATH, but prompts said
  `zero`.
- Over `--remote --web`, the prompts offered HTTP to the page's origin, which
  answers an agent's curl with 401: the token is the page's HttpOnly cookie.

The server already knew each request's transport (`app.TransportOf`, 0176);
the page did not.

## Decision

- **Place.** `GET /api/projects` reports `place` and `host`. `place` is
  `sandbox` for a stdio server (`serve-stdio`), else `local` on a transport
  that shares the project's host (the daemon's Unix socket, `zero browser`'s
  loopback, in process), else `remote` (tls, tailscale, unmarked). `host` is
  the serving machine's `os.Hostname()`, `""` when unknown: the name an
  agent's shell there shows. The listener decides, never the client.
- **Prompts.** Every copied agent prompt (Copy Prompt, Copy Thread for Agent,
  Copy agent instructions, Copy Step for Agent) starts, when not local, with
  where to run it: "Run this on devbox, the machine that serves this
  project…", or for a sandbox, inside it with zero at `/tmp/.zero/zero`, or
  from its host with `docker exec <container>`. Commands use
  `/tmp/.zero/zero` in a sandbox. Only a local server's http(s) origin is
  offered as HTTP. One pure helper, `lib/agent-place.ts`, owns the wording.
  Copy as Markdown is unchanged: it stays exactly `show.md` (0178).
- **Copy controls.** When not local, the copy buttons name the machine
  ("Copy prompt for devbox"), their confirmation says "Copied: paste into
  your agent on devbox", and Feedback's empty hint names it. No banner.
- **Remote indicator.** A remote or sandbox window's status bar shows the
  host (Sandbox for a container) after the brand mark, VS Code's remote
  indicator pattern. It opens a popover in the process popover's treatment:
  where the files are and that agents and zero commands run there. A local
  window shows nothing. Neutral tokens; it stays on phones.
- `ServerPlaceProvider` reads the place once per workspace; it is local
  until known or when projects cannot be listed.

## Considered

- **Read remote feedback with the local CLI** through a saved connection.
  Rejected: a local agent could read and reply, but it would change the
  wrong tree; the code is on the host.
- **No paste: `zero feedback wait`**, an agent on the host blocking until the
  user sends the threads from the UI. It removes the paste, but needs a send
  step and agents whose shells cap command time loop on it. Left for later.
- **The connection's label** instead of the host name: client-side only,
  missing in a browser, and not what the agent's shell prompt shows.

## Consequences

- `host` reveals the serving machine's host name to an authenticated client.
- A sandbox's host name is usually its container id but not always, so the
  `docker exec` form keeps `<container>`.
- Agents that matched a prompt's first line must allow the new lead line.
