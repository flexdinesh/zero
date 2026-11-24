package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/egoist/mygo"

	"github.com/flexdinesh/zero/apps/desktop/internal/bridge"
	"github.com/flexdinesh/zero/apps/desktop/internal/proxy"
	"github.com/flexdinesh/zero/apps/desktop/internal/review"
)

// Comments on a guest's page (decision 0184). In comment mode guest.js
// swallows the page's input and answers the element or region the reviewer
// picks, with nothing of the app's drawn; the app takes the frame, has
// guest.js outline the pick, and shows the composer beside it. The composer
// is a page of the app's in a web view of its own: the guest can neither
// read the comment nor send one. It reads the pick (composerCapture), walks
// it (composerWalk), sizes itself (composerResize), and ends it
// (composerClose). Earlier comments show on the page as pins guest.js
// draws; a click on one reaches the Browser tab as zero:browser-pin.

// composerPath is the composer's page on a connection's origin.
const composerPath = "/composer"

// guestCallTimeout bounds a call of guest.js that answers at once.
const guestCallTimeout = 5 * time.Second

// listen answers guest.js's events for as long as the guest lives: each
// next() resolves with one. A page that is loading, failed, or gone
// answers nothing; the wait starts again when a page loads.
func (g *guest) listen() {
	for g.ctx.Err() == nil {
		ctx, cancel := context.WithCancel(g.ctx)
		g.mu.Lock()
		g.interrupt = cancel
		g.mu.Unlock()
		raw, err := g.eval(ctx, "return window.__zeroBrowser.next()")
		cancel()
		if err != nil {
			select {
			case <-g.ctx.Done():
				return
			case <-g.loaded:
			case <-time.After(2 * time.Second):
			}
			continue
		}
		page := g.view.Page()
		event, err := review.ParseEvent(raw, page.URL(), page.ZoomFactor())
		if err != nil {
			// A pick the page described badly is no pick: back to picking.
			g.call("window.__zeroBrowser.resume()")
			continue
		}
		g.handle(event)
	}
}

// pageLoaded wakes listen for the new page, and gives it the pins.
func (g *guest) pageLoaded() {
	select {
	case g.loaded <- struct{}{}:
	default:
	}
	g.sendPins()
}

// navigated ends what belonged to the page that left: its pending answer,
// comment mode, and a pick waiting for its comment.
func (g *guest) navigated() {
	g.mu.Lock()
	interrupt := g.interrupt
	g.commenting = false
	g.mu.Unlock()
	if interrupt != nil {
		interrupt()
	}
	g.host.endComposing(g.frame, g, false)
}

// eval runs code in the guest's page and answers the string it returns.
func (g *guest) eval(ctx context.Context, code string) (string, error) {
	value, err := g.view.Page().EvalContext(ctx, code)
	if err != nil {
		return "", err
	}
	text, ok := value.(string)
	if !ok {
		return "", errors.New("the page answered something else")
	}
	return text, nil
}

// call runs a call of guest.js that answers at once, and reports whether it
// answered true.
func (g *guest) call(code string) bool {
	ctx, cancel := context.WithTimeout(g.ctx, guestCallTimeout)
	defer cancel()
	value, err := g.view.Page().EvalContext(ctx, "return "+code)
	return err == nil && value == true
}

// handle does what one of guest.js's events asks.
func (g *guest) handle(event review.Event) {
	switch event.Type {
	case review.EventPick:
		g.picked(*event.Selection)
	case review.EventCancel:
		g.setCommenting(false)
	case review.EventEscape:
		g.host.endComposing(g.frame, g, false)
	case review.EventFocus:
		if composer := g.frame.composerView(); composer != nil && g.frame.composed() != nil {
			composer.Focus()
		}
	case review.EventPin:
		g.host.tell(g.window, "zero:browser-pin", map[string]any{"project": g.key.project, "thread": event.Thread})
	}
}

// setCommenting turns comment mode on or off, and gives the page the
// keyboard: Escape and Alt+Up are its keys there.
func (g *guest) setCommenting(on bool) {
	if !on {
		g.host.endComposing(g.frame, g, false)
	}
	done := g.call("window.__zeroBrowser.comment(" + strconv.FormatBool(on) + ")")
	g.mu.Lock()
	g.commenting = on && done
	g.mu.Unlock()
	if on && done {
		g.view.Focus()
		// The composer's page loads now, to be ready for the first pick.
		go func() { _, _ = g.host.composer(g.window, g.frame) }()
	}
	g.host.browserChanged(g.window, g.key.project)
}

func (g *guest) isCommenting() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.commenting
}

// picked takes the frame of a pick guest.js holds, with nothing of the
// app's on it, and shows the composer beside it.
func (g *guest) picked(selection review.Selection) {
	if !g.isCommenting() {
		g.call("window.__zeroBrowser.resume()")
		return
	}
	png, err := g.view.CapturePage()
	if err != nil || len(png) == 0 {
		g.call("window.__zeroBrowser.resume()")
		g.host.report("Could not capture the page", errorText(err, "the page gave no frame"))
		return
	}
	composer, err := g.host.composer(g.window, g.frame)
	if err != nil {
		g.call("window.__zeroBrowser.resume()")
		g.host.report("Could not open the composer", err.Error())
		return
	}
	g.call("window.__zeroBrowser.mark()")
	g.frame.compose(&composition{
		guest:     g,
		guestZoom: g.view.Page().ZoomFactor(),
		capture:   review.Capture{Project: g.key.project, PNG: base64.StdEncoding.EncodeToString(png), Selection: selection},
		height:    review.ComposerHeight,
	})
	composer.Focus()
	go g.host.tellPage(composer.Page(), "zero:composer", nil)
	g.host.browserChanged(g.window, g.key.project)
}

func errorText(err error, fallback string) string {
	if err != nil {
		return err.Error()
	}
	return fallback
}

// sendPins gives the page the pins the Browser tab last sent.
func (g *guest) sendPins() {
	g.mu.Lock()
	pins, visible := g.pins, g.pinsVisible
	g.mu.Unlock()
	if pins == nil {
		pins = []review.Pin{}
	}
	encoded, err := json.Marshal(pins)
	if err != nil {
		return
	}
	g.call("window.__zeroBrowser.pins(" + strconv.Quote(string(encoded)) + ", " + strconv.FormatBool(visible) + ")")
}

// browserPins takes the pins of the tab's page from window's Browser tab;
// the guest shows them again after each load.
func (h *host) browserPins(window *mygo.Window, request bridge.BrowserPins) {
	frame := h.shellOf(window)
	if frame == nil {
		return
	}
	found := frame.guest(guestKey{project: request.Project, tab: request.Tab})
	if found == nil {
		return
	}
	found.mu.Lock()
	found.pins, found.pinsVisible = request.Pins, request.Visible
	found.mu.Unlock()
	found.sendPins()
}

// composer is the window's composer web view, made on the first pick: the
// app's page at composerPath on the window's connection, with the app's
// bridge and nowhere else to go.
func (h *host) composer(window *mygo.Window, frame *shell) (*mygo.WebView, error) {
	frame.opening.Lock()
	defer frame.opening.Unlock()
	if made := frame.composerView(); made != nil {
		return made, nil
	}
	app := h.page(window)
	if app == nil {
		return nil, errors.New("the window closed")
	}
	connectionHost := hostOf(app.URL())
	target := proxy.OriginOf(connectionHost) + composerPath
	made, err := window.NewWebView(mygo.WebViewOptions{
		URL:             target,
		Page:            mygo.PageOptions{PreloadScript: preloadScript(h.experimental())},
		BackgroundColor: h.looks.Get(connectionHost).WindowBackground(),
	})
	if err != nil {
		return nil, err
	}
	page := made.Page()
	page.SetZoomFactor(app.ZoomFactor())
	page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	page.OnWillNavigate(func(event *mygo.NavigateEvent) {
		if event.URL != target {
			event.PreventDefault()
		}
	})
	page.SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
	// A composer that crashed loads again, and its pick is dropped: the
	// reviewer picks again.
	page.OnRenderProcessGone(func(string) {
		h.endComposing(frame, nil, false)
		_ = page.LoadURL(target)
	})
	frame.mu.Lock()
	frame.composer = made
	frame.mu.Unlock()
	return made, nil
}

// endComposing ends the pick waiting for its comment in a window: the
// composer hides and the page goes back to picking. With of set, only that
// guest's pick ends. sent tells the Browser tab a comment was made.
func (h *host) endComposing(frame *shell, of *guest, sent bool) {
	ended := frame.endComposing(of)
	if ended == nil {
		return
	}
	picking := ended.guest
	if picking.ctx.Err() == nil {
		picking.call("window.__zeroBrowser.resume()")
		if picking.isCommenting() && frame.shownGuest() == picking {
			picking.view.Focus()
		}
	}
	if composer := frame.composerView(); composer != nil {
		go h.tellPage(composer.Page(), "zero:composer", nil)
	}
	if sent {
		h.tell(picking.window, "zero:browser-commented", picking.key.project)
	}
	h.browserChanged(picking.window, picking.key.project)
}

// composerCapture answers the pick waiting for the composer in window, nil
// for none.
func (h *host) composerCapture(window *mygo.Window) *review.Capture {
	frame := h.shellOf(window)
	if frame == nil {
		return nil
	}
	return frame.capture()
}

// composerWalk moves the waiting pick to its parent or back and answers it,
// nil when no pick waits or the page gave none.
func (h *host) composerWalk(window *mygo.Window, direction string) *review.Capture {
	frame := h.shellOf(window)
	if frame == nil {
		return nil
	}
	composing := frame.composed()
	if composing == nil {
		return nil
	}
	picking := composing.guest
	ctx, cancel := context.WithTimeout(picking.ctx, guestCallTimeout)
	defer cancel()
	raw, err := picking.eval(ctx, "return window.__zeroBrowser.walk("+strconv.Quote(direction)+")")
	if err != nil {
		return nil
	}
	page := picking.view.Page()
	selection, err := review.ParseSelection(raw, page.URL(), page.ZoomFactor())
	if err != nil {
		return nil
	}
	var walked *review.Capture
	frame.recompose(composing, func(current *composition) {
		// The frame stays: the page has not moved since the pick.
		current.capture.Selection = selection
		capture := current.capture
		walked = &capture
	})
	return walked
}

// composerResize gives the composer the height its page asks for.
func (h *host) composerResize(window *mygo.Window, height float64) {
	if frame := h.shellOf(window); frame != nil {
		frame.recompose(frame.composed(), func(current *composition) { current.height = review.ComposerHeightOf(height) })
	}
}

// isComposer reports the page of a window's composer.
func (h *host) isComposer(page *mygo.Page) bool {
	if page == nil {
		return false
	}
	view := page.WebView()
	if view == nil {
		return false
	}
	frame := h.shellOf(view.Window())
	return frame != nil && frame.composerView() == view
}

// tellPage dispatches a CustomEvent with detail to a page.
func (h *host) tellPage(page *mygo.Page, event string, detail any) {
	if page == nil {
		return
	}
	name, _ := json.Marshal(event)
	encoded, err := json.Marshal(detail)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = page.EvalContext(ctx, `return window.dispatchEvent(new CustomEvent(`+string(name)+`, { detail: `+string(encoded)+` }))`)
}
