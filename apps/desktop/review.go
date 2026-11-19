package main

import (
	"context"
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

// captureCountdown is how long Comment on Screen in 3 Seconds waits.
const captureCountdown = 3

// reviews holds the guest windows, one per project, and the screen capture
// waiting for its comment.
type reviews struct {
	host *host

	mu       sync.Mutex
	sessions map[string]*reviewSession
	// pending is the capture the local window has not taken yet.
	pending *review.Capture
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
}

func newReviews(h *host) *reviews {
	return &reviews{host: h, sessions: map[string]*reviewSession{}}
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
	page.OnWillNavigate(func(event *mygo.NavigateEvent) {
		if !review.AllowsNavigation(event.URL) {
			event.PreventDefault()
		}
	})
	page.SetWindowOpenHandler(func(open mygo.WindowOpenRequest) *mygo.WindowOptions {
		if target, ok := review.CheckURL(open.URL); ok {
			go func() { _ = mygo.Shell.OpenExternal(target) }()
		}
		return nil
	})
	page.OnDidNavigate(func(string) { session.showTitle() })
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
	})
	if err := page.LoadURL(request.URL); err != nil {
		r.host.report("Could not open the page", err.Error())
	}
	go session.readBranch()
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
