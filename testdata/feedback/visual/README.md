# Visual feedback fixtures

Representative shapes for [decision 0176](../../../docs/decisions/0176-visual-feedback-targets.md).
Not wired to tests yet; the storage and UI tasks adopt them.

| File | Shape |
| --- | --- |
| `draft-minimal.json` | `POST /api/feedback-threads`: pasted image, rectangle only |
| `draft-page.json` | `POST /api/feedback-threads`: page capture, region clip, element hint |
| `upload.json` | `POST /api/feedback-attachments` response (`FeedbackUpload`) |
| `feedback.json` | `GET /api/feedback`: an unchanged code thread beside two visual threads |
| `feedback-cli.json` | `zero feedback show --json`: the same thread with the CLI-only `attachment.path` |
| `stored.json` | `<state>/zero/feedback/<repo hash>/fb-3k2q8m.json` on disk |
| `problems.json` | A rejected visual draft (400 `invalidFeedback`) |
| `show.md` | `zero feedback show --all` and Copy as Markdown for `feedback.json` |

Coordinates in `visual` are screenshot image pixels. In `draft-page.json` the
viewport is 1440×900 CSS px at 2×, so the frame is 2880×1800; the kept clip is
1114,544 612×288 (the button plus a 48 CSS px margin), so the image is 612×288
and the button sits at image 96,96 420×96, CSS 605,320 210×48, document
605,1640 after the 1320 px scroll.
