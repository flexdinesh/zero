package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/flexdinesh/zero/apps/desktop/internal/bridge"
	"github.com/flexdinesh/zero/apps/desktop/internal/review"
)

// The Browser view (decision 0184). A project's guest is a page of anyone's,
// shown in an untrusted web view over the rectangle the window's Browser
// tab reports: it calls nothing of the app's, and the app reads it only
// through Page.Eval and guest.js, which runs before the page's own scripts.
// The tab drives it: browserOpen makes it and loads a page, browserState
// reads the page and its load failures, browserAction moves it,
// browserFrame places or hides it, browserSnapshot answers its frame, and
// zero:browser tells the tab when its state changed.

// browserDelay coalesces a guest's bursts of changes into one zero:browser
// event.
const browserDelay = 100 * time.Millisecond

// guest is one project's page in a window.
type guest struct {
	host    *host
	window  *mygo.Window
	project string
	view    *mygo.WebView
	// ctx ends when the guest closes.
	ctx  context.Context
	stop context.CancelFunc

	mu sync.Mutex
	// browsing follows the page's load events for the Browser tab.
	browsing review.Browsing
}

// browserNews holds the guests with a zero:browser event on its way.
type browserNews struct {
	mu         sync.Mutex
	announcing map[browserTopic]bool
}

type browserTopic struct {
	window  *mygo.Window
	project string
}

// browserOpen shows pageURL in the project's guest in window, making the
// guest when the project has none. The guest takes the keyboard once it
// shows.
func (h *host) browserOpen(window *mygo.Window, request bridge.BrowserOpen) {
	frame := h.shellOf(window)
	if frame == nil {
		return
	}
	frame.opening.Lock()
	opened := frame.guest(request.Project)
	if opened == nil {
		var err error
		if opened, err = h.newGuest(window, frame, request.Project); err != nil {
			frame.opening.Unlock()
			h.report("Could not open the page", err.Error())
			return
		}
	}
	frame.opening.Unlock()
	frame.focusWhenShown(request.Project)
	opened.record((*review.Browsing).Start)
	if err := opened.view.Page().LoadURL(request.URL); err != nil {
		h.report("Could not open the page", err.Error())
	}
}

// newGuest makes a project's guest in window: untrusted, in the session of
// the window's connection, under 0175's navigation policy. It loads nothing
// yet.
func (h *host) newGuest(window *mygo.Window, frame *shell, project string) (*guest, error) {
	app := h.page(window)
	if app == nil {
		return nil, errors.New("the window closed")
	}
	connectionHost := hostOf(app.URL())
	view, err := window.NewWebView(mygo.WebViewOptions{
		Page: mygo.PageOptions{Untrusted: true, PreloadScript: review.Guest, Session: mygo.NewSession("browser-" + connectionHost)},
	})
	if err != nil {
		return nil, err
	}
	ctx, stop := context.WithCancel(context.Background())
	made := &guest{host: h, window: window, project: project, view: view, ctx: ctx, stop: stop}
	page := view.Page()
	page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	// OnWillNavigate sees what the page asks for, never LoadURL or history
	// moves: those start through act or browserOpen.
	page.OnWillNavigate(func(event *mygo.NavigateEvent) {
		if !review.AllowsNavigation(event.URL) {
			event.PreventDefault()
			made.record(func(browsing *review.Browsing) { browsing.Refuse(event.URL) })
			return
		}
		made.record((*review.Browsing).Start)
	})
	// Certificates that do not verify are refused, as in a browser; the
	// Browser tab says why.
	page.SetCertificateErrorHandler(func(failure mygo.CertificateError) bool {
		made.record(func(browsing *review.Browsing) { browsing.Certificate(failure.URL, failure.Error) })
		return false
	})
	page.OnDidFailLoad(func(failure *mygo.LoadError) {
		made.record(func(browsing *review.Browsing) { browsing.Fail(failure.URL, failure.Description) })
	})
	page.OnRenderProcessGone(func(reason string) {
		shown := page.URL()
		made.record(func(browsing *review.Browsing) { browsing.Crash(shown, reason) })
	})
	page.OnDidFinishLoad(func() { h.browserChanged(window, project) })
	page.SetWindowOpenHandler(func(open mygo.WindowOpenRequest) *mygo.WindowOptions {
		if target, ok := review.CheckURL(open.URL); ok {
			go func() { _ = mygo.Shell.OpenExternal(target) }()
		}
		return nil
	})
	// A new page has no title until it says one.
	page.OnDidNavigate(func(string) {
		made.record(func(browsing *review.Browsing) { browsing.Title("") })
	})
	// The window's title is the app's; the tab shows the page's.
	page.OnPageTitleUpdated(func(event *mygo.TitleEvent) {
		event.PreventDefault()
		made.record(func(browsing *review.Browsing) { browsing.Title(event.Title) })
	})
	if evicted := frame.add(made); evicted != nil {
		evicted.close()
	}
	return made, nil
}

// close ends the guest and its web view, and tells its tab.
func (g *guest) close() {
	g.stop()
	g.view.Destroy()
	g.host.browserChanged(g.window, g.project)
}

// record applies a load event to the guest's state and tells the Browser
// tab.
func (g *guest) record(event func(*review.Browsing)) {
	g.mu.Lock()
	event(&g.browsing)
	g.mu.Unlock()
	g.host.browserChanged(g.window, g.project)
}

// state is what the Browser tab shows of the guest, read from its page now.
func (g *guest) state() *review.BrowserState {
	page := g.view.Page()
	shown, loading, back, forward := page.URL(), page.IsLoading(), page.CanGoBack(), page.CanGoForward()
	if g.ctx.Err() != nil {
		return nil
	}
	g.mu.Lock()
	state := g.browsing.State(shown, loading, back, forward)
	g.mu.Unlock()
	return &state
}

// act does a browser action. History moves and reloads start a navigation
// OnWillNavigate never sees, so they clear the failure themselves.
func (g *guest) act(action string) {
	page := g.view.Page()
	switch action {
	case bridge.BrowserBack:
		if page.CanGoBack() {
			g.record((*review.Browsing).Start)
			page.GoBack()
		}
	case bridge.BrowserForward:
		if page.CanGoForward() {
			g.record((*review.Browsing).Start)
			page.GoForward()
		}
	case bridge.BrowserReload:
		g.record((*review.Browsing).Start)
		page.Reload()
	case bridge.BrowserStop:
		page.Stop()
		g.host.browserChanged(g.window, g.project)
	}
}

// browserState answers the project's guest in window, nil when it has none.
func (h *host) browserState(window *mygo.Window, project string) *review.BrowserState {
	if frame := h.shellOf(window); frame != nil {
		if found := frame.guest(project); found != nil {
			return found.state()
		}
	}
	return nil
}

// browserAct does a Browser tab action to the project's guest in window;
// nothing when it has none.
func (h *host) browserAct(window *mygo.Window, request bridge.BrowserAction) {
	frame := h.shellOf(window)
	if frame == nil {
		return
	}
	if request.Action == bridge.BrowserClose {
		if closed := frame.remove(request.Project); closed != nil {
			closed.close()
		}
		return
	}
	if found := frame.guest(request.Project); found != nil {
		found.act(request.Action)
	}
}

// browserFrame shows the project's guest where the window's page says its
// Browser tab is, or hides it.
func (h *host) browserFrame(window *mygo.Window, request bridge.BrowserFrame) {
	frame := h.shellOf(window)
	if frame == nil {
		return
	}
	if !request.Shown {
		frame.hide(request.Project)
		return
	}
	app := h.page(window)
	if app == nil {
		return
	}
	width, height := window.ContentSize()
	at, ok := review.Place(request.X, request.Y, request.Width, request.Height, app.ZoomFactor(), width, height)
	if !ok {
		frame.hide(request.Project)
		return
	}
	frame.place(request.Project, at)
}

// browserSnapshot answers the frame the project's guest shows now as a
// base64 PNG, nil when it has no guest or no frame.
func (h *host) browserSnapshot(window *mygo.Window, project string) *string {
	frame := h.shellOf(window)
	if frame == nil {
		return nil
	}
	found := frame.guest(project)
	if found == nil {
		return nil
	}
	png, err := found.view.CapturePage()
	if err != nil || len(png) == 0 {
		return nil
	}
	encoded := base64.StdEncoding.EncodeToString(png)
	return &encoded
}

// browserChanged tells window's page that the project's guest changed:
// once, browserDelay after the first change of a burst, so it reads the
// last.
func (h *host) browserChanged(window *mygo.Window, project string) {
	topic := browserTopic{window: window, project: project}
	h.browsers.mu.Lock()
	defer h.browsers.mu.Unlock()
	if h.browsers.announcing[topic] {
		return
	}
	h.browsers.announcing[topic] = true
	time.AfterFunc(browserDelay, func() {
		h.browsers.mu.Lock()
		delete(h.browsers.announcing, topic)
		h.browsers.mu.Unlock()
		h.tell(window, "zero:browser", project)
	})
}

// browserCommand asks window's page to do what the Browser menu names, for
// the project whose guest shows there, null when none does. The app's page
// takes the keyboard first: the guest may have it.
func (h *host) browserCommand(window *mygo.Window, command string) {
	frame := h.shellOf(window)
	if frame == nil {
		return
	}
	var project *string
	if shown := frame.shownGuest(); shown != nil {
		project = &shown.project
	}
	if zero := frame.zeroView(); zero != nil {
		zero.Focus()
	}
	h.tell(window, "zero:browser-command", map[string]any{"project": project, "command": command})
}

// reloadShown reloads what the window's user looks at: the guest that
// shows, else the app's page.
func (h *host) reloadShown(window *mygo.Window, ignoreCache bool) {
	if frame := h.shellOf(window); frame != nil {
		if shown := frame.shownGuest(); shown != nil {
			shown.act(bridge.BrowserReload)
			return
		}
	}
	app := h.page(window)
	if app == nil {
		return
	}
	if ignoreCache {
		app.ReloadIgnoringCache()
		return
	}
	app.Reload()
}

// isAppPage reports a page of the app's own: a page window's, or the web
// view of the app's page in a window of native UI. A guest's is not, and the
// proxy refuses it.
func (h *host) isAppPage(page *mygo.Page) bool {
	if page == nil {
		return false
	}
	view := page.WebView()
	if view == nil {
		return true
	}
	frame := h.shellOf(view.Window())
	return frame != nil && frame.zeroView() == view
}

// tell dispatches a CustomEvent with detail to window's page of the app.
func (h *host) tell(window *mygo.Window, event string, detail any) {
	name, _ := json.Marshal(event)
	encoded, err := json.Marshal(detail)
	if err != nil {
		return
	}
	app := h.page(window)
	if app == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = app.EvalContext(ctx, `return window.dispatchEvent(new CustomEvent(`+string(name)+`, { detail: `+string(encoded)+` }))`)
}
