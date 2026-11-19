# 0172: Find in file

- Status: Accepted
- Date: 2026-11-19
- Extends: [0020](0020-activity-bar-and-search-view.md) (content search
  stays in the Search view; find works on the view shown), [0029](0029-highlights-syntax-highlighting.md)
  (matches paint over highlighted text without touching it), [0035](0035-compare-list-and-review-tab.md)
  (a review's find reads every file's diff), [0140](0140-overlay-scrollbars.md)
  (match marks sit under the overlay scrollbar)

## Context

Ctrl/Cmd+F was the browser's find. It matched chrome and gutters as well as
the document, could not see a review's virtualized rows inside Pierre's
shadow roots, and does not exist at all in the desktop app's web view. VS
Code and Zed find within the open editor: a field with Match Case, Match
Whole Word, and Use Regular Expression, a count, Previous and Next, and every
match painted.

## Decision

- **Bar.** Ctrl/Cmd+F opens a flat band under the document toolbar, as
  Zed's buffer search does: it pushes the document down and covers no text.
  It holds the query field with the Search view's `Aa`, `ab`, and `.*`
  toggles (Alt+C/W/R), the count ("3 of 12", "10,000+" past the cap,
  "No results", or the invalid-expression message), Previous, Next, Find in
  Selection (Alt+L), and Close. Phones, without the key, get a Find button in
  the document toolbar; the palette lists Editor: Find, Find Next, and Find
  Previous.
- **Keys.** Enter and Shift+Enter step, as do F3 and Shift+F3, and Cmd+G and
  Shift+Cmd+G on macOS; steps wrap. Escape or Close ends find, clears the
  paint, and returns focus to where it was in the document. Ctrl/Cmd+F
  again refocuses the field with the query selected. The browser keeps the
  key in dialogs, other text fields, and views find cannot read (images,
  binary files, Welcome).
- **Query.** A one-line text selection of at most 200 characters becomes the
  query (quoted when the query is a regular expression); otherwise the last
  query and options return. Matching is the Search view's
  (`compilePattern`): literal, case-insensitive, Unicode-aware whole words,
  JavaScript regular expressions; matches never span lines or blocks and
  empty matches are skipped. At most 10,000 matches.
- **Views.** The view shown offers its text (`FindTarget`):
  - Source and Format: the lines, without gutters, blame, feedback threads, or
    narration. Find in Selection uses the gutter's line range.
  - Markdown Preview: the rendered text, block by block and line by line in
    code blocks, read again when the DOM changes (fence highlighting);
    diagrams, code-block controls, and closed `<details>` are not read. It has
    no line range, so Find in Selection is unavailable.
  - Reviews: the rows each diff shows, in unified order: context, deleted,
    then added rows, plus gap lines the reader expanded (all of them with
    Expand unchanged); lines in collapsed gaps do not match. Opening find reads
    every file's diff, four at a time, through the review's own store; the
    count reads "Searching 12 of 40 files…" until done, and files join in
    review order so earlier matches keep their place. A split view's context
    row counts once and paints on both sides. Stepping onto a closed file opens
    it. Find in Selection uses the review's selected lines.
- **Paint.** Matches paint through the CSS Custom Highlight API
  (`zero-find-match` in `warning-subtle`, the current one in a stronger
  warning mix), so highlighted HTML and Pierre's rows stay untouched; Pierre's
  shadow roots carry the same rules. The current match scrolls to the pane's
  upper third when off screen, and sideways clear of Source's sticky line
  numbers. A review holds the revealed row in place for 2 s while diffs
  around it render, unless the reader scrolls.
- **Marks.** While find is open, a lane at the pane's right edge marks every
  placed match (warning) and the current one (accent), as VS Code's overview
  ruler. It takes no pointer, so the overlay scrollbar's thumb stays
  draggable above it.
- **Scope.** Switching tabs closes find; changing a document's view (Preview,
  Source, Format) keeps it open and searches the new text. A live reread
  recounts and keeps the current match, or the next one after it.

## Consequences

- Browsers without the Highlight API (none current) still count and scroll to
  matches but paint none: moving the document selection instead would
  disturb typing in the field.
- Find in a large review reads every diff, so it costs the requests and
  memory that scrolling the whole review would; the per-side limits of
  decision 0004 still apply, and binary or too-large diffs have no rows.
- Review files not yet laid out have no marks until Pierre places them.
- The bar is bundled with the workspace; it is small, and deferring it would
  add a loading state to a keystroke that must answer at once.
