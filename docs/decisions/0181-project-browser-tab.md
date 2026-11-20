# 0181: Project browser tab

- Status: Superseded by [0184](0184-browser-view-and-in-page-comments.md)
- Date: 2026-11-20
- Extends: [0175](0175-guest-browser-host-window.md) (guest windows),
  [0177](0177-ui-review-in-the-desktop-app.md) (review windows; supersedes
  its Review URL palette and its "no address field" consequence),
  [0081](0081-desktop-bridge-v2-native-features.md) (the bridge),
  [0052](0052-welcome-tab-and-contextual-empty-state.md) (non-file tabs)

## Context

0177 opens a page of the developer's app in the project's guest window, but
the window has no address field and shows nothing of its state: navigation
lives in its menu, failures surface as notifications, and Zero's window does
not say which project a screen comment joins. 0175 rules out the obvious
fixes on mygo v0.7.4 (and v0.9.1 does not change it): a guest cannot sit
inside Zero's window, and native fields drawn over a page on Linux never get
the keyboard.

## Decision

- **Browser tab.** Each project's workspace has one Browser tab
  (`/view?project=…&browser=1`, stored as `{browser: true}`), in Zero's local
  window of the desktop app only. It steers the project's guest window; the
  page itself still shows only there. The tab holds:
  - Back, Forward, Reload (Stop while loading), and the address field,
    a combobox over the project's recent pages (8, per browser, as in 0177);
    Ctrl/Cmd+L focuses it. Enter opens the page and brings the guest window
    forward; Back, Forward, and Reload act without raising it.
  - The binding line, "Comments go to `<folder>` · `<branch>`": the
    project's folder name, as the guest window's title has it, and its
    branch ("detached HEAD" without one; a folder shows no branch).
  - The state: no page yet; loading; showing (Show Page raises the window);
    failed; or closed (Reopen loads the last page).
  - Comment on Screen and its 3-second variant while a page shows: the same
    capture as F8 and Shift+F8 (0177).
  - The tab's label is the page's host (`localhost:5173`), "Browser" before
    one.
- **Tab owns window.** Closing the tab closes the guest window. Closing the
  window keeps the tab, which offers Reopen. After a restart the tab comes
  back with its last page and opens no window until asked.
- **Entry.** Review › Review URL… and the palette's Review URL… open or
  activate the Browser tab and focus its address field; the Review URL
  palette is gone. A guest window's Page › Open Location… (Ctrl/Cmd+L)
  brings Zero's local window forward on that project's Browser tab, switching
  project first when another shows.
- **Bridge.** Two local-window methods: `browserState(project)` answers the
  guest window's `{url, loading, canGoBack, canGoForward, failure}`, or null
  without a window; `browserAction(project, action)` takes `back`, `forward`,
  `reload`, `stop`, `show`, `close`, `comment`, or `commentDelayed`.
  `openReview` stays the call that opens or navigates. The app announces a
  change with `zero:browser` (detail: the project) and the page reads the
  state again; it also reads on window focus, which catches a page's own
  history moves. A failure is `load`, `certificate` (always refused, 0175),
  `refused` (a navigation 0175 refuses, named by scheme and host only), or
  `crashed`, with the web view's one-line description; the tab words it.
- **Isolation.** Unchanged: guests stay `Untrusted` and the proxy refuses
  them. The new methods answer the local window only, never a guest, a remote,
  or a sandbox window.

## Consequences

- Controls and page sit in two windows. Arranging them is the window
  manager's job; Zero positions nothing.
- The capture hook of 0177 and 0180 (`zero:screen-comment`, `screenCapture`,
  `review.CaptureFrom` with its hit map) is unchanged; the tab only triggers
  it.
- Remote, sandbox, and `zero browser` windows have no Browser tab; a routed
  one says the browser needs the desktop app.
- A guest inside Zero's window, and native chrome over the page, still need
  a mygo change (0175).
