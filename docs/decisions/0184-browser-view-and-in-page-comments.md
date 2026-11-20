# 0184: Browser view and in-page comments (experimental)

- Status: Accepted
- Date: 2026-11-20
- Supersedes: [0177](0177-ui-review-in-the-desktop-app.md) (review windows,
  Comment on Screen), [0180](0180-hit-map-at-capture.md) (hit map, frozen
  frame selection), [0181](0181-project-browser-tab.md) (the Browser tab as
  a remote control), [0175](0175-guest-browser-host-window.md)'s Window
  decision, and [0176](0176-visual-feedback-targets.md)'s UI section
  (the frozen-frame composer and pasted screenshots)
- Extends: [0176](0176-visual-feedback-targets.md) (visual targets, storage,
  redaction), [0182](0182-screen-tabs-for-visual-threads.md) (screen tabs),
  [0178](0178-agent-facing-visual-thread-output.md) (agent output),
  [0094](0094-mygo-app-uses-web-views.md), [0081](0081-desktop-bridge-v2-native-features.md)

## Context

0175 through 0183 review a UI in four places: a menu opens an address
palette, the page shows in a second window with no controls, a menu item or
F8 freezes a frame, and the comment is written in Zero's window over the
frozen frame. Each step works; together they are clunky. Tools such as
Agentation let the reviewer point at the live page and write beside the
element.

0175 kept the guest out of Zero's window because mygo allows an embedded web
view only in a window of native UI, and Zero's window was a page. A spike
(Linux, WebKitGTK 2.50, Xvfb, mygo v0.7.4) built Zero's window as native UI
holding three web views, Zero's page filling it, a guest page over a
rectangle of it, and a third over the guest, and found:

- **Stacking.** Web views stack in the order the view builds them: the guest
  shows above Zero's page, the third above the guest.
- **Keyboard.** A click gives the clicked web view the keyboard, and
  `WebView.Focus` gives it from Go.
- **Trust.** Zero's pages call the bridge with their window as
  `CallerWindow`; the `Untrusted` guest is refused.
  `CallerPage(...).WebView()` tells a web view's page in the proxy.
- **Pick channel.** `Page.Eval` awaits a promise the guest's preload resolves
  on the user's click. No new channel from the page to Go is needed.
- **Capture.** `WebView.CapturePage` answers the guest's frame while it shows
  and while it is hidden; a hidden guest keeps its page.
- **Resize.** A guest follows its rectangle while it shows. One hidden and
  shown again at another size keeps its old size until the next change
  (mygo, Linux); placing it one pixel wider for a frame fixes it.
- **Automation.** mygo's automation plugin evaluates scripts in page windows
  only, so the built app needs its own driver for tests of this window.

macOS was not run: hidden title bars and drag regions with a window of native
UI, and the same stacking and keyboard rules, are unverified there.

## Decision

### Experimental features

- The whole of this record ships behind one switch, the app's **experimental
  features**. They are on when, in this order: `ZERO_EXPERIMENTAL=0` in the
  app's environment says off, over everything; the build is a development
  install (`scripts/install-dev.sh` stamps `main.experimentalBuild=1`, and
  `mise run dev:desktop` sets the variable); `ZERO_EXPERIMENTAL=1` is in the
  app's environment; or the user turned on Settings › Experimental Features.
- The app owns the switch (`apps/desktop/internal/experimental`): its
  environment, its stamp, and `experimental.json` in its user data. A macOS
  app started from the Dock sees no shell environment, so the setting is the
  way there. The server and the CLI know nothing of it.
- The page reads `window.zeroDesktop.experimental` (`{enabled, source}`), the
  state its window opened with, and `setExperimental(enabled)` stores the
  choice. A change reopens the app's windows on the pages they showed, since
  a window is built for one state. A build or environment that decides the
  state locks the setting, which says why.
- Off, nothing here shows: no Browser view, no screen tabs, no visual threads
  in the Feedback view or its badge. The window is the page window it always
  was. The CLI still prints visual threads: agents read the store, not the
  app.

### Window

- With experimental features on, a connection's window is a window of native
  UI whose view places web views: Zero's page filling it, the active Browser
  tab's guest over the rectangle the page reports, and the composer over
  the guest. Off, the window is a page, as before.
- Zero's page keeps its preload, navigation policy, crash reload, theme
  color, and bridge. Bridge methods find the sender's window through
  `CallerWindow`, as before.
- The page reports the Browser tab's body rectangle in CSS pixels
  (`browserFrame`); the app scales it by the page's zoom. While one of Zero's
  dialogs, menus, or palettes is open over the tab, the page hides the guest
  and shows its last frame in its place: Zero's page is under the guest and
  cannot draw over it.

### Browser

- **Name and place.** Browser is an activity beside Feedback, in the desktop
  app only: local, remote, and sandbox windows alike. Its view lists the
  project's pages and the comments on the page that shows, and says where
  comments go. Each project has one Browser tab, whose body is the page.
- **Tab.** Back, Forward, Reload (Stop while loading), the address field
  over the project's recent pages, the Comment toggle, and whether pins
  show. Closing the tab closes its page.
- **Guest.** One `Untrusted` web view per project and window, in a session
  per connection (`browser-<connection>`), so a remote server's page drives
  only the browsing done in its own window. 0175's navigation policy stands;
  permissions are denied; new windows open in the system browser. The proxy
  refuses guest pages, as it refused guest windows.
- **Any site.** The address field takes any http or https page: a dev
  server, staging, production.
- **Remote.** A loopback address in a remote or sandbox window is this
  computer's; 0176's `localhost: viewer` rule already says so on the thread.

### Comments

- **Pick.** Comment (Ctrl/Cmd+Shift+C, a menu accelerator, so it works while
  the page has the keyboard) puts the page in comment mode: the guest's
  preload outlines the element under the pointer and names it, a click
  selects it, a drag selects a region, Alt+Up and Alt+Down walk to the parent
  and back, and Escape leaves. The page's own input is swallowed meanwhile.
  There is no delayed pick; hover menus are for later.
- **Composer.** The composer is a page of Zero's in its own small web view
  beside the selected element, never inside the guest: the guest's scripts
  can neither read the comment nor send one. It names the element, lists
  what it sends, says where the comment goes, and sends on Ctrl/Cmd+Enter.
- **What a comment carries.** 0176's visual target (the screenshot region
  with its margin, the rectangle, the page, the element hint) and more of
  the element, all the page's word, bounded and escaped: its ancestor path,
  classes, a fixed set of attributes, a fixed set of computed styles, the
  component chain and source location when the framework's development build
  exposes them, nearby text, the selected text, and the page's color scheme.
  0176's rule stands: no field values, no text of fields or editable regions.
- **Pins.** A sent comment leaves a numbered pin on its element, placed
  again after reloads by the element's selector. The Browser view lists the
  page's threads; a thread opens its screen tab (0182).
- **Which page.** A thread belongs to the page with its origin and path,
  and its hash when the hash is a route (`#/…`, `#!…`). The query is
  ignored for the list, and a thread's row shows its whole address; pins
  appear only where their element is.
- **Gone.** Review windows, the Review menu, F8 and Shift+F8, the frozen
  frame composer, the hit map, and pasted screenshots.

### As built

- **Keys.** The app's menus carry the keys that must work while a guest has
  the keyboard: View › Reload (the guest that shows, else Zero's page),
  Zoom, and Developer Tools act on Zero's page; Browser › Open Location…
  (Ctrl/Cmd+L), Back, Forward, and Comment act on the guest that shows.
  guest.js gives the page Alt+Left, Alt+Right (Cmd+[ and Cmd+] on macOS),
  and F5.
- **Events, not a new channel.** The app awaits `__zeroBrowser.next()` in
  the guest and asks again: a pick, Escape, a press while a pick waits, and
  a click on a pin each answer one. A pick hides everything the script
  drew, waits two frames, and answers; the app takes the frame, then has
  the script outline the pick. Whatever the page answers is validated and
  bounded in `internal/review` (`ParseEvent`, `ParseSelection`).
- **Composer.** `<origin>/composer`, loaded when comment mode first turns
  on and kept hidden between picks. Only that web view on that path may
  call `composerCapture`, `composerWalk`, `composerResize`, and
  `composerClose`; it calls no other bridge method. `PlaceComposer` puts it
  under the pick, else over it, inside the guest's frame.
- **A page that leaves** ends comment mode and drops a waiting pick. Pins
  are placed again after each load.
- **Contract.** A visual element's `selector` is optional; it gains `path`,
  `classes`, `attributes`, `styles`, `component`, `source`, `nearby`, and
  `selectedText`, and the page `colorScheme`. The server stores a `source`
  inside the project relative to it. An attribute named `value` is refused.
- **Tests of the window.** The built app serves its own driver on a Unix
  socket under `-tags e2e` (`e2e_driver.go`): eval and capture in Zero's
  page, a guest, or the composer, and what the window shows where. The
  desktop group drives the real tab over a real page, a pick by pointer,
  the frame's pixels, the walk, a region, pins, and the composer's bridge.

## Consequences

- Reviewing a UI happens in one window: the page, the pick, and the comment.
- The window of native UI is new ground for the app and unverified on macOS.
  Until it is, `ZERO_EXPERIMENTAL=0` runs any build without it, and no one
  gets it without asking.
- Element facts remain the page's word. A hostile page can lie about what
  was picked; it cannot write or send a comment.
- A remote window's page can navigate and capture its own guest. It sees
  only what was browsed in that window's session.
- Tooltips of Zero's that would overlap the guest's top edge show under it.
- Agents get more to locate the code with: the component and source
  location, where a framework's development build gives them.

## Follow-up

- Run the window and the comment loop on macOS.
- Hover menus and animations: a delayed pick or a freeze.
- Report mygo's stale size for a web view shown again.
- The branch picker's open counts and Delete Feedback still include visual
  threads with experimental features off.
- A pick in a page that scrolls by dragging its scrollbar can leave the
  composer behind its element.
