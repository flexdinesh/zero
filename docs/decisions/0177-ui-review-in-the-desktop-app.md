# 0177: UI review in the desktop app

- Status: Accepted; Element hint and kept captures superseded by
  [0180](0180-hit-map-at-capture.md)
- Date: 2026-11-19
- Extends: [0175](0175-guest-browser-host-window.md) (guest windows),
  [0176](0176-visual-feedback-targets.md) (visual feedback targets),
  [0081](0081-desktop-bridge-v2-native-features.md) (the bridge),
  [0099](0099-desktop-notifications.md) (agent replies notify)

## Context

0176 fixes the shapes of visual threads and sketches their UI: a guest
window's menu has Comment on Screen, which captures the frame and opens the
composer in Zero's window. 0175 leaves open how a guest window opens and
where its controls live. This record settles both for the first pass.

## Decision

- **Review URL.** Review › Review URL… (and the palette's Review URL…, in the
  desktop app's local window only) asks for a page of the developer's app:
  an http or https address, or a bare `localhost:5173`, with the project's
  recent pages (8, per browser) below. The page opens in the project's
  review window, one per project, reused.
- **Review window.** A guest window under 0175: `PageOptions.Untrusted`,
  the persistent `review` session (sign-ins survive across reviews, apart
  from Zero's pages), its own menu (Page: Back, Forward, Reload, Close
  Window; Edit; Review), 0175's navigation policy, permissions denied, new
  windows in the system browser. It loads nothing until registered. The
  proxy admits only pages of Zero's windows, which carry a caller page and
  are not guests, so it refuses the review window from its first request.
  The title is the window's own, never the page's `<title>`:
  `localhost:5173/settings · app · feature/menu`, page, project, and the
  branch new threads join, refreshed on navigation and focus.
- **Comment on Screen.** F8, in the review window's menu and Zero's;
  Shift+F8 captures after 3 seconds, counted in the title, for menus and
  hovers that a key press closes. A preload script, run before the page's
  scripts with its own `JSON` and DOM lookups, reports the page facts:
  title, viewport, scroll. Then `CapturePage` takes the frame. The device
  scale factor is `Page.ZoomFactor()` × `devicePixelRatio` (0175). Zero
  draws nothing over the page.
- **Handoff.** The capture waits in the project's local window, which comes
  forward (opened when there is none) and receives `zero:screen-comment`.
  The page takes it once through the bridge's `screenCapture()`, also on
  mount, and opens 0176's composer in Zero's window. The app keeps the last
  4 captures for element lookups.
- **Element hint.** Once the rectangle is drawn, the composer asks
  `screenElement(id, x, y)` for the element at its center in CSS pixels.
  The app asks the guest only while its URL, viewport size, and scroll
  match the capture, and bounds and validates the answer in Go as the
  page's word (0176's rules: no field values, no text of form fields or
  editable content). A point inside a shadow root answers its host.

## Consequences

- No mygo change is needed.
- Remote and sandbox windows offer no Review URL: the review window and its
  capture are this machine's. Pastes work everywhere (0176).
- Not in this pass: a review window's address field, captures of more than
  the viewport, and agents replying with a capture of their own. macOS stays
  unverified until 0175's spike runs there.
