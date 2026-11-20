# 0186: Panel surfaces in desktop web views

- Status: Accepted
- Date: 2026-11-20
- Extends: [0184](0184-browser-view-and-in-page-comments.md) (the composer),
  [0033](0033-design-tokens-and-ui-primitives.md) (primitives)

## Context

0184's composer is a page of Zero's in its own small web view, 360 CSS px
wide. That is under the 48rem breakpoint, so every primitive took its touch
size: buttons and the What's sent row grew to 44 and 32 px in a box used with
a mouse, and the box read unlike the review's comment box. More Browser view
UI will be pages in small native views too.

## Decision

- **Panel.** A page the desktop app shows in its own small web view is a
  panel: `Panel` in `components/ui/panel.tsx`. It is the raised surface over
  the viewport, scrolling past its content's bound; `PanelHeader`,
  `PanelBody`, and `PanelFooter` bands meet on hairlines, inset 8 px by
  12 px. `onHeight` hears the content's height so the app can fit the view.
- **Pointer density.** A panel sets `data-density="pointer"` on `<html>`
  before its first paint. Narrow screens still change the layout (preview
  size, activity width, dialogs' width); touch sizes apply only to
  `:root:not([data-density="pointer"])`. Every primitive's 48rem touch rule
  takes that guard through `:where()`, so its specificity is unchanged.
- **Composer.** The composer is the first panel and lays out as the
  review's comment box (0120): the pick and its origin; the field, three
  lines at rest, then "Markdown · ⌘↵ to comment" with Cancel and Comment on
  one row; then What's sent with the folder and branch the comment goes to.
  Escape still cancels; Cancel's tooltip says so.

## Consequences

- Phones and narrow browser windows keep touch sizes: nothing there sets the
  attribute.
- A new touch rule in a primitive must take the guard, or panels grow.
- Future Browser view panels get the surface, bands, density, and sizing
  from `Panel`; each keeps its own content and bridge calls.
