package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
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

// Screen comments (decisions 0175, 0176, 0177). A project's guest window
// shows a page of the developer's app as an untrusted page: it calls nothing
// of the app's, and the app reads it only through Page.Eval and
// window.__zeroReview, which guest.js defines before the page's own scripts.
// Comment on Screen captures the frame and the page's facts and hands them
// to Zero's local window, whose composer asks for an element hint while the
// page still shows what was captured. Nothing is drawn over the page, and the
// page never sees the comment.

// captureCountdown is how long Comment on Screen in 3 Seconds waits.
const captureCountdown = 3

// keptCaptures bounds the captures screenElement can still ask about.
const keptCaptures = 4

// reviews holds the guest windows, one per project, and the screen captures
// waiting for their comments.
type reviews struct {
	host *host

	mu       sync.Mutex
	sessions map[string]*reviewSession
	// pending is the capture the local window has not taken yet; captures
	// are the latest few, by ID, for element hints.
	pending  *review.Capture
	captures []capturedScreen
}

// capturedScreen is a capture and the guest window it came from.
type capturedScreen struct {
	capture review.Capture
	session *reviewSession
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
		kept := r.captures[:0]
		for _, screen := range r.captures {
			if screen.session != session {
				kept = append(kept, screen)
			}
		}
		r.captures = kept
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

// element asks the guest page of capture id for the element at a point in
// CSS pixels, while it still shows what was captured; nil otherwise.
func (r *reviews) element(ctx context.Context, request bridge.ScreenElement) *review.Element {
	r.mu.Lock()
	var screen *capturedScreen
	for index := range r.captures {
		if r.captures[index].capture.ID == request.ID {
			found := r.captures[index]
			screen = &found
		}
	}
	r.mu.Unlock()
	if screen == nil || screen.session.ctx.Err() != nil {
		return nil
	}
	captured := screen.capture.Page
	if request.X >= float64(captured.Viewport.Width) || request.Y >= float64(captured.Viewport.Height) {
		return nil
	}
	now, err := screen.session.facts(ctx)
	if err != nil || !review.SameView(captured, now) {
		return nil
	}
	code := "return window.__zeroReview.elementAt(" + strconv.FormatFloat(request.X, 'f', -1, 64) + ", " + strconv.FormatFloat(request.Y, 'f', -1, 64) + ")"
	raw, err := screen.session.evalString(ctx, code, 5*time.Second)
	if err != nil {
		return nil
	}
	element, ok := review.ParseElement(raw, captured.Viewport)
	if !ok {
		return nil
	}
	return element
}

// evalString runs code in the guest page, bounded by timeout, and answers
// the string it returns.
func (s *reviewSession) evalString(ctx context.Context, code string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	value, err := s.window.Page().EvalContext(ctx, code)
	if err != nil {
		return "", err
	}
	text, ok := value.(string)
	if !ok {
		return "", errors.New("the page answered something else")
	}
	return text, nil
}

// facts reads what a capture records of the page now.
func (s *reviewSession) facts(ctx context.Context) (review.Page, error) {
	raw, err := s.evalString(ctx, "return window.__zeroReview.facts()", 5*time.Second)
	if err != nil {
		return review.Page{}, err
	}
	page := s.window.Page()
	return review.ParseFacts(raw, page.URL(), page.ZoomFactor())
}

// capture takes the guest page's frame and facts and hands them to the
// local window's composer.
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
	page, err := s.facts(s.ctx)
	if err != nil {
		s.reviews.host.report("Could not capture the page", err.Error())
		return
	}
	frame, err := s.window.CapturePage()
	if err != nil {
		s.reviews.host.report("Could not capture the page", err.Error())
		return
	}
	id := make([]byte, 6)
	_, _ = rand.Read(id)
	capture := review.Capture{ID: hex.EncodeToString(id), Project: s.project, PNG: base64.StdEncoding.EncodeToString(frame), Page: page}
	r := s.reviews
	r.mu.Lock()
	r.pending = &capture
	r.captures = append(r.captures, capturedScreen{capture: capture, session: s})
	if len(r.captures) > keptCaptures {
		r.captures = r.captures[len(r.captures)-keptCaptures:]
	}
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
