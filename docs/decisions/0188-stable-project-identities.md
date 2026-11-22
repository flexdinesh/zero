# 0188: Stable project identities

- Status: Accepted
- Date: 2026-11-22
- Extends: [0012](0012-repository-names-and-worktree-header.md) (the remote
  read from the common git directory's config),
  [0153](0153-links-name-their-project.md) (links name their project),
  [0098](0098-remote-connections.md),
  [0120](0120-review-feedback-threads.md) (the feedback store's key),
  [0053](0053-files-rail-viewed-marks.md) (viewed marks),
  [0081](0081-desktop-bridge-v2-native-features.md) (bridge methods)

## Context

Every way to name a project is its absolute path: `?project=`, `zero://`
links, the connect string (0153), `/api/*` scoping, browser memory, and the
feedback store's key (the common git directory). The same repository has a
different path on each computer: `/Users/me/work/abc` here, `/home/dev/abc`
on the server `zero <path> --remote` runs on. A link copied in one window
does not open in the other, a moved clone loses its feedback, and local and
remote windows of one repository share nothing.

## Decision

### An identity names a repository, not a checkout

- A repository's identity is its remote URL normalized to `host/path`,
  lowercase, as Go module paths and ghq write them:
  `github.com/flexdinesh/zero`. `internal/identity` is the one normalizer: it
  reads the scp form, `ssh://`, `git+ssh://`, `git://`, `http(s)://`, and
  identities; drops the user (and any token), port, query, fragment, `.git`,
  and trailing slashes. Local paths, `file://`, and relative paths have none.
- The remote is `upstream`, else `origin`, else the only remote, so a fork's
  checkout names the canonical repository. A remote without an identity (a
  local path) is passed over.
- No `~/.ssh/config` alias resolution (`git@gh-work:o/r` is `gh-work/o/r`);
  Azure DevOps SSH and HTTPS URLs normalize to different identities. A
  repository without a usable remote, and a folder, have no identity: they
  open by path only. No root-commit fallback.
- `internal/projects` reads every remote from the common git directory's
  config. `Project.identity` (`/api/projects`) and `PageData.identity` carry
  it; worktrees share it. The repository's display name stays origin's (0012).
- The picker shows a repository's identity and its filter matches it.

### An identity only finds a project

- Identities resolve against the projects discovered in the served roots,
  never a scan or an index of folders served before. A checkout not served is
  not found: `zero <path>` serves it once.
- Everything after the find stays scoped by path; `repo=` is dropped from the
  URL once a project is found.
- `/` and `/view` take `repo=<identity>`. With `project=` too, the path opens
  when this server serves it and its repository has the link's identity or
  none (a folder), or it is unlisted within a served root; a path that is
  another repository here (another computer's layout) gives way to the
  identity. One checkout opens; several show **Choose a checkout** (that
  repository's rows, "N checkouts of X.", Show all projects); none shows
  **Choose a project** with "No checkout of X on this server." The pick keeps
  the link's target (path, review, walkthrough).
- `zero --repo <identity or remote URL>` replaces the path; `--repo` with a
  path is an error. Bare `zero --repo` ensures the daemon, opens no folder,
  and opens `zero://local/?repo=<identity>`: the page decides.
  `zero browser --repo`, `--remote`, and `--tailscale` ask a running daemon
  for its one checkout and serve that path; they never start a daemon, and
  none or several checkouts is an error listing them. `zero <path>` and
  `zero .` are unchanged.

### Portable links

Links that leave the app (copied walkthrough step prompts, feedback links,
line links; the CLI's `--web`, Tailscale, and `zero browser` links;
`zero connect`'s `zero://` link) carry `repo=` beside `project=`. The connect
string is unchanged.

### Feedback keeps its path key and falls back to the identity

Feedback stays keyed by the common git directory. Each new thread records
its repository's identity in the feedback. While a repository holds no
feedback under its own key, its key is that of the most recently updated
feedback recording its identity (`Store.RepositoryOf`), for every read,
write, upload, and event stream: one key per project, so they agree. Adding
an `upstream` remote orphans nothing.

### Viewed marks follow the identity across windows

Viewed marks (blob-keyed, so safe across checkouts) key by identity, else by
project path. In the desktop app one store (`viewed.json`) holds them for
every window through `viewedMarks` and `setViewedMarks`; the browser keeps
them in its own storage. Tabs and folder expansion stay per checkout path.
Old path-keyed marks merge into the identity key on first read.

### Finding a repository on another connection

When this server has no checkout, the page asks the desktop app
(`findProject`), which asks the local daemon and the connections whose
windows are open (never dialing or starting another), leaving out the asking
window's own, and lists "Open in <connection>" for each match
(`openProject`). Sandbox pages get none of these bridge methods, like
`revealPath`: a container's code can tamper with its server.

## Consequences

- An identity can match several checkouts on one computer (clones, worktrees,
  forks): a link may still ask.
- Renaming, transferring, or mirroring a repository changes its identity, and
  older links miss; adding or changing `upstream` changes it too.
- SSH-alias and Azure DevOps clones do not match their canonical identity.
- Older servers send no `identity`; their projects never match.
- Two clones of one repository can share one feedback once a clone's own
  path holds none.
- `findProject` returns other connections' project paths to local and TLS
  remote pages.
