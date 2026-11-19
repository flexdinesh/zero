package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/flexdinesh/zero/apps/desktop/internal/bridge"
	"github.com/flexdinesh/zero/apps/desktop/internal/proxy"
	"github.com/flexdinesh/zero/apps/desktop/internal/review"
	"github.com/flexdinesh/zero/pkg/client"
	"github.com/flexdinesh/zero/pkg/contract"
)

// Screen comments (decisions 0175, 0176, 0177, 0180). A project's guest
// window shows a page of the developer's app as an untrusted page: it calls
// nothing of the app's, and the app reads it only through Page.Eval and
// window.__zeroReview, which guest.js defines before the page's own scripts.
// Comment on Screen captures the page's facts, its hit map, and the frame
// while the page still has focus, and hands them to Zero's local window,
// whose composer selects against that hit map. Nothing is drawn over the
// page, and the page never sees the comment.
//
// The local window's Browser tab (decision 0181) drives each project's guest
// window: browserState reads its page and load failures, browserAction moves
// it, and zero:browser tells the tab when either changed.

// captureCountdown is how long Comment on Screen in 3 Seconds waits.
const captureCountdown = 3

// browserDelay coalesces a guest window's bursts of changes into one
// zero:browser event per project.
const browserDelay = 100 * time.Millisecond

// reviews holds the guest windows, one per project, and the screen capture
// waiting for its comment.
type reviews struct {
	host *host

	mu       sync.Mutex
	sessions map[string]*reviewSession
	// pending is the capture the local window has not taken yet.
	pending *review.Capture
	// announcing holds the projects with a zero:browser event on its way.
	announcing map[string]bool
}

// reviewSession is one project's guest window.
type reviewSession struct {
	reviews *reviews
	project string
	window  *mygo.Window
	ctx     context.Context
	stop    context.CancelFunc

	mu sync.Mutex
	// branch is the one the title names, "" until read; known says it was.
	branch string
	known  bool
	// capturing serializes captures and countdowns.
	capturing bool
	// browsing follows the page's load events for the Browser tab.
	browsing review.Browsing
}

func newReviews(h *host) *reviews {
	return &reviews{host: h, sessions: map[string]*reviewSession{}, announcing: map[string]bool{}}
}

// open shows pageURL in the project's guest window, opening one when the
// project has none.
func (r *reviews) open(request bridge.OpenReview) {
	r.mu.Lock()
	session := r.sessions[request.Project]
	r.mu.Unlock()
	if session != nil {
		session.window.Restore()
		session.window.Focus()
		session.record((*review.Browsing).Start)
		if err := session.window.Page().LoadURL(request.URL); err != nil {
			r.host.report("Could not open the page", err.Error())
		}
		return
	}
	ctx, stop := context.WithCancel(context.Background())
	session = &reviewSession{reviews: r, project: request.Project, ctx: ctx, stop: stop}
	// A guest window (decision 0175): untrusted, in its own session, with its
	// own menu and policy. It loads nothing until it is registered, so the
	// proxy knows its page before the page asks.
	window := mygo.NewWindow(mygo.WindowOptions{
		Title:          review.Title(request.URL, request.Project, ""),
		Width:          1280,
		Height:         800,
		UseContentSize: true,
		MinWidth:       320,
		MinHeight:      240,
		Page:           mygo.PageOptions{Untrusted: true, PreloadScript: review.Guest, Session: reviewBrowsing()},
	})
	session.window = window
	r.mu.Lock()
	r.sessions[request.Project] = session
	r.mu.Unlock()
	window.SetMenu(r.host.reviewWindowMenu())
	page := window.Page()
	page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	// OnWillNavigate sees what the page asks for, never LoadURL or history
	// moves: those start through session.act or open.
	page.OnWillNavigate(func(event *mygo.NavigateEvent) {
		if !review.AllowsNavigation(event.URL) {
			event.PreventDefault()
			session.record(func(browsing *review.Browsing) { browsing.Refuse(event.URL) })
			return
		}
		session.record((*review.Browsing).Start)
	})
	// Certificates that do not verify are refused, as in a browser; the
	// Browser tab says why.
	page.SetCertificateErrorHandler(func(failure mygo.CertificateError) bool {
		session.record(func(browsing *review.Browsing) { browsing.Certificate(failure.URL, failure.Error) })
		return false
	})
	page.OnDidFailLoad(func(failure *mygo.LoadError) {
		session.record(func(browsing *review.Browsing) { browsing.Fail(failure.URL, failure.Description) })
	})
	page.OnRenderProcessGone(func(reason string) {
		shown := page.URL()
		session.record(func(browsing *review.Browsing) { browsing.Crash(shown, reason) })
	})
	page.OnDidFinishLoad(func() { r.changed(request.Project) })
	page.SetWindowOpenHandler(func(open mygo.WindowOpenRequest) *mygo.WindowOptions {
		if target, ok := review.CheckURL(open.URL); ok {
			go func() { _ = mygo.Shell.OpenExternal(target) }()
		}
		return nil
	})
	page.OnDidNavigate(func(string) {
		session.showTitle()
		r.changed(request.Project)
	})
	// The title names the page, the project, and the branch, not the page's
	// <title>.
	page.OnPageTitleUpdated(func(event *mygo.TitleEvent) { event.PreventDefault() })
	window.OnFocus(func() { go session.readBranch() })
	window.OnClosed(func() {
		stop()
		r.mu.Lock()
		if r.sessions[request.Project] == session {
			delete(r.sessions, request.Project)
		}
		r.mu.Unlock()
		r.changed(request.Project)
	})
	session.record((*review.Browsing).Start)
	if err := page.LoadURL(request.URL); err != nil {
		r.host.report("Could not open the page", err.Error())
	}
	go session.readBranch()
}

// record applies a load event to the session's state and tells the Browser
// tab.
func (s *reviewSession) record(event func(*review.Browsing)) {
	s.mu.Lock()
	event(&s.browsing)
	s.mu.Unlock()
	s.reviews.changed(s.project)
}

// changed tells the local window that the project's guest window changed:
// once, browserDelay after the first change of a burst, so it reads the
// last.
func (r *reviews) changed(project string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.announcing[project] {
		return
	}
	r.announcing[project] = true
	time.AfterFunc(browserDelay, func() {
		r.mu.Lock()
		delete(r.announcing, project)
		r.mu.Unlock()
		r.host.tellLocal("zero:browser", project)
	})
}

// session finds the project's guest window.
func (r *reviews) session(project string) *reviewSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[project]
}

// state answers what the Browser tab shows of the project's guest window,
// read from its page now; nil when it has none.
func (r *reviews) state(project string) *review.BrowserState {
	session := r.session(project)
	if session == nil {
		return nil
	}
	page := session.window.Page()
	shown, loading, back, forward := page.URL(), page.IsLoading(), page.CanGoBack(), page.CanGoForward()
	if session.ctx.Err() != nil {
		return nil
	}
	session.mu.Lock()
	state := session.browsing.State(shown, loading, back, forward)
	session.mu.Unlock()
	return &state
}

// act does a Browser tab action to the project's guest window; nothing when
// it has none.
func (r *reviews) act(request bridge.BrowserAction) {
	if session := r.session(request.Project); session != nil {
		session.act(request.Action)
	}
}

// actOn does an action to a guest window, from its menu.
func (r *reviews) actOn(window *mygo.Window, action string) {
	if session, ok := r.sessionOf(window); ok {
		session.act(action)
	}
}

// act does a browser action. History moves and reloads start a navigation
// OnWillNavigate never sees, so they clear the failure themselves.
func (s *reviewSession) act(action string) {
	page := s.window.Page()
	switch action {
	case bridge.BrowserBack:
		if page.CanGoBack() {
			s.record((*review.Browsing).Start)
			page.GoBack()
		}
	case bridge.BrowserForward:
		if page.CanGoForward() {
			s.record((*review.Browsing).Start)
			page.GoForward()
		}
	case bridge.BrowserReload:
		s.record((*review.Browsing).Start)
		page.Reload()
	case bridge.BrowserStop:
		page.Stop()
		s.reviews.changed(s.project)
	case bridge.BrowserShow:
		s.window.Restore()
		s.window.Focus()
	case bridge.BrowserClose:
		s.window.Close()
	case bridge.BrowserComment:
		s.reviews.comment(s.window, false)
	case bridge.BrowserCommentDelayed:
		s.reviews.comment(s.window, true)
	}
}

// openLocation is the guest window's Open Location…: the local window comes
// forward and its Browser tab takes the keyboard, in its address field.
func (r *reviews) openLocation(window *mygo.Window) {
	if session, ok := r.sessionOf(window); ok {
		r.host.focusBrowser(session.project)
	}
}

// reviewBrowsing is the session guest windows share: the developer's app
// keeps its sign-in from one review to the next, apart from Zero's pages.
var reviewBrowsing = sync.OnceValue(func() *mygo.Session { return mygo.NewSession("review") })

// isGuestPage reports a page of a guest window, which the proxy refuses.
func (r *reviews) isGuestPage(page *mygo.Page) bool {
	if page == nil {
		return false
	}
	return r.isReview(page.Window())
}

// sessionOf finds the session of a guest window.
func (r *reviews) sessionOf(window *mygo.Window) (*reviewSession, bool) {
	if window == nil {
		return nil, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, session := range r.sessions {
		if session.window == window {
			return session, true
		}
	}
	return nil, false
}

// isReview reports a guest window.
func (r *reviews) isReview(window *mygo.Window) bool {
	_, ok := r.sessionOf(window)
	return ok
}

// comment captures a guest window's page for a comment: F8. With delay it
// counts down first, in the title, for menus that close when a key is
// pressed.
func (r *reviews) comment(window *mygo.Window, delay bool) {
	if session, ok := r.sessionOf(window); ok {
		go session.capture(delay)
	}
}

// takeCapture answers the capture the local window has not taken yet, once.
func (r *reviews) takeCapture() *review.Capture {
	r.mu.Lock()
	defer r.mu.Unlock()
	capture := r.pending
	r.pending = nil
	return capture
}

// guestPage is a review window's page as review.CaptureFrom reads it; its
// evaluations end with the window.
type guestPage struct{ session *reviewSession }

func (g guestPage) URL() string                  { return g.session.window.Page().URL() }
func (g guestPage) ZoomFactor() float64          { return g.session.window.Page().ZoomFactor() }
func (g guestPage) CapturePage() ([]byte, error) { return g.session.window.CapturePage() }

// Eval runs code in the guest page, for at most 5 seconds, and answers the
// string it returns.
func (g guestPage) Eval(ctx context.Context, code string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	stop := context.AfterFunc(g.session.ctx, cancel)
	defer stop()
	value, err := g.session.window.Page().EvalContext(ctx, code)
	if err != nil {
		return "", err
	}
	text, ok := value.(string)
	if !ok {
		return "", errors.New("the page answered something else")
	}
	return text, nil
}

// capture takes the guest page's facts, hit map, and frame and hands them
// to the local window's composer.
func (s *reviewSession) capture(delay bool) {
	s.mu.Lock()
	if s.capturing {
		s.mu.Unlock()
		return
	}
	s.capturing = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.capturing = false
		s.mu.Unlock()
		s.showTitle()
	}()
	if delay {
		for left := captureCountdown; left > 0; left-- {
			s.window.SetTitle("Capturing in " + strconv.Itoa(left) + "…")
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(time.Second):
			}
		}
		s.showTitle()
	}
	// The page keeps focus until the capture is taken: menus and hovers
	// that close on blur stay in both the hit map and the frame.
	capture, err := review.CaptureFrom(s.ctx, guestPage{session: s}, s.project)
	if err != nil {
		s.reviews.host.report("Could not capture the page", err.Error())
		return
	}
	r := s.reviews
	r.mu.Lock()
	r.pending = &capture
	r.mu.Unlock()
	r.host.showScreenComment(s.project)
}

// readBranch reads the branch new threads join, for the title.
func (s *reviewSession) readBranch() {
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	var branch string
	err := s.reviews.host.daemon.Do(ctx, func(daemon client.Client) error {
		feedback, err := daemon.Feedback(ctx, contract.FeedbackRequest{Project: s.project})
		branch = feedback.Branch
		return err
	})
	if err != nil {
		return
	}
	s.mu.Lock()
	changed := !s.known || s.branch != branch
	s.branch, s.known = branch, true
	capturing := s.capturing
	s.mu.Unlock()
	if changed && !capturing {
		s.showTitle()
	}
}

func (s *reviewSession) showTitle() {
	s.mu.Lock()
	branch := s.branch
	s.mu.Unlock()
	s.window.SetTitle(review.Title(s.window.Page().URL(), s.project, branch))
}

// focusBrowser brings the local window forward and tells its page to focus
// the project's Browser tab; a window it opens shows that tab.
func (h *host) focusBrowser(project string) {
	h.mu.Lock()
	window := h.windows[proxy.Host]
	h.mu.Unlock()
	if window == nil {
		// A window that opens now shows the project's Browser tab; Ctrl/Cmd+L
		// there takes the address.
		h.load(proxy.Origin + "/view?" + url.Values{"project": {project}, "browser": {"1"}}.Encode())
		return
	}
	window.Restore()
	window.Focus()
	h.tellLocal("zero:browser-focus", project)
}

// tellLocal dispatches a CustomEvent whose detail is project to the local
// window's page, when there is one; it never opens one.
func (h *host) tellLocal(event, project string) {
	h.mu.Lock()
	window := h.windows[proxy.Host]
	h.mu.Unlock()
	if window == nil {
		return
	}
	name, _ := json.Marshal(event)
	detail, _ := json.Marshal(project)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = window.Page().EvalContext(ctx, `return window.dispatchEvent(new CustomEvent(`+string(name)+`, { detail: `+string(detail)+` }))`)
}

// showScreenComment brings the local window forward and tells its page a
// capture waits; a window it opens takes the capture once it loads.
func (h *host) showScreenComment(project string) {
	h.mu.Lock()
	window := h.windows[proxy.Host]
	h.mu.Unlock()
	if window == nil {
		h.load(proxy.Origin + "/?" + url.Values{"project": {project}}.Encode())
		return
	}
	window.Restore()
	window.Focus()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = window.Page().EvalContext(ctx, `return window.dispatchEvent(new CustomEvent("zero:screen-comment"))`)
}
