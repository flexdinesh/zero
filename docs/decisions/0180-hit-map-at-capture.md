# 0180: Hit map at capture

- Status: Accepted
- Date: 2026-11-20
- Supersedes: [0177](0177-ui-review-in-the-desktop-app.md)'s Element hint
  and its kept captures
- Extends: [0175](0175-guest-browser-host-window.md) (guest windows),
  [0176](0176-visual-feedback-targets.md) (visual feedback targets)

## Context

0177 asks the guest for the element under a rectangle after the composer
opens, and only while the guest's URL, viewport, and scroll still match. By
then Zero's window has focus: a menu that closes on blur is gone, and the
page answers what is under the menu, or nothing. Selection also stops at a
drawn rectangle; a click cannot pick an element.

## Decision

- **Snapshot at capture.** Comment on Screen asks the guest's preload for
  `capture()` before `CapturePage`, in the same turn: the page facts (0177)
  plus a hit map. The map is a grid of `elementFromPoint` samples over the
  viewport (step at least 4 CSS px, at most 20000 cells) and the elements it
  found with their ancestors (at most 2000, parents first). Each element
  carries its tag, and when the page answers in time (150 ms) a selector,
  role, name, and text under 0176's rules, its box clipped by the viewport
  and by ancestors that clip their overflow, and whether it is meaningful
  (a role, a replaced element, a test id, an id, a click handler, or a tab
  stop). A shadow root answers its host; a frame is one element.
- **Alignment.** The map is in CSS pixels of the captured viewport; the frame
  maps to it through the device scale factor (0177). `capture()` also
  answers a layout signature; after `CapturePage`, the app asks for it
  again. A moved layout captures once more; moved twice, the capture is
  marked `drift` and the composer says so.
- **Validation.** Go bounds the map as the page's word: a bad shape drops the
  whole map (the capture stays, drag only), a bad field drops that field,
  and boxes are clipped to the viewport. The capture is handed over whole;
  the app keeps no captures and answers no later lookups.
- **Handoff.** `review.CaptureFrom(ctx, page, project)` takes a `PageDriver`
  (URL, zoom, eval, frame) and returns the `Capture`. The review window
  drives it today; the browser tab will drive the same call.
- **Selection.** On the frozen frame, hovering outlines the meaningful
  element under the pointer; a click selects it, a gap selects its
  container, Alt+Up and Alt+Down walk to the parent and back, and a drag
  (4 px) draws a free region over anything, canvas included. A region's
  element is the meaningful element at its center. A Clear button and
  Escape clear the selection; Escape with none closes, as before.

## Consequences

- `screenElement` leaves the bridge and the app; 0177's live lookup and its
  4 kept captures are gone.
- A menu captured open stays selectable after it closes.
- A paste has no hit map: drag only, as before.
- Display scaling is covered by the scale factor's unit tests; the fixture
  runs at scale 1.
