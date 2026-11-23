# 0176: Visual feedback targets

- Status: Accepted; sweep extended by [0179](0179-sweep-interrupted-uploads.md);
  UI superseded and element facts extended by
  [0184](0184-browser-view-and-in-page-comments.md); "no MCP" superseded by
  [0189](0189-stdio-mcp-server.md)
- Date: 2026-11-19
- Extends: [0120](0120-review-feedback-threads.md), [0156](0156-feedback-badge-and-sidebar-width.md),
  [0159](0159-feedback-directory-mutations.md), [0098](0098-remote-connections.md),
  [0127](0127-sandbox-attach-and-stdio-transport.md), [0128](0128-sandbox-connections-in-the-desktop-app.md),
  [0152](0152-persistent-logs-and-problem-reports.md),
  [0175](0175-guest-browser-host-window.md) (guest pages capture the frame)

Contract only. Storage and UI implementation are separate tasks; this
record fixes the shapes they build to. Fixtures:
[`testdata/feedback/visual/`](../../testdata/feedback/visual/). Product
choices **U1**..**U10** were resolved on the recommendations listed at the
end.

## Context

Feedback (0120) anchors threads to code: diff lines, Source lines, or a
whole file. Reviewing a UI change means pointing at what the page shows, not
at the line that drew it. Today the reviewer describes the spot in words or
pastes a screenshot into chat, where the agent cannot read it back later and
the thread cannot hold it. The agent needs the pixels, the exact region, and
enough page context (URL, viewport, element) to find the code, from the
environment it runs in, which for remote and sandbox projects is not the
reviewer's machine.

## Decision

### Thread model

- A visual target is a second thread anchor kind in the same feedback (same
  repository and branch key, same `fb-` ID, same thread numbering, statuses,
  awaiting, messages, limits, events, badge, and notifications). A thread
  holds exactly one of `anchor` (code, unchanged) or `visual`.
- A visual target is one screenshot attachment, one rectangle on it, and
  optionally the page it was captured from and an element hint. One target
  per thread (**U7**).
- Visual threads never re-anchor: pixels do not drift with code. `available`
  is `false` when the screenshot is gone (evicted or deleted); the thread and
  its messages stay.
- The server records `head`, the project's HEAD commit at creation (absent
  without git), so the agent knows which code produced the screenshot.

### Coordinate space

- Every rectangle inside `visual` (`rect`, `element.box`) is in **screenshot
  image pixels**: integers, origin at the image's top-left, x right, y down,
  `{x, y, width, height}`, `width` and `height` at least 1, wholly inside
  the image.
- A capture is a frame of the page's viewport only (no full-page capture,
  **U8**; 0175 needs a mygo change for one). `page.viewport` is the layout
  viewport in CSS pixels with its `deviceScaleFactor`, which is the guest's
  zoom factor × `devicePixelRatio` (0175), never the PNG's width over
  `innerWidth`; the frame is `round(width × dsf)` by `round(height × dsf)`. `page.clip`, in frame pixels, is the part of the
  frame kept as the image (region + margin); absent means the image is the
  whole frame. The image must match the clip's (or frame's) size within
  1 px.
- Mapping: frame position = image position + `clip.{x,y}`; CSS position =
  frame position ÷ dsf; document position = CSS position + `page.scroll`
  (CSS pixels).
- A pasted or dropped image has no `page`: its rectangle is in image pixels
  and nothing else is known.

### Element hint

Optional and advisory (**U9**): the page's own word (0175 `Eval` runs in the
page's world), never trusted for authorization, stored as bounded text and
always escaped. After the rectangle is drawn, the desktop app asks the guest
page for the element at the rectangle's center in CSS pixels, only while the
page's URL and scroll still match the capture; otherwise, and for
cross-origin frames and closed shadow roots, `element` is absent. zero never
re-resolves it.

| Field | Meaning | Bound |
| --- | --- | --- |
| `selector` | A CSS selector the capturer found unique at capture | 512 bytes |
| `tag` | Lowercase tag name | 32, `[a-z][a-z0-9-]*` |
| `role` | ARIA role, explicit or implicit | 64 |
| `name` | Accessible name | 256 chars, one line |
| `text` | Trimmed visible text | 256 chars, one line |
| `box` | Border box clipped to the viewport, image pixels | inside the image |

Never captured: form field values, the text of `input`, `textarea`,
`select`, or `[contenteditable]`, or of anything marked
`autocomplete="cc-*"` or `type="password"`. `element` requires `page`.

### Page and URL

- `page.url` is `http` or `https` only, at most 2048 bytes after the server
  normalizes it: userinfo dropped; query and fragment parameters whose names
  match the secret list (case-insensitive: `token`, `access_token`,
  `id_token`, `refresh_token`, `code`, `key`, `api_key`, `apikey`, `secret`,
  `client_secret`, `password`, `pass`, `pwd`, `auth`, `authorization`,
  `session`, `sessionid`, `sid`, `sig`, `signature`, `jwt`, `otp`, and
  `X-Amz-*`) get the value `REDACTED`; any path segment or value shaped like
  a JWT (`eyJ…`, three dot-separated base64url parts) becomes `REDACTED`.
  The server is the only redactor; the response shows what was stored.
- `page.title` is at most 256 characters, one line. The composer shows the
  URL and title editable before sending, since titles can carry names or
  addresses.
- `page.localhost` says what a loopback URL (`localhost`, `*.localhost`,
  `127.0.0.0/8`, `[::1]`) refers to; absent for any other host:
  - `project`: the capturing client shares the project's host, so the agent
    can open the URL as written.
  - `viewer`: the client is elsewhere; the URL names the reviewer's machine,
    and its port may or may not be forwarded to the project (**U6**).
- The server derives `localhost` from the transport the write arrived on,
  never from the client: the daemon's Unix socket and `zero browser`'s
  loopback listener are `project`; the `tls` and `tailscale` exposures are
  `viewer`; a `serve-stdio` server (sandbox attach, desktop sandbox
  connections) is always `viewer`, since its own loopback is the
  container's. A remote connection to one's own machine is still `viewer`:
  zero cannot prove otherwise.

### Attachment and reference

- An attachment is an image the server holds for one feedback, with ID
  `at-` and ten lowercase base32 characters. Its durable reference is the
  pair `fb-<id>` `at-<id>`; the CLI resolves it from the feedback ID alone
  (as `Locate` does), with no project or server.
- Stored attachments are PNG only. The client encodes captures and pastes as
  PNG; the server checks the signature, chunk CRCs, and `IHDR` size, and
  drops ancillary metadata chunks (`tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`)
  at the chunk level, without decoding pixels, so the daemon's memory stays
  flat.
- `FeedbackAttachment` carries `id`, `mediaType`, `width`, `height`,
  `bytes`, and `sha256`. `path`, the absolute file path, is filled only by
  the CLI, which reads the store it names; HTTP never sends host paths.
- Stored, fixed at creation: everything in the draft (URL normalized),
  `localhost`, `head`, and the attachment's metadata. Derived on each read:
  `available`, `path` (`stored.json` versus `feedback.json`).

### Storage ownership

The machine that serves the project owns its feedback and attachments: the
same state directory as 0120, in the same repository directory, under the
same locks (0159).

```text
<state>/zero/feedback/<sha256 of repository key>/
  fb-3k2q8m.json          threads (unchanged format, plus `visual`)
  fb-3k2q8m.lock
  fb-3k2q8m/              attachments of fb-3k2q8m
    at-7hq2mx4kpa.png
  staging/                uploads not yet in a thread
    at-q3v6ne2wjd.png
  repository.lock
```

- Upload writes into `staging/` through a temporary file and rename.
  Creating the thread renames the staged file into `fb-<id>/` and writes the
  JSON, both inside `Update` (repository lock, then ID lock). A failed JSON
  write leaves an orphan for the sweep.
- `List` skips directories already, so `fb-<id>/` and `staging/` need no
  change to listing or ID allocation.
- Where the agent reads it:

| Project served by | Store lives on | Agent reads |
| --- | --- | --- |
| Local daemon, `zero browser` | The user's machine | `path` from `show --json`, or `zero feedback attachment` |
| `--remote`, `--tailscale` | The remote host, as the serving user | The same, on the remote host |
| Sandbox (`zero attach`, desktop sandbox) | The container's state directory | Inside: `/tmp/.zero/zero feedback attachment …`; from the host: `docker exec <c> /tmp/.zero/zero feedback attachment … -o -` |

  A recreated container loses its feedback, as it does today.

### Bounds and eviction

Numbers (**U4**):

| Bound | Value |
| --- | --- |
| Upload body | 8 MiB |
| Image side | 8192 px |
| Image area | 16 MP |
| Staged per repository | 16 (oldest dropped) |
| Staged lifetime | 1 hour |
| Attachments per feedback | 64 |
| Attachment bytes per feedback | 256 MiB |
| Attachment bytes per repository | 1 GiB |

- Deleting a thread deletes its attachment; deleting or evicting a feedback
  (0120's 200-per-repository LRU) removes its `fb-<id>/` directory.
- Past the repository byte budget, creating a visual thread first drops
  screenshots of resolved and won't-fix threads, least recently updated
  first, leaving those threads with `available: false`. It never drops an
  open thread's screenshot; if still over, it refuses with `feedbackFull`
  and a message naming the fix (**U5**).
- Every upload and thread creation, under the repository lock, removes
  staged files past their lifetime and `at-*.png` files no feedback JSON
  references (crash leftovers). Nothing else is swept.

### Redaction

- Pixels are never inspected or blurred. The composer defaults to
  attaching the region plus a 48 CSS px margin, with Full view as the
  alternative (**U2**); a region is recorded as `page.clip`, and pixels
  outside it never leave the client.
- Metadata is stripped (above); URLs are redacted (above); element hints
  never read field values (above).
- Logs (0152) never record visual target URLs, titles, hints, or image
  bytes; problem reports never include attachments.

### Old code threads and compatibility

- Stored code threads are unchanged: a thread without `visual` is a code
  thread. No migration.
- Go: `Thread.Anchor` becomes `*Anchor` (`omitempty`), with a new
  `Visual *Visual`; contract `FeedbackThread.anchor` and `location` become
  optional, `visual` is added after `location`, with rules
  `anchor == null => visual != null`, `anchor != null => visual == null`,
  `anchor == null => location == null`, `anchor != null => location != null`
  (the generator must treat an omitted field as `null`; verify). Generated
  TypeScript narrows on `anchor`. The page and the desktop app
  come from the same server, so they agree.
- A zero build older than this one that rewrites a feedback holding visual
  threads (a `reply` from an old CLI) drops their `visual` and leaves
  path-less code threads shown outdated. Installs replace the CLI and daemon
  together (0136) and sandbox installs run every attach (0128), so skew needs
  two installs. Accepted (**U10**).
- Code-only views (review, Source markers) ignore visual threads; the
  Feedback view lists them; the badge (0156) counts them.

### Transport

| Operation | Shape |
| --- | --- |
| `POST /api/feedback-attachments?project=<dir>` | Body: raw PNG, `Content-Type: image/png`, ≤ 8 MiB, same Origin. 201 `FeedbackUpload` (`upload.json`). 415 for other types, 413 past the limit, 400 `invalidFeedback` for a bad image. |
| `POST /api/feedback-threads` | `FeedbackThreadDraft` gains `visual` (`FeedbackVisualDraft`: `attachment`, `rect`, optional `page` without `localhost`, optional `element`). `visual` excludes `path`, `side`, `lines`, and `compare`. |
| `GET /api/feedback-attachment?project=<dir>&id=<fb>&attachment=<at>` | `image/png`, `nosniff`, sandbox CSP, as `/api/image`. 404 when gone. |
| `GET /api/feedback`, `zero feedback show --json` | Threads carry `visual` (`feedback.json`); the CLI fills `attachment.path`. |

Validation reports every problem by field, as 0120 does
(`problems.json`): attachment not a live upload of this repository, rect
or box outside the image, clip outside the frame, image size not the
clip's or frame's, element without page, URL scheme, and string bounds.

### CLI

```console
$ zero feedback show            # visual threads print as in show.md
$ zero feedback attachment fb-3k2q8m at-7hq2mx4kpa
/home/user/.local/state/zero/feedback/39d5…4e4d/fb-3k2q8m/at-7hq2mx4kpa.png
$ zero feedback attachment fb-3k2q8m at-7hq2mx4kpa --crop -o region.png
wrote region.png (468×144: region 96,96 420×96 plus 24 px margin)
$ docker exec web /tmp/.zero/zero feedback attachment fb-3k2q8m at-7hq2mx4kpa -o - > shot.png
$ zero feedback reply fb-3k2q8m 5 -m "Save now sits inside the card." --resolve
```

- `attachment <fb> <at>` prints the absolute path; `-o <file|->` copies the
  bytes; `--crop[=<px>]` (default 24 image px) writes the rectangle plus
  margin and needs `-o`. It verifies `sha256` and fails naming the
  mismatch.
- `show` Markdown (CLI and Copy as Markdown, one text) prints the
  `attachment` command, not a path, so both stay identical (`show.md`).
- Agents do not start visual threads in v1 (**U3**); visual threads are
  user-authored from the page.

### UI (for the UI task)

Desktop guest browser (0175): the guest window's own menu has Comment on
Screen. It captures the frame (`CapturePage`) and the page facts, then opens
the composer in Zero's window, never over the guest page: native UI over a
page does not take the keyboard on Linux, and the untrusted page must not
see the comment.

```text
Zero window ─ Feedback › New screen comment ──────────────────
│ frozen frame (localhost:5173/settings)                     │
│        ┌────────────────────┐                              │
│        │ [ Save changes ]   │ ← drag a rectangle           │
│        └────────────────────┘                              │
│ Element  button "Save changes" (from the page)             │
│ URL      localhost:5173/settings?tab=billing  (editable)   │
│ Attach   (•) Region + margin  ( ) Full view                │
│ ┌────────────────────────────────────────────┐             │
│ │ Save overlaps the card edge at 1440.       │             │
│ └────────────────────────────────────────────┘             │
│                                       [Cancel] [Send]      │
──────────────────────────────────────────────────────────────
```

Design the UI with the `impeccable` skill and Zero's primitives (0033).

Feedback view, any surface: "New screen comment" takes a pasted or dropped
image, then the same composer without URL or element. A
visual thread row shows a crop thumbnail, `#5 · open`, and the URL's host
and path; the detail (a screen tab since [0182](0182-screen-tabs-for-visual-threads.md)) shows the image with the rectangle drawn, zoomable,
"Copy crop", and, when `localhost` is `project` or the host is not
loopback, "Open URL". A `viewer` loopback URL reads "localhost on your
machine".

## Consequences

- Agents get the screenshot, region, and page context from their own
  environment through one CLI command, with no server and no MCP.
- Screenshots are user state stored beside threads; they count against
  budgets and die with their threads or feedback, never with code changes.
- Visual threads are not re-anchored and say nothing about which file to
  change; the element hint and `head` are hints only.
- `localhost` is conservative: remote and sandbox captures never claim the
  agent can open a loopback URL.
- Pre-0176 binaries can strip visual targets when they rewrite a
  feedback.

## Product choices

Resolved 2026-11-19 on the recommendations:

- **U1** Capture sources: guest browser and paste. Paste ships without
  waiting for the guest browser; `page` is absent for pastes.
- **U2** Default attach: region + margin (48 CSS px); Full view is the
  alternative.
- **U3** Agent-started visual threads: deferred; no `comment --image` in v1.
- **U4** Budgets: as listed above.
- **U5** Over budget: drop closed threads' screenshots, least recently
  updated first, then refuse with `feedbackFull`; never an open thread's.
- **U6** Port forwards: not recorded in v1; `viewer` stays conservative.
  Revisit with the guest browser host.
- **U7** One rectangle per thread; no screenshots on replies in v1.
- **U8** Viewport capture only; no full-page capture.
- **U9** `element` stays optional and is omitted when the capturing surface
  cannot read the DOM.
- **U10** Old-binary skew accepted; `visual` stays inline, no sidecar file.
