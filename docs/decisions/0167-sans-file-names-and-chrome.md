# 0167: Sans file names and chrome

- Status: Accepted
- Date: 2026-11-18
- Supersedes: [0130](0130-ibm-plex-mono-quiet-scm-chrome-and-container-focus.md)'s
  mono file names in lists, and the mono chrome labels of
  [0102](0102-sharp-slate-panes.md) and 0130
- Amends: [0138](0138-jetbrains-mono-and-tree-folder-icons.md): JetBrains Mono
  stays the one mono face, for code
- Amends: [0165](0165-tab-code-size.md): file names in lists leave UI
  monospace; they stay 13px, now Inter at the label size

## Context

File names in lists (Explorer, Source Control's changes list and trees, the
review Files rail, Search, Quick Open) were 13px JetBrains Mono, and tabs,
view and pane headers, and the macOS title band were 12px mono chrome. Mono
names are wide: long names truncate early in the sidebar and a 12.5rem
tab, and mono chrome made navigation read as code. The sidebar's other rows
were already Inter (0122).

Options compared, rendered at row and tab size: Inter 13px, Inter 14px,
Geist, IBM Plex Sans, and the system UI face.

## Decision

- **Inter for file names.** `--font-file` (Inter) and `--text-file` (13px,
  the label size) set every file-name list. Pierre's trees take it through
  `--trees-font-family-override`.
- **Disambiguated forms on file names.** `--font-file-features` turns on
  Inter's `cv05` (l with a tail) and `cv08` (I with serifs) on file names
  only, so `il1` and `Il` read apart. Pierre's trees reset font features in
  their shadow roots, so the shared tree CSS (`lib/tree-css.ts`) sets them on
  each row's name. The rest of the UI keeps plain Inter.
- **Sans chrome.** `--font-chrome` is Inter: tabs, view and pane headers, the
  Explorer header, the review rail's header, and the macOS title band. Tabs
  take the label size (`--text-tab`, 13px), matching tree names; headers
  stay 12px, 500, `text-secondary`.
- **Mono stays for code and data:** source, diffs, review file paths,
  hashes, branch and ref chips, HEAD's tag, the commit filter path, and
  walkthrough and feedback targets.
- **The landing follows.** The site bundles Inter for the landing only
  (`landing.css`, `--l-ui`); the scenes' tabs, title bands, view and pane
  heads, and file rows use it.

Why Inter: bundled already (no bytes added to the binary), one sans family
for the whole UI, and at 13px it sits at the density of VS Code's tree and
tabs. Geist and IBM Plex Sans would add a second sans family; the system UI
face differs per OS, which 0130 rejected for mono.

## Consequences

- The brand's "mono chrome labels" become sans chrome labels and file names,
  mono code (`PRODUCT.md`, `DESIGN.md`).
- Inter is narrower than mono: more of each name shows before truncating.
  Row and tab heights do not change.
- The README cover (0164) still shows mono tabs until it is re-recorded.
