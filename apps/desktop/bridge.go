package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/flexdinesh/zero/apps/desktop/internal/bridge"
	"github.com/flexdinesh/zero/apps/desktop/internal/experimental"
	"github.com/flexdinesh/zero/apps/desktop/internal/proxy"
	"github.com/flexdinesh/zero/apps/desktop/internal/review"
	"github.com/flexdinesh/zero/pkg/client"
	"github.com/flexdinesh/zero/pkg/contract"
)

// preloadScript is window.zeroDesktop (decisions 0081, 0098) over mygo's IPC,
// on the app's origins only. The UI feature-detects every method. A remote
// server's page gets what its window needs, nothing of this machine: its files
// are elsewhere, and its problem report carries none of this app's logs. The
// methods check again, since a page can call mygo directly. experimental is
// the state the window opened with (decision 0184): a change reopens the
// windows, so it stays true. With it on, every connection's window drives
// the guests of its own Browser tabs.
func preloadScript(state experimental.State) string {
	experiments, err := json.Marshal(state)
	if err != nil {
		experiments = []byte("null")
	}
	browser, titleBar := "", ""
	if state.Enabled {
		browser = `
    browserTabs: true,
    browserOpen(project, url, tab) { return call("BrowserOpen", project, url, tab ?? 1) },
    browserState(project, tab) { return call("BrowserState", project, tab ?? 1) },
    browserAction(project, action, tab) { return call("BrowserAction", project, action, tab ?? 1) },
    browserFrame(project, frame, tab) { return call("BrowserFrame", project, frame, tab ?? 1) },
    browserSnapshot(project, tab) { return call("BrowserSnapshot", project, tab ?? 1) },
    browserPins(project, pins, visible, tab) { return call("BrowserPins", project, pins, visible, tab ?? 1) },
    composerCapture() { return call("ComposerCapture") },
    composerWalk(direction) { return call("ComposerWalk", direction) },
    composerResize(height) { return call("ComposerResize", height) },
    composerClose(sent) { return call("ComposerClose", sent) },`
		// A window of native UI tells its page the room of the window's
		// controls itself; the page reads mygo's variables (decision 0185).
		titleBar = `
  let titleBarSheet = null
  window.mygo.on("zero:title-bar", (room) => {
    const px = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0) + "px"
    if (!titleBarSheet) {
      titleBarSheet = new CSSStyleSheet()
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, titleBarSheet]
    }
    titleBarSheet.replaceSync(":root{--mygo-titlebar-height:" + px(room?.height) + ";--mygo-titlebar-inset-left:" + px(room?.left) + ";--mygo-titlebar-inset-right:" + px(room?.right) + "}")
  })`
	}
	return `(() => {
  if (location.protocol !== "` + proxy.Scheme + `:") return` + titleBar + `
  const call = (method, ...args) => window.mygo.call("Bridge." + method, ...args)
  const window_ = {
    experimental: Object.freeze(` + string(experiments) + `),
    setExperimental(enabled) { return call("SetExperimental", enabled) },
    closeWindow() { void call("CloseWindow").catch(() => undefined) },
    showAppMenu(x, y) { void call("ShowAppMenu", x, y).catch(() => undefined) },
    showContextMenu(items, x, y) { return call("ShowContextMenu", items, x, y) },
    configureNotifications(config) { return call("ConfigureNotifications", config) },
    setAppearance(source) { void call("SetAppearance", source).catch(() => undefined) },` + browser + `
  }
  // Repository identities across windows (decision 0188); a sandbox's page
  // gets none.
  const identities = location.host.startsWith("s-") ? {} : {
    viewedMarks(identity) { return call("ViewedMarks", identity) },
    setViewedMarks(identity, marks) { return call("SetViewedMarks", identity, marks) },
    findProject(identity) { return call("FindProject", identity) },
    openProject(connection, project) { return call("OpenProject", connection, project) },
  }
  window.zeroDesktop = Object.freeze(location.host === "` + proxy.Host + `" ? {
    version: 2,
    ...window_,
    ...identities,
    revealPath(project, path) { return call("RevealPath", project, path) },
    diagnostics() { return call("Diagnostics") },
  } : { version: 2, ...window_, ...identities })
})()`
}

// errRefused answers a sender that is not the app's page or a payload that
// is invalid. Nothing happens, and no dialog says so (decision 0081).
var errRefused = errors.New("refused")

// bridgeService is what the app's page calls. mygo already rejects pages
// that are not trusted; each method checks the sender's URL itself, since
// trust also covers file: and about: pages, then validates its payload.
type bridgeService struct {
	host *host
	// menus lets one context menu or app menu open at a time.
	menus sync.Mutex
}

// callerWindow returns the sender's window, if the sender is the app's page on
// a host known accepts.
func callerWindow(ctx context.Context, known func(host string) bool) (*mygo.Window, bool) {
	page := mygo.CallerPage(ctx)
	if page == nil || !bridge.IsAppPage(page.URL(), proxy.Scheme, known) {
		return nil, false
	}
	window := mygo.CallerWindow(ctx)
	return window, window != nil
}

// isLocal accepts the local connection's page, the only one the methods that
// touch this machine's files answer: a remote server is not trusted with them.
func isLocal(host string) bool { return host == proxy.Host }

// anyConnection accepts a page of the local connection or a saved one.
func (b *bridgeService) anyConnection(host string) bool {
	return b.host.connections.Known(host)
}

// CloseWindow closes the sender's window after the UI closes its final tab.
func (b *bridgeService) CloseWindow(ctx context.Context) error {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return errRefused
	}
	window.Close()
	return nil
}

// ConfigureNotifications takes the project the sender's page shows and the
// user's settings, for the sender's own connection, which comes from its URL and
// never from the payload (decision 0099). It answers whether notices can reach
// the user.
func (b *bridgeService) ConfigureNotifications(ctx context.Context, value any) (bridge.NotificationStatus, error) {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return bridge.NotificationStatus{}, errRefused
	}
	config, ok := bridge.ParseNotifications(value)
	if !ok {
		return bridge.NotificationStatus{}, errRefused
	}
	return b.host.configureNotifications(hostOf(mygo.CallerPage(ctx).URL()), window, config), nil
}

// SetAppearance takes the polarity the sender's page asks the app's menus and
// window controls to follow, "system" while its theme follows the OS, for the
// sender's own connection (decision 0119). macOS applies it; elsewhere it is
// only remembered.
func (b *bridgeService) SetAppearance(ctx context.Context, value any) error {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return errRefused
	}
	source, ok := bridge.ParseAppearance(value)
	if !ok {
		return errRefused
	}
	b.host.setAppearance(hostOf(mygo.CallerPage(ctx).URL()), window, source)
	return nil
}

// SetExperimental remembers whether the user wants experimental features and
// answers the state that results (decision 0184); a build or environment that
// decides it leaves the state as it was. A change reopens the app's windows,
// which are built for one state.
func (b *bridgeService) SetExperimental(ctx context.Context, value any) (experimental.State, error) {
	if _, ok := callerWindow(ctx, b.anyConnection); !ok {
		return experimental.State{}, errRefused
	}
	enabled, ok := value.(bool)
	if !ok {
		return experimental.State{}, errRefused
	}
	return b.host.setExperimental(enabled), nil
}

// Diagnostics answers the app's part of a problem report (decision 0152),
// to the local window only: a remote server is not trusted with this
// machine's logs.
func (b *bridgeService) Diagnostics(ctx context.Context) (bridge.Diagnostics, error) {
	if _, ok := callerWindow(ctx, isLocal); !ok {
		return bridge.Diagnostics{}, errRefused
	}
	return b.host.diagnostics(), nil
}

// RevealPath shows a project file in the file manager; false when refused,
// with a report. Only real paths inside a daemon root are revealed.
func (b *bridgeService) RevealPath(ctx context.Context, project, relative any) (bool, error) {
	if _, ok := callerWindow(ctx, isLocal); !ok {
		return false, errRefused
	}
	projectPath, relativePath, ok := bridge.ParseReveal(project, relative)
	if !ok {
		return false, errRefused
	}
	wait, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var status contract.DaemonStatus
	err := b.host.daemon.Do(wait, func(daemon client.Client) (err error) {
		status, err = daemon.DaemonStatus(wait)
		return err
	})
	if err != nil {
		b.host.report("Could not reveal the file", err.Error())
		return false, nil
	}
	target, err := bridge.ResolveReveal(status.Roots, projectPath, relativePath, filepath.EvalSymlinks)
	if err != nil {
		b.host.report("Could not reveal the file", err.Error())
		return false, nil
	}
	mygo.Shell.ShowItemInFolder(target)
	return true, nil
}

// BrowserOpen shows a page in the project's guest in the sender's window,
// making the guest when the project has none (decision 0184). Any
// connection's window may: the guest is that window's, in its connection's
// own browsing session.
func (b *bridgeService) BrowserOpen(ctx context.Context, project, pageURL, tab any) error {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return errRefused
	}
	request, ok := bridge.ParseBrowserOpen(project, pageURL)
	number, okTab := bridge.ParseBrowserTab(tab)
	if !ok || !okTab {
		return errRefused
	}
	request.Tab = number
	b.host.browserOpen(window, request)
	return nil
}

// BrowserState answers what the Browser tab shows of the project's guest in
// the sender's window, or null when it has none.
func (b *bridgeService) BrowserState(ctx context.Context, project, tab any) (*review.BrowserState, error) {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return nil, errRefused
	}
	name, ok := bridge.ParseBrowserProject(project)
	number, okTab := bridge.ParseBrowserTab(tab)
	if !ok || !okTab {
		return nil, errRefused
	}
	return b.host.browserState(window, guestKey{project: name, tab: number}), nil
}

// BrowserAction does what the Browser tab asks of the project's guest in the
// sender's window; nothing when it has none.
func (b *bridgeService) BrowserAction(ctx context.Context, project, action, tab any) error {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return errRefused
	}
	request, ok := bridge.ParseBrowserAction(project, action)
	number, okTab := bridge.ParseBrowserTab(tab)
	if !ok || !okTab {
		return errRefused
	}
	request.Tab = number
	b.host.browserAct(window, request)
	return nil
}

// BrowserFrame shows the project's guest over the rectangle of the sender's
// page its Browser tab fills, or hides it for null.
func (b *bridgeService) BrowserFrame(ctx context.Context, project, frame, tab any) error {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return errRefused
	}
	request, ok := bridge.ParseBrowserFrame(project, frame)
	number, okTab := bridge.ParseBrowserTab(tab)
	if !ok || !okTab {
		return errRefused
	}
	request.Tab = number
	b.host.browserFrame(window, request)
	return nil
}

// BrowserSnapshot answers the frame the project's guest shows now, a base64
// PNG, or null: the page draws it in the guest's place while one of its own
// layers covers the tab.
func (b *bridgeService) BrowserSnapshot(ctx context.Context, project, tab any) (*string, error) {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return nil, errRefused
	}
	name, ok := bridge.ParseBrowserProject(project)
	number, okTab := bridge.ParseBrowserTab(tab)
	if !ok || !okTab {
		return nil, errRefused
	}
	return b.host.browserSnapshot(window, guestKey{project: name, tab: number}), nil
}

// BrowserPins marks earlier comments on the page of the project's guest in
// the sender's window, shown or hidden; the app places them again after
// each load.
func (b *bridgeService) BrowserPins(ctx context.Context, project, pins, visible, tab any) error {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return errRefused
	}
	request, ok := bridge.ParseBrowserPins(project, pins, visible)
	number, okTab := bridge.ParseBrowserTab(tab)
	if !ok || !okTab {
		return errRefused
	}
	request.Tab = number
	b.host.browserPins(window, request)
	return nil
}

// callerComposer returns the sender's window, if the sender is the composer
// of that window on its own page: the composer's methods answer no other
// page, and the composer's page calls no others.
func (b *bridgeService) callerComposer(ctx context.Context) (*mygo.Window, bool) {
	page := mygo.CallerPage(ctx)
	if page == nil || !bridge.IsComposerPage(page.URL(), proxy.Scheme, composerPath, b.anyConnection) || !b.host.isComposer(page) {
		return nil, false
	}
	window := mygo.CallerWindow(ctx)
	return window, window != nil
}

// ComposerCapture answers the pick waiting for the sender, the composer of
// its window: the page's frame with nothing of the app's on it, and what
// was picked. null when none waits.
func (b *bridgeService) ComposerCapture(ctx context.Context) (*review.Capture, error) {
	window, ok := b.callerComposer(ctx)
	if !ok {
		return nil, errRefused
	}
	return b.host.composerCapture(window), nil
}

// ComposerWalk moves the waiting pick to its parent or back to its child
// and answers it, null when it did not move.
func (b *bridgeService) ComposerWalk(ctx context.Context, direction any) (*review.Capture, error) {
	window, ok := b.callerComposer(ctx)
	if !ok {
		return nil, errRefused
	}
	walk, ok := bridge.ParseWalk(direction)
	if !ok {
		return nil, errRefused
	}
	return b.host.composerWalk(window, walk), nil
}

// ComposerResize gives the composer the height its content asks for, in
// its CSS pixels.
func (b *bridgeService) ComposerResize(ctx context.Context, height any) error {
	window, ok := b.callerComposer(ctx)
	if !ok {
		return errRefused
	}
	asked, ok := bridge.ParseComposerHeight(height)
	if !ok {
		return errRefused
	}
	b.host.composerResize(window, asked)
	return nil
}

// ComposerClose ends the waiting pick: the composer hides and the page
// goes back to picking. sent says a comment was made of it.
func (b *bridgeService) ComposerClose(ctx context.Context, sent any) error {
	window, ok := b.callerComposer(ctx)
	if !ok {
		return errRefused
	}
	made, ok := sent.(bool)
	if !ok {
		return errRefused
	}
	if frame := b.host.shellOf(window); frame != nil {
		b.host.endComposing(frame, nil, made)
	}
	return nil
}

// ShowContextMenu pops a native menu at a point in the page and answers the
// chosen id, or null when dismissed.
func (b *bridgeService) ShowContextMenu(ctx context.Context, items, x, y any) (*string, error) {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return nil, errRefused
	}
	width, height := window.ContentSize()
	point, okPoint := bridge.ParsePoint(x, y, width, height)
	rows, okItems := bridge.ParseItems(items)
	if !okPoint || !okItems || !b.menus.TryLock() {
		return nil, errRefused
	}
	defer b.menus.Unlock()
	var chosen *string
	entries := make([]*mygo.MenuItem, 0, len(rows))
	for _, row := range rows {
		if row.Separator {
			entries = append(entries, mygo.Separator())
			continue
		}
		id := row.ID
		entries = append(entries, &mygo.MenuItem{
			Label:    row.Label,
			Disabled: !row.Enabled,
			Click:    func(*mygo.MenuItem, *mygo.Window) { chosen = &id },
		})
	}
	mygo.NewMenu(entries).PopupAt(window, point.X, point.Y)
	return chosen, nil
}

// ShowAppMenu pops the app menu at a point in the page (decision 0075).
func (b *bridgeService) ShowAppMenu(ctx context.Context, x, y any) error {
	window, ok := callerWindow(ctx, b.anyConnection)
	if !ok {
		return errRefused
	}
	width, height := window.ContentSize()
	point, okPoint := bridge.ParsePoint(x, y, width, height)
	if !okPoint || !b.menus.TryLock() {
		return errRefused
	}
	defer b.menus.Unlock()
	b.host.menu().PopupAt(window, point.X, point.Y)
	return nil
}

// menu is the app menu: the menu bar's, and ShowAppMenu's. It is built for
// the kind of window the app opens now (decision 0184).
func (h *host) menu() *mygo.Menu {
	view := &mygo.MenuItem{Role: mygo.RoleViewMenu}
	experiments := h.experimental().Enabled
	if experiments {
		view = h.viewMenu(runtime.GOOS)
	}
	items := []*mygo.MenuItem{
		{Role: mygo.RoleAppMenu},
		{Label: "File", Submenu: []*mygo.MenuItem{
			{Label: "Open Folder…", Accelerator: "CmdOrCtrl+O", Click: func(_ *mygo.MenuItem, window *mygo.Window) { go h.chooseFolder(window) }},
			mygo.Separator(),
			{Role: mygo.RoleQuit},
		}},
		{Role: mygo.RoleEditMenu},
		view,
		h.goMenu(runtime.GOOS),
	}
	if experiments {
		items = append(items, h.browserMenu())
	}
	return mygo.NewMenu(append(items, h.windowMenu(runtime.GOOS), h.helpMenu()))
}

// viewMenu is the View menu of windows of native UI (decision 0184). mygo's
// own reload, inspector, and zoom items act on a page window's page and do
// nothing there, so these act on the app's page in the window's web view,
// with the same keys. Reload reloads what the user looks at: the Browser
// tab's page while it shows.
func (h *host) viewMenu(goos string) *mygo.MenuItem {
	inspector := "Ctrl+Shift+I"
	if goos == "darwin" {
		inspector = "Alt+Cmd+I"
	}
	item := func(label, accelerator string, act func(page *mygo.Page)) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Accelerator: accelerator, Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window == nil {
				return
			}
			if page := h.page(window); page != nil {
				go act(page)
			}
		}}
	}
	reload := func(label, accelerator string, ignoreCache bool) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Accelerator: accelerator, Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window != nil {
				go h.reloadShown(window, ignoreCache)
			}
		}}
	}
	// A zoom changes the CSS pixels of the room the window's controls take,
	// which mygo tells only a page window's page (decision 0185).
	zoom := func(label, accelerator string, next func(current float64) float64) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Accelerator: accelerator, Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window == nil {
				return
			}
			page := h.page(window)
			if page == nil {
				return
			}
			go func() {
				page.SetZoomFactor(next(page.ZoomFactor()))
				if frame := h.shellOf(window); frame != nil {
					frame.sendTitleBar()
				}
			}()
		}}
	}
	return &mygo.MenuItem{Label: "View", Submenu: []*mygo.MenuItem{
		reload("Reload", "CmdOrCtrl+R", false),
		reload("Force Reload", "Shift+CmdOrCtrl+R", true),
		item("Toggle Developer Tools", inspector, (*mygo.Page).ToggleDevTools),
		mygo.Separator(),
		zoom("Actual Size", "CmdOrCtrl+0", func(float64) float64 { return 1 }),
		zoom("Zoom In", "CmdOrCtrl+Plus", func(current float64) float64 { return nextZoom(current, 1) }),
		zoom("Zoom Out", "CmdOrCtrl+-", func(current float64) float64 { return nextZoom(current, -1) }),
		mygo.Separator(),
		{Role: mygo.RoleToggleFullScreen},
	}}
}

// goMenu moves through the window's history with VS Code's keys (decision
// 0131): Ctrl+Alt+- and Ctrl+Shift+- outside macOS, Ctrl+- and Ctrl+Shift+-
// on macOS. The page owns history; the menu names the move.
func (h *host) goMenu(goos string) *mygo.MenuItem {
	back := "Ctrl+Alt+-"
	if goos == "darwin" {
		back = "Ctrl+-"
	}
	item := func(label, accelerator, move string) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Accelerator: accelerator, Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window != nil {
				go h.navigate(window, move)
			}
		}}
	}
	return &mygo.MenuItem{Label: "Go", Submenu: []*mygo.MenuItem{
		item("Back", back, "back"),
		item("Forward", "Ctrl+Shift+-", "forward"),
		mygo.Separator(),
		item("Recent Locations…", "", "recent"),
	}}
}

// navigate asks the page to make a history move; pages without a
// workspace ignore it.
func (h *host) navigate(window *mygo.Window, move string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.page(window).EvalContext(ctx, `return window.dispatchEvent(new CustomEvent("zero:navigate", { detail: `+strconv.Quote(move)+`, cancelable: true }))`)
}

// windowMenu replaces the native Close action with the workspace's Close Tab.
func (h *host) windowMenu(goos string) *mygo.MenuItem {
	closeTab := &mygo.MenuItem{Label: "Close Tab", Accelerator: "CmdOrCtrl+W", Click: func(_ *mygo.MenuItem, window *mygo.Window) {
		if window != nil {
			go h.closeTab(window)
		}
	}}
	if goos != "darwin" {
		return &mygo.MenuItem{Role: mygo.RoleWindowMenu, Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleMinimize}, closeTab,
		}}
	}
	return &mygo.MenuItem{Role: mygo.RoleWindow, Submenu: []*mygo.MenuItem{
		{Role: mygo.RoleMinimize},
		{Role: mygo.RoleZoom},
		closeTab,
		mygo.Separator(),
		{Role: mygo.RoleFront},
	}}
}

// closeTab asks the UI to close its active tab. Pages without a workspace
// (including startup failures) retain the native close behavior.
func (h *host) closeTab(window *mygo.Window) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	unhandled, err := h.page(window).EvalContext(ctx, `return window.dispatchEvent(new Event("zero:close-tab", { cancelable: true }))`)
	if err == nil && unhandled == true {
		window.Close()
	}
}

// chooseFolder asks the window's page to browse for a folder (decision
// 0146): the server browses its own disk, so local and remote windows work
// alike. With no window open, the local one opens.
func (h *host) chooseFolder(window *mygo.Window) {
	if window == nil {
		window = h.frontWindow()
	}
	if window == nil {
		h.load(proxy.Origin + "/")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.page(window).EvalContext(ctx, `return window.dispatchEvent(new Event("zero:open-folder", { cancelable: true }))`)
}

// browserMenu drives the window's Browser tab (decision 0184) with keys that
// work while the guest has the keyboard, which the page's own never do.
// New Tab (decision 0195) asks the page for another Browser tab; Open
// Location… hands the keyboard to the tab's address field; Back and
// Forward move the guest that shows, whose own Alt+Left and Alt+Right
// guest.js answers; Comment turns its comment mode on and off.
func (h *host) browserMenu() *mygo.MenuItem {
	move := func(label, action string) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window == nil {
				return
			}
			if frame := h.shellOf(window); frame != nil {
				if shown := frame.shownGuest(); shown != nil {
					go shown.act(action)
				}
			}
		}}
	}
	return &mygo.MenuItem{Label: "Browser", Submenu: []*mygo.MenuItem{
		{Label: "New Tab", Accelerator: "CmdOrCtrl+T", Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window != nil {
				go h.browserCommand(window, "newTab")
			}
		}},
		{Label: "Open Location…", Accelerator: "CmdOrCtrl+L", Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window != nil {
				go h.browserCommand(window, "location")
			}
		}},
		mygo.Separator(),
		move("Back", bridge.BrowserBack),
		move("Forward", bridge.BrowserForward),
		mygo.Separator(),
		{Label: "Comment", Accelerator: "CmdOrCtrl+Shift+C", Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window == nil {
				return
			}
			if frame := h.shellOf(window); frame != nil {
				if shown := frame.shownGuest(); shown != nil {
					go shown.setCommenting(!shown.isCommenting())
				}
			}
		}},
	}}
}
