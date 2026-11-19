# 0183: The visual review loop, verified end to end

- Status: Accepted
- Date: 2026-11-20
- Extends: [0175](0175-guest-browser-host-window.md) (guest windows),
  [0176](0176-visual-feedback-targets.md) (visual targets and storage),
  [0177](0177-ui-review-in-the-desktop-app.md) (review windows),
  [0178](0178-agent-facing-visual-thread-output.md) (agent output),
  [0180](0180-hit-map-at-capture.md) (hit map),
  [0181](0181-project-browser-tab.md) (Browser tab),
  [0182](0182-screen-tabs-for-visual-threads.md) (screen tabs)

## Context

0175 through 0182 each shipped one part of reviewing a UI with screenshots:
the guest window, the capture and its hit map, the composer, the attachment
store, the Feedback list and screen tabs, and the agent's CLI. Each part was
tested on its own; the desktop e2e test stopped the capture before the
composer, and browser specs stood in for the bridge. Nothing had run the
whole loop in the real desktop app.

## What was exercised

Once, in the built desktop app (WebKitGTK 4.1 under Xvfb, Linux, device
scale 1), driven through mygo's automation socket, X input (xdotool), and
the real `zero` binary. The scratch harness was not kept (see
Consequences).

1. A repository on `main` and a linked worktree on `feature/menu` with an
   uncommitted change, both served by the daemon.
2. The worktree's Browser tab, which said "Comments go to loop-worktree ·
   feature/menu", opened a local page through its address field. The guest
   window's title named the page, the worktree, and the branch.
3. Zero's window moved to the main checkout. With the guest focused, a
   hover menu inside an `overflow: hidden` card was opened, and Comment on
   Screen captured it. The menu closed on the focus change afterwards; the
   frame and hit map held it. Zero's window switched to the worktree and
   opened the composer.
4. A real click selected the clipped item (`menuitem "Export data"`, its
   box clipped to the 20 visible pixels); Send stored the thread and opened
   its screen tab.
5. A second capture: a real drag marked a free region over a canvas; focus
   moved to the comment; Send stored it.
6. An ordinary code thread on the worktree's change, from the review's
   `c` key, joined the same feedback.
7. Closing the guest window left the Browser tab with Reopen and the page
   in Recent pages.
8. The CLI, from the worktree: `feedback list` and `show --json` named the
   feedback, the screenshots' paths and sha256 (both matched the files),
   `attachment --crop` wrote the region, and the Markdown named the page,
   region, element hint, and commit. The screenshots, read as an agent
   would, showed the cut-off menu item and the chart. `feedback reply`
   answered the menu thread. From the main checkout, `show` found no
   feedback for `main`; `list` lists every branch's, as it is meant to.
9. The page changed (v2). The Feedback list showed the agent's reply; the
   screen tab showed the stored v1 screenshot and region beside it. Open
   page reopened the guest window on v2, and Comment on Screen captured v2.
   Closing it left the Browser tab with Reopen.
10. A `zero --remote` project opened with `zero connect` in its own window:
    its bridge has no `openReview`, `screenCapture`, or `browserState`; a
    routed Browser tab says the browser needs the desktop app on the
    serving computer; a pasted screenshot went through the composer to a
    stored thread; and a capture of a loopback page arriving over the remote
    transport was stored with `localhost: viewer`, which the screen tab
    reads as "localhost on your machine" with no Open page.

## Decision

The exercise found four defects and one gap, fixed here:

- **Crash on Send.** WebKitGTK's `webkit_uri_scheme_request_get_http_body`
  crashes the desktop app (SIGSEGV, through mygo v0.7.4's
  `internal/linux/scheme.go`) when a page posts a `Blob` body to the app's
  `zero-app:` scheme. The composer's upload did exactly that, so every
  screen comment from the desktop app on Linux took the app down.
  `postBytes` now sends the bytes as an `ArrayBuffer`; the same request then
  succeeds. A `Blob` body still crashes the app, so no page code may post
  one; JSON strings and `ArrayBuffer` bodies are safe.
- **False error after a capture of another project.** The composer's
  project switch navigated to `/view` without a file, which the server
  answers with "No file was selected.", shown as Error in the status bar.
  It now switches as other project switches do, through `/`, onto the
  project's startup tab.
- **Two names for one element.** The composer's readout named the selected
  element by its role (`menuitem "Export data"`) and its facts and the
  screen tab by its tag (`li "Export data"`). `elementLabel` now uses the
  role, else the tag, as `hitLabel` does. The CLI's line is unchanged.
- **Open page forgot the page.** A screen tab's Open page called the bridge
  directly, so the Browser tab did not remember the page and offered no
  Reopen once the window closed. Open page now opens through the project's
  Browser tab, which remembers it.
- **Where the comment goes.** A capture can switch Zero's window to another
  project before the composer opens. The composer now shows the Browser
  tab's line, "Comments go to `<folder>` · `<branch>`", beside Send; both
  use one `CommentTarget` component.

## Consequences

- Platforms: verified on Linux (WebKitGTK, X11, scale 1) only. macOS is
  unverified: F8 and Cmd shortcuts in a guest window, the capture's pixel
  scale on Retina, the menu held through the focus change, and whether
  WebKit on macOS has the same `Blob` body crash (the `ArrayBuffer` body is
  safe either way). Display scaling above 1 was not exercised here (0175
  measured it).
- Sandbox connections (`zero attach`, desktop sandboxes) were not run live;
  their `localhost: viewer` rule is 0176's and is covered by its tests.
- mygo's automation `input` refuses web-page windows ("use eval"); the
  exercise used X input through xdotool, and F8 through the menu's
  automation call, as the desktop e2e does.
- The exercise was a one-off: no desktop e2e covers the whole loop. The
  fixes have their own unit and browser tests.

## Follow-up

- A desktop e2e for the whole loop (capture, Send, screen tab, CLI), which
  would have caught the crash; it needs the composer's pointer input
  through xdotool, as here.
- Report the `Blob` body crash to mygo (or WebKitGTK), and guard it there:
  an app's page should not be able to crash the app.
- Run 0175's macOS spike and this loop on macOS.
- Agent notices still link to `fb=<id>` alone (0182).
