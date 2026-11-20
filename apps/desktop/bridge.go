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
// are elsewhere, its problem report carries none of this app's logs, and the
// review windows (decision 0177) and their Browser tab (decision 0181) are
// this machine's. The methods check again, since a page can call mygo
// directly. experimental is the state the window opened with (decision 0184):
// a change reopens the windows, so it stays true.
func preloadScript(state experimental.State) string {
	experiments, err := json.Marshal(state)
	if err != nil {
		experiments = []byte("null")
	}
	return `(() => {
  if (location.protocol !== "` + proxy.Scheme + `:") return
  const call = (method, ...args) => window.mygo.call("Bridge." + method, ...args)
  const window_ = {
    experimental: Object.freeze(` + string(experiments) + `),
    setExperimental(enabled) { return call("SetExperimental", enabled) },
    closeWindow() { void call("CloseWindow").catch(() => undefined) },
    showAppMenu(x, y) { void call("ShowAppMenu", x, y).catch(() => undefined) },
    showContextMenu(items, x, y) { return call("ShowContextMenu", items, x, y) },
    configureNotifications(config) { return call("ConfigureNotifications", config) },
    setAppearance(source) { void call("SetAppearance", source).catch(() => undefined) },
  }
  window.zeroDesktop = Object.freeze(location.host === "` + proxy.Host + `" ? {
    version: 2,
    ...window_,
    revealPath(project, path) { return call("RevealPath", project, path) },
    diagnostics() { return call("Diagnostics") },
    openReview(project, url) { return call("OpenReview", project, url) },
    screenCapture() { return call("ScreenCapture") },
    browserState(project) { return call("BrowserState", project) },
    browserAction(project, action) { return call("BrowserAction", project, action) },
  } : { version: 2, ...window_ })
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

// OpenReview shows a page of the developer's app in the project's guest
// window (decision 0177), from the local window only: its screen comments
// read and write this machine's feedback.
func (b *bridgeService) OpenReview(ctx context.Context, project, pageURL any) error {
	if _, ok := callerWindow(ctx, isLocal); !ok {
		return errRefused
	}
	request, ok := bridge.ParseOpenReview(project, pageURL)
	if !ok {
		return errRefused
	}
	b.host.reviews.open(request)
	return nil
}

// BrowserState answers what the Browser tab shows of the project's guest
// window, or null when it has none (decision 0181), to the local window only.
func (b *bridgeService) BrowserState(ctx context.Context, project any) (*review.BrowserState, error) {
	if _, ok := callerWindow(ctx, isLocal); !ok {
		return nil, errRefused
	}
	name, ok := bridge.ParseBrowserProject(project)
	if !ok {
		return nil, errRefused
	}
	return b.host.reviews.state(name), nil
}

// BrowserAction does what the Browser tab asks of the project's guest window
// (decision 0181), from the local window only; nothing when it has none.
func (b *bridgeService) BrowserAction(ctx context.Context, project, action any) error {
	if _, ok := callerWindow(ctx, isLocal); !ok {
		return errRefused
	}
	request, ok := bridge.ParseBrowserAction(project, action)
	if !ok {
		return errRefused
	}
	b.host.reviews.act(request)
	return nil
}

// ScreenCapture answers the screen capture waiting for a comment, once, or
// null (decision 0177), to the local window only.
func (b *bridgeService) ScreenCapture(ctx context.Context) (*review.Capture, error) {
	if _, ok := callerWindow(ctx, isLocal); !ok {
		return nil, errRefused
	}
	return b.host.reviews.takeCapture(), nil
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
	if h.experimental().Enabled {
		view = h.viewMenu(runtime.GOOS)
	}
	return mygo.NewMenu([]*mygo.MenuItem{
		{Role: mygo.RoleAppMenu},
		{Label: "File", Submenu: []*mygo.MenuItem{
			{Label: "Open Folder…", Accelerator: "CmdOrCtrl+O", Click: func(_ *mygo.MenuItem, window *mygo.Window) { go h.chooseFolder(window) }},
			mygo.Separator(),
			{Role: mygo.RoleQuit},
		}},
		{Role: mygo.RoleEditMenu},
		view,
		h.goMenu(runtime.GOOS),
		h.reviewMenu(),
		h.windowMenu(runtime.GOOS),
		h.helpMenu(),
	})
}

// viewMenu is the View menu of windows of native UI (decision 0184). mygo's
// own reload, inspector, and zoom items act on a page window's page and do
// nothing there, so these act on the app's page in the window's web view,
// with the same keys.
func (h *host) viewMenu(goos string) *mygo.MenuItem {
	inspector := "Ctrl+Shift+I"
	if goos == "darwin" {
		inspector = "Alt+Cmd+I"
	}
	item := func(label, accelerator string, act func(page *mygo.Page)) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Accelerator: accelerator, Click: func(_ *mygo.MenuItem, window *mygo.Window) {
			if window == nil || h.shellOf(window) == nil {
				return
			}
			go act(h.page(window))
		}}
	}
	zoom := func(direction int) func(page *mygo.Page) {
		return func(page *mygo.Page) { page.SetZoomFactor(nextZoom(page.ZoomFactor(), direction)) }
	}
	return &mygo.MenuItem{Label: "View", Submenu: []*mygo.MenuItem{
		item("Reload", "CmdOrCtrl+R", (*mygo.Page).Reload),
		item("Force Reload", "Shift+CmdOrCtrl+R", (*mygo.Page).ReloadIgnoringCache),
		item("Toggle Developer Tools", inspector, (*mygo.Page).ToggleDevTools),
		mygo.Separator(),
		item("Actual Size", "CmdOrCtrl+0", func(page *mygo.Page) { page.SetZoomFactor(1) }),
		item("Zoom In", "CmdOrCtrl+Plus", zoom(1)),
		item("Zoom Out", "CmdOrCtrl+-", zoom(-1)),
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
// workspace ignore it. A guest window moves through its page's history.
func (h *host) navigate(window *mygo.Window, move string) {
	if h.reviews.isReview(window) {
		switch move {
		case "back":
			h.reviews.actOn(window, bridge.BrowserBack)
		case "forward":
			h.reviews.actOn(window, bridge.BrowserForward)
		}
		return
	}
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
	if h.reviews.isReview(window) {
		window.Close()
		return
	}
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

// reviewMenu reviews the developer's app (decision 0177): Review URL… asks
// the local window for a page to open in a guest window; F8 captures the
// focused guest window's page for a comment; Shift+F8 captures it after a
// countdown, for menus and hovers that a key press would close.
func (h *host) reviewMenu() *mygo.MenuItem {
	return &mygo.MenuItem{Label: "Review", Submenu: []*mygo.MenuItem{
		{Label: "Review URL…", Click: func(*mygo.MenuItem, *mygo.Window) { go h.reviewURL() }},
		mygo.Separator(),
		h.commentItem(false),
		h.commentItem(true),
	}}
}

// commentItem is Comment on Screen, or its countdown, acting on a guest
// window.
func (h *host) commentItem(delay bool) *mygo.MenuItem {
	item := &mygo.MenuItem{Label: "Comment on Screen", Accelerator: "F8"}
	if delay {
		item = &mygo.MenuItem{Label: "Comment on Screen in 3 Seconds", Accelerator: "Shift+F8"}
	}
	item.Click = func(_ *mygo.MenuItem, window *mygo.Window) { h.reviews.comment(window, delay) }
	return item
}

// reviewWindowMenu is a guest window's own menu bar (decision 0175) on
// Linux and Windows; macOS shows the app's, whose items act on it too. Open
// Location… hands the keyboard to the Browser tab's address field in the
// local window (decision 0181): the guest window has none.
func (h *host) reviewWindowMenu() *mygo.Menu {
	page := func(action string) func(*mygo.MenuItem, *mygo.Window) {
		return func(_ *mygo.MenuItem, window *mygo.Window) {
			if window != nil {
				go h.reviews.actOn(window, action)
			}
		}
	}
	return mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Page", Submenu: []*mygo.MenuItem{
			{Label: "Open Location…", Accelerator: "CmdOrCtrl+L", Click: func(_ *mygo.MenuItem, window *mygo.Window) {
				if window != nil {
					go h.reviews.openLocation(window)
				}
			}},
			mygo.Separator(),
			{Label: "Back", Accelerator: "Alt+Left", Click: page(bridge.BrowserBack)},
			{Label: "Forward", Accelerator: "Alt+Right", Click: page(bridge.BrowserForward)},
			{Label: "Reload", Accelerator: "CmdOrCtrl+R", Click: page(bridge.BrowserReload)},
			mygo.Separator(),
			{Label: "Close Window", Accelerator: "CmdOrCtrl+W", Click: func(_ *mygo.MenuItem, window *mygo.Window) {
				if window != nil {
					window.Close()
				}
			}},
		}},
		{Role: mygo.RoleEditMenu},
		{Label: "Review", Submenu: []*mygo.MenuItem{h.commentItem(false), h.commentItem(true)}},
	})
}

// reviewURL asks the local window to choose a page to review, opening it
// first when it is closed.
func (h *host) reviewURL() {
	h.mu.Lock()
	window := h.windows[proxy.Host]
	h.mu.Unlock()
	if window == nil {
		h.load(proxy.Origin + "/")
		return
	}
	window.Restore()
	window.Focus()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.page(window).EvalContext(ctx, `return window.dispatchEvent(new Event("zero:review-url", { cancelable: true }))`)
}
