# 0175: Guest browser host window

- Status: Accepted; Window superseded by
  [0184](0184-browser-view-and-in-page-comments.md)
- Date: 2026-11-19
- Extends: [0094](0094-mygo-app-uses-web-views.md) (the OS web view hosts
  pages), [0095](0095-desktop-app-is-mygo-electron-removed.md) (mygo v0.7.4),
  [0081](0081-desktop-bridge-v2-native-features.md) (the bridge answers Zero's
  pages only), [0067](0067-desktop-shell-and-protocol-proxy.md) (proxy rules)

## Context

The desktop app will show other sites, local dev servers and public pages, in
a guest browser. Before building it we checked what mygo v0.7.4 and the OS web
views give us, with a throwaway spike on Linux (Debian 12, WebKitGTK 2.50.6,
GTK 3.24.38, Xvfb, `GDK_SCALE` 1 and 2). macOS was only read in mygo's source.

On Linux the spike found:

- **Navigation.** http and https load, both `localhost` and public sites. A
  self-signed certificate reaches `SetCertificateErrorHandler`, then fails.
  `OnWillNavigate` and `SetWindowOpenHandler` see what the page asks for.
- **State.** `mygo.NewSession(name)`, the default session, and
  `NewEphemeralSession()` keep separate cookies and storage. A named session
  survives restarts; `ClearData(SiteDataAll)` empties it.
- **Bridge.** With `PageOptions.Untrusted`, a page calls no Go method:
  neither `Bridge.*` nor mygo's own `window.mygo.window.*`. Without it, mygo
  trusts `about:` and `file:` pages, and in dev builds any `localhost` page:
  they called `Bridge.Ping` and read `zero-app://` responses.
- **Custom scheme.** Even an untrusted page reaches the `zero-app` handler
  with `no-cors` fetches, images, and scripts, which send no `Origin`. The
  proxy refuses only a foreign `Origin`, so these would reach the daemon.
  `mygo.CallerPage` names the asking page on every request.
- **Keyboard.** App menu shortcuts fire before the page, whatever the page
  prevents. While a native menu, a `<select>`, or WebKit's context menu is
  open, the menu takes every key and Escape closes it.
- **Native UI over a page.** In a window of native UI with a `WebView`, a
  native popover over the page does not take the keyboard, and focusing a
  native text field leaves the keys going to the page.
- **Screenshots.** `CapturePage` is the visible viewport in device pixels:
  pixels = CSS pixels × zoom factor × `devicePixelRatio`.
  `devicePixelRatio` follows the display scale; zoom does not change it.
- **Element lookup.** `Eval` runs in the page's world: a page that replaces
  `JSON.stringify` decides every result. Cross-origin frames and closed
  shadow roots are opaque.
- **Frames.** Linux reports unnamed iframes' navigations to `OnWillNavigate`
  as main-frame ones.
- **Menus.** `App.SetMenu` gives Zero's menu bar to every window without its
  own, guest windows included.

## Decision

- **Window.** A guest page shows in a top-level page window of its own:
  `mygo.NewWindow`, not a `WebView` inside Zero's window, which mygo allows
  only in windows of native UI.
- **Untrusted.** Every guest page sets `PageOptions.Untrusted`. Nothing else
  keeps `about:` and dev `localhost` pages away from Go methods.
- **Sessions.** Guests use `mygo.NewSession(profile)` for a profile that
  persists, or `NewEphemeralSession()` for a private one, never the default
  session.
- **Policy.** Guest windows have their own handlers: navigation allows http
  and https in the main frame, and also `about:blank`, `about:srcdoc`,
  `data:`, and `blob:`, since Linux reports frames as main. `zero-app:`,
  `zero:`, and `file:` are refused. Permissions are denied. Window opens,
  downloads, and certificate errors are decided by the guest, never by Zero's
  own policy.
- **Menu.** A guest window sets its own menu (`Window.SetMenu`) instead of
  inheriting Zero's.
- **Proxy.** The protocol proxy refuses a request whose `mygo.CallerPage` is
  not one of Zero's windows. This lands before any guest window ships.
- **Screenshots and lookup.** Map CSS to screenshot pixels with zoom factor
  × `devicePixelRatio`, not the PNG's width over `innerWidth`, which rounds.
  Element lookup is best effort and its results are the page's word, never
  trusted for authorization or security decisions.

## Consequences

- No framework change is needed for the guest window itself.
- These need a mygo change, and stay out until one exists: a guest inside
  Zero's window; element lookup in an isolated world; native chrome (address
  field, popovers) over a page on Linux, where the keyboard stays in the
  page; full-page screenshots; real input injection, rather than synthetic DOM
  events.
- A page window has no browser chrome. Where the address field and the Back,
  Forward, and Reload controls live is not decided here.
- macOS is unverified: whether a page can swallow Cmd shortcuts before the
  menu, the snapshot's pixel scale, and sessions before macOS 14, which keep
  their data in memory. Run the spike there before relying on these.
