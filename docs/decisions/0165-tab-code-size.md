# 0165: Tab code size

- Status: Accepted
- Date: 2026-11-18
- Revises: [0122](0122-type-roles-and-list-size.md) (source size), [0130](0130-ibm-plex-mono-quiet-scm-chrome-and-container-focus.md) (file names at the source size)

## Context

Code in tabs (Source, diffs, Markdown preview code) shared `--text-code`, 13px
at the default Font Size, with monospace inside the UI: sidebar file names,
review file paths, navigation snippets, branch names. Code in a tab read
slightly small next to 14px prose and 14px sidebar rows.

## Decision

- A new role, `--text-source`, sets code in tabs: `--text-code` times
  `--code-content-scale` (27/26), 13.5px at the 13px default. A factor, not a
  fixed step, so the Font Size setting scales it with the rest of the UI.
- Source (`.source-document`), Pierre diffs (`--diffs-font-size`), and preview
  code (fences and inline) use it. Prose and headings are unchanged.
- UI monospace stays on `--text-code`: file names in lists (`--text-file`),
  review file paths, navigation snippets, blame, feedback, walkthrough
  targets. File names no longer equal the source size.
- Source rows stay 22px (`--source-line-height`): Zed's comfortable buffer
  line height, 1.618 times the font size, gives 21.84px at 13.5px. VS Code's
  ratios (1.5 on macOS, 1.35 elsewhere) would be denser than Zero's rows.
  Gutter, change marks, blame, and Pierre geometry are unchanged.

## Consequences

Code in tabs and UI monospace differ by half a pixel at the default, by
design: the sidebar is chrome. Lines per screen are unchanged.
