# 0195: Browser tabs, page history, and https by default

- Status: Accepted
- Date: 2026-11-24
- Extends: [0184](0184-browser-view-and-in-page-comments.md)

## Context

0184's Browser remembers a project's pages, eight per project, newest
first, and offers no way to remove one: a mistyped address stays until
eight newer pages push it out. Pages are labeled without their scheme, so
`http://example.test/` and `https://example.test/` show as two identical
rows. An address typed without a scheme opens over http, which most
public sites only redirect from. And a project has one Browser tab, so
comparing two pages, or keeping staging beside the dev server, means
typing addresses back and forth.

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

### Browser tabs

- A project can have many Browser tabs, each a tab in the tab bar with its
  own guest: its page, history, load state, comment mode, and pins. A tab
  is a number from 1 to 99 (`browser=<n>` in the route, `{browser: true,
  id}` in memory; no id, and `browser=1`, are tab 1, as before). A new tab
  takes the lowest number not open.
- The desktop app keys guests by project and tab. Every `browser*` bridge
  method takes the tab last; the preload passes 1 for a page that names
  none, and says `browserTabs: true`. A page offers tabs past the first only
  where it sees that, so an older app, or an older server's page in a newer
  app, keeps one Browser tab. `zero:browser` still names only the project:
  the page reads its tabs' states. `zero:browser-command` adds the tab.
- **Opening.** Browser › New Tab (Ctrl/Cmd+T, a menu accelerator, so it
  works while a page has the keyboard), the palette's Browser: New Tab, and
  the same keys in Zero's page open a tab with its address field ready.
  Cmd/Ctrl-click or a middle click on a page in the Browser view opens it in
  a new tab. These exist only with experimental features on, as the Browser
  does.
- **Choosing a page** in the view switches to a tab that shows it, the one
  followed first, without loading it again; otherwise it loads in the tab
  followed: the Browser tab that shows, else the one shown last, else the
  first open. A page open in any tab is marked in the view with a square,
  as pins are, which the remove button replaces on hover.
- The view's comments, the pins, Open Location, and the Browser activity
  act on the tab followed. Tabs of one host are named with their paths; tabs
  with no page yet are Browser, Browser 2, and so on.
- **Closing a tab** closes only its page.
- **Pages that closed.** A window keeps at most 8 guests, across projects
  and tabs; past that the one shown longest ago closes, as before. Each tab
  remembers the address it showed (`zero-browser-tabs`, by project and
  tab). A tab without a guest that remembers one, after that eviction or a
  restart, says the page is not loaded and offers Reload page; it loads
  nothing until asked.
- Links a page opens in a new window still go to the system browser.

## Consequences

- A dev server on a public-looking name, or one that serves only http on a
  LAN name not ending in `.local`, needs `http://` typed once; it is then
  remembered with its scheme.
- The desktop app's check (`review.CheckURL`) is unchanged: the page sends
  absolute addresses.
- Each tab is a web process. The 8-guest limit bounds memory; tabs past it
  lose their page's own state (scroll, form input) when it closes.
- A project's tabs share its connection's browsing session: one sign-in
  serves them all.
