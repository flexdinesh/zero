# 0182: Screen tabs for visual threads

- Status: Accepted
- Date: 2026-11-20
- Extends: [0176](0176-visual-feedback-targets.md) (its Feedback view
  detail is replaced here), [0113](0113-walkthrough-reading-flow.md)
  (preview tabs), [0177](0177-ui-review-in-the-desktop-app.md) (review
  window), [0178](0178-agent-facing-visual-thread-output.md) (its
  Feedback view wording moves to the tab), [0120](0120-review-feedback-threads.md)

## Context

0176 put a visual thread's detail inline in the Feedback view: the
screenshot at the sidebar's width (288 px by default), a Zoom dialog for a
larger look, and the conversation below the fold. A resolved thread folded
to one line, so its screenshot took a second click. Code threads open where
they were written, in the editor. Reviewing a UI change means reading the
screenshot and the agent's answer together, and returning to the original
evidence after the page has changed.

## Decision

- **Screen tab.** A visual thread opens in its own workspace tab,
  `{ kind: "screen", feedback, thread }`, keyed `screen:<fb>:<n>`. Its route
  is `/view?project=<dir>&fb=<id>&thread=<n>`; `fb` alone still only
  reveals the Feedback view. Tab memory stores `{ screen, thread }`. The tab
  is named `#5 · localhost:5173/settings` (`#6 · Screenshot` for a paste),
  or `Thread #5` until its feedback is read.
- **Preview.** Opening one from the Feedback list (or its route) places it
  as the preview tab, as walkthrough steps do (0113): the next thread
  replaces it in place, its name is italic, and double-click or Keep Open
  pins it. Replying or changing its status pins it too. Preview tabs are
  shared: a screen tab and a walkthrough step's tab replace each other.
- **Layout.** The screenshot fills the left on canvas with Fit and Actual
  size (image pixels over the device scale factor, scrolled to the region)
  and a readout of the region and image size. A right column (18 to 26 rem)
  shows the page (address, "localhost on your machine"), title, element,
  when it was captured and the commit, Copy crop and Open page, then the
  conversation as one band that never folds. Below 45 rem of pane width,
  and on phones, the screenshot stacks over the column and the tab scrolls.
- **Evidence.** The tab reads the stored screenshot, so it shows what was
  captured however the page has changed since. A screenshot that isn't
  stored says so in the tab, with 0178's words, and keeps the conversation.
  A deleted thread or feedback says so with Close tab.
- **Open page.** In the desktop app's local window (the bridge offers
  `openReview`), Open page shows the page in the project's review window
  (0177), where F8 comments on it again; elsewhere it opens a browser tab.
  0176's rule for when the page can be opened is unchanged.
- **Mark.** The rectangle keeps its pixels bright and dims the rest with a
  scrim spread from its edge, inside a 2px accent ring between surface
  hairlines; the element hint stays a dashed accent box above the scrim.
  The composer draws the same mark, while dragging too.
- **Feedback view.** Visual rows open the screen tab, as code rows open
  their file; outdated code threads still open in place. The inline
  screenshot detail and the Zoom dialog are gone. Arrow keys move across
  file groups and Screenshots as before; Enter opens either kind.
- **After Send.** New screen comment opens the new thread's screen tab once
  its feedback names it (a branch's first thread creates the feedback); the
  Resolved filter switches to Open so the new row shows. A pointer-drawn
  rectangle moves focus to the comment, which starts five lines tall.

## Consequences

- Visual threads open where there is room, like code threads; the sidebar
  stays a list.
- A screen tab reads its feedback with the Feedback view when the view
  shows the same feedback, and on its own otherwise.
- A screen route on a phone leaves the sidebar closed, which would cover
  the tab.
- Agent notices still link to `fb=<id>` alone; a later change can add
  `thread=<n>`.
