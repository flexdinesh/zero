# 0195: Browser page history and https by default

- Status: Accepted
- Date: 2026-11-24
- Extends: [0184](0184-browser-view-and-in-page-comments.md)

## Context

0184's Browser remembers a project's pages, eight per project, newest
first, and offers no way to remove one: a mistyped address stays until
eight newer pages push it out. Pages are labeled without their scheme, so
`http://example.test/` and `https://example.test/` show as two identical
rows. And an address typed without a scheme opens over http, which most
public sites only redirect from.

## Decision

### Removing pages

- A remembered page can be removed one at a time: the remove button on its
  row in the Browser view, the address list, and the empty stage's recent
  pages, which shows on hover or keyboard focus (always on a phone); Delete
  or Backspace on a focused row of the view, after which focus moves to the
  next row; and Shift+Delete on the highlighted remembered page of the
  address list. There is no bulk clear and no context menu.
- Removing a page only forgets it. A tab that shows it keeps showing it.

### Labels

- A page's label drops its scheme only when typing the label would open the
  same address. Otherwise the scheme stays, `http://example.test/`, so two
  rows never read the same.

### https by default

- An address typed without a scheme opens over https, except a host where
  dev servers serve plain http: this machine (`localhost`, `*.localhost`,
  `127.0.0.0/8`, `[::1]`), a private IPv4 address (`10/8`, `172.16/12`,
  `192.168/16`), or a `.local` name. Those open over http. A typed scheme is
  always kept, and remembered pages keep theirs.

## Consequences

- A dev server on a public-looking name, or one that serves only http on a
  LAN name not ending in `.local`, needs `http://` typed once; it is then
  remembered with its scheme.
- The desktop app's check (`review.CheckURL`) is unchanged: the page sends
  absolute addresses.
