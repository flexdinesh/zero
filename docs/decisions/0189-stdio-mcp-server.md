# 0189: `zero mcp`, a stdio MCP server for agents

- Status: Accepted
- Date: 2026-11-23
- Supersedes in part: [0120](0120-review-feedback-threads.md) ("the CLI is the
  agent's interface, without MCP"), [0176](0176-visual-feedback-targets.md)
  ("with no server and no MCP")
- Extends: [0047](0047-walkthroughs.md), [0065](0065-walkthrough-publish-cli.md),
  [0080](0080-application-layer-contracts-and-transports.md),
  [0087](0087-walkthroughs-in-the-application-layer.md),
  [0118](0118-zero-name-and-collision-safe-installs.md), [0127](0127-sandbox-attach-and-stdio-transport.md),
  [0187](0187-name-the-machine-agents-run-on.md)

## Context

Agents answer review feedback and publish walkthroughs through the CLI
(`zero feedback …`, `zero walkthrough publish`) and the skills that teach
it. 0120 rejected MCP: a server to configure per agent for what one shell
command already does. That still holds for agents with a shell and the
skill. It does not hold for agents without either, and MCP offers what a
command cannot: typed tool schemas (the walkthrough draft's JSON Schema is
the publish tool's input schema), screenshots returned as images instead of
files to open, and tools an agent discovers without installing a skill.

MCP has two transports. Since 0187, agents run on the machine that serves
the project, where the code is. An agent starts a stdio server itself, on
its own machine, so stdio reaches every mode: local, a `--remote` or
tailscale host (the agent runs there), and a sandbox (inside it, or from its
host through `docker exec -i`).

## Decision

- **`zero mcp`** serves MCP over standard input and output with the official
  Go SDK (`github.com/modelcontextprotocol/go-sdk`). Nothing else writes to
  standard output; warnings go to standard error. It shows no update notice.
- **In process, like the CLI.** Tools use the cores `zero feedback` and
  `zero walkthrough` use: the store directly, then an announcement to a
  running daemon so open windows update. No daemon is needed or started.
- **Tools.** `feedback_show`, `feedback_list`, `feedback_reply`,
  `feedback_comment`, `feedback_attachment` (the PNG as image content,
  `crop` for the region plus a margin), `walkthrough_schema`,
  `walkthrough_publish` (its arguments are the draft; it honors `open` as
  the CLI does), `walkthrough_list`, `walkthrough_delete`. The CLI gains
  `zero walkthrough list` and `delete` for parity.
- **Results.** Text the agent reads (show's Markdown, with next steps worded
  as tool calls instead of commands) plus the contract shape as structured
  content. Rejections are tool errors listing every problem by field. A
  draft is judged by the store's strict decoder, not the SDK's schema
  validation, so every problem shows at once.
- **Project.** A tool's `project` argument, else `zero mcp --project DIR`,
  else the server's working directory's repository. Failures to find one
  say to pass `project`. MCP roots are not used: the protocol deprecated
  them (SEP-2577) in favor of tool parameters and configuration.
- **Setup.** `zero mcp config [--agent claude|codex|cursor] [--container
  NAME]` prints the snippet with this zero's absolute path, or the
  `docker exec -i NAME /tmp/.zero/zero mcp` form for a sandbox. The docs page
  `/docs/mcp` covers each mode; the skills prefer zero's MCP tools when an
  agent has them.
- `internal/mcp` is the transport adapter: tool names, descriptions,
  schemas, and result shapes over a `Backend` that `cmd` composes. It knows
  no flags, stores, or daemon.

## Considered

- **HTTP MCP on the daemon.** The daemon listens only on a Unix socket
  (0061), which MCP clients cannot reach; a loopback TCP listener would need
  its own authentication against other local processes and browser pages.
  Rejected.
- **HTTP MCP on `--remote` and tailscale listeners.** Stock MCP clients
  cannot pin `--remote`'s self-signed certificate or send its token, and an
  agent elsewhere would change the wrong tree (0187). Deferred until a
  shell-less client needs it.
- **Through the daemon.** One writer, but a dependency the CLI deliberately
  avoids, and none where no daemon can run.
- **Hand-rolled JSON-RPC.** No dependency, but zero would track the
  protocol's versions itself.
- **Copied prompts naming MCP tools.** The page cannot know whether the
  agent has the server; CLI commands work everywhere. Prompts are unchanged.

## Consequences

- The binary grows about 1.3 MB (21.5 to 22.9 MB stripped) and an idle
  server's RSS about 1 MB; an idle `zero mcp` holds about 22 MB.
- A sandbox's `/tmp/.zero/zero` is installed again on every attach; the
  `docker exec` form needs the container running.
- A directory named `mcp` is served as `zero ./mcp`, as with `walkthrough`.
