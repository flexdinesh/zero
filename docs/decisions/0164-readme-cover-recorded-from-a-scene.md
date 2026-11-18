# 0164: README cover recorded from a Stageshow scene

- Status: Accepted
- Date: 2026-11-18
- Extends: [0141](0141-landing-scenes-and-feedback-row.md)

## Context

The README opened with the logo and a paragraph; the landing's Stageshow
scenes (0141) showed the product, but GitHub renders no React. A screen
recording would drift from the scenes, drop or double frames, and need
re-recording by hand on every change.

## Decision

**A cover scene, for the README only.** `apps/site/src/landing/scenes/CoverScene.tsx`
is a scene of its own, not on the landing: an agent resolving review feedback
from its CLI. Two windows: zero's Source view of a file, and in front of its
right edge, a generic agent CLI in a terminal. The reader selects a line,
presses **C**, and comments; then asks the agent, "Resolve my zero
feedback". The agent's transcript shows it run `zero feedback show`, edit
the file (the line changes live in zero), and run
`zero feedback reply --resolve`; its reply lands in the thread, resolved.
The thread folds, the agent session is cleared with `/clear`, and the next
round starts. The landing hero (0141) tells a similar round trip on a diff
with raw shell commands; the cover leads with the agent. It is built from
the landing's faux app (`app.tsx`, `zero.css`) and vendored kit, at
880 × 540, on the landing's dot-grid canvas with rounded corners. It has no
compact design: GitHub scales the image.

**Recorded on the kit's virtual clock.** `apps/site/cover/` is a capture page
(Vite, never built) and `record.ts`, run by `mise run readme:cover`. With
`?record`, the page installs `installVirtualClock` before the scene loads,
so time moves only when the recorder steps it, one 60 fps frame at a time:
every render is identical and nothing drops. The recorder lets one loop run
to its `loop` mark (the cursor learns its first move), then screenshots the
next loop at 2x with a transparent page, so the corners stay clear on
GitHub's light and dark backgrounds.

**Outputs.** In `docs/readme/`, per theme: `cover-<theme>.webp`, the loop as
an animated WebP (full color, alpha, 1320 px wide, about 2 MB; still
frames merge into longer ones, so only motion costs frames), and
`cover-<theme>.png`, the loop's frame at the scene's `poster` mark at 2x. The
README shows the WebP through `<picture>` by `prefers-color-scheme`; the PNGs
are stills for places that do not animate. No GIF: 256 colors band the UI,
at several times the size.

## Consequences

- Recording needs ffmpeg with `libwebp_anim` and Playwright's Chromium; it
  is a manual step, not part of `check:pr`. Re-run it after changing the
  scene, `app.tsx`, `zero.css`, or the landing tokens.
- `-- --keep` keeps the frames for review. The committed images are
  generated; edit the scene, never the images.
- The scene marks its beats (`start`, `poster`, `loop`); the recorder
  depends on `poster` and `loop`.
