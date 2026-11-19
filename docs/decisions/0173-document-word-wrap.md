# 0173: Document word wrap

- Status: Accepted
- Date: 2026-11-19
- Extends: [0014](0014-command-palette.md), [0139](0139-inline-blame.md)

## Context

Long lines in Source and Format can require horizontal scrolling. VS Code and
Zed offer an editor command for an immediate toggle and a setting for the
default.

## Decision

- Settings › Editor › Word Wrap sets the default for Source and Format and
  persists in the existing app settings. The default is Off.
- Editor › Toggle Word Wrap is available in the command palette while a tab
  shows Source or Format. It displays the tab's effective value and toggles an
  in-memory override. Toggling back to the default, closing the tab, or
  replacing its preview clears the override. Source and Format share it.
  A snapshot has its own tab and override.
- Soft wrapping fits the document pane, breaking long tokens if needed. Each
  logical line keeps one gutter number and its existing selection and links.
  In wrapped mode the active line's blame goes below the code in the same
  column. Reviews keep their own wrap option.
