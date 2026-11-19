# 0174: Scoped Select All

- Status: Accepted
- Date: 2026-11-19
- Extends: [0033](0033-design-tokens-and-ui-primitives.md) (text fields keep
  their text selectable), [0172](0172-find-in-file.md) (a browser key scoped to
  the view shown)

## Context

Ctrl/Cmd+A was the browser's Select All: it selected the whole page, so the
explorer, tabs, toolbars, and status bar lit up with the document, and a
copy carried all of them. Readers press it to take the file's text. VS Code
and Zed select the editor's buffer, and their chrome is not text at all.

## Decision

- **Document.** While focus is in the document pane, Ctrl/Cmd+A selects the
  view's text:
  - Source and Format: from the first line's code to the last line's, without
    gutters or blame. Copying a selection that spans every line copies the
    source as it is (its bytes, tabs, and final newline), without feedback
    threads or narration shown between lines. Partial copies stay the
    browser's.
  - Markdown Preview: the rendered article.
  - Reviews, images, binary and too-large files, Welcome, notices, and the
    empty pane: nothing. A review's rows are virtualized in shadow roots, so
    a whole-review selection cannot exist.
- **Elsewhere.** Outside the document pane (explorer, tabs, status bar, no
  focus) Ctrl/Cmd+A selects nothing. Text fields and open dialogs keep the
  browser's Select All.
- **Chrome is not text.** The title bar, activity bar, sidebar, workspace
  toolbar (tabs and document toolbar), and status bar take no text selection,
  so drags across them select nothing. Their errors and an expanded commit's
  details (its message body) stay selectable, and so does typed text in the
  field primitives.

## Consequences

- Sidebar text (search snippets, commit subjects, walkthrough titles) can no
  longer be drag-selected, as in VS Code.
- After Select All in Source, threads and narration between lines show
  highlighted though copy leaves them out.
- The macOS desktop app's Edit › Select All menu item calls the web view's
  native Select All and still selects the page; Cmd+A reaches the page first.
