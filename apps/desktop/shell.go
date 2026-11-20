package main

import (
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/flexdinesh/zero/apps/desktop/internal/review"
)

// maxGuests bounds the guests a window keeps: each is a web process. Past
// it, the one shown longest ago closes.
const maxGuests = 8

// nudgeDelay is how long a guest that just appeared stays a pixel narrow.
// A web view shown again at another size keeps its old size until its next
// change (mygo v0.7.4, Linux), so appearing is two sizes.
const nudgeDelay = 50 * time.Millisecond

// shell is a connection's window with experimental features on (decision
// 0184): a window of native UI whose view places web views, where a page
// window can hold only its page. Zero's page fills it; the guest of the
// Browser tab that shows goes over the rectangle the page reports, and the
// composer over the guest, beside the pick it comments on. mygo allows web
// views only in such windows, and stacks them in the order the view builds
// them.
type shell struct {
	window *mygo.Window
	// opening serializes making a project's guest.
	opening sync.Mutex

	mu sync.Mutex
	// zero is the web view of the app's page, nil until the window has made
	// it.
	zero *mygo.WebView
	// guests are the window's guest pages by project; recent orders them,
	// the one shown last at the end.
	guests map[string]*guest
	recent []string
	// shown is the project whose guest shows at at, "" when none does.
	shown string
	at    review.Frame
	// nudged narrows the shown guest by a pixel; appearances counts them, so
	// only the last one's timer widens it again.
	nudged      bool
	appearances int
	// focusing is the project whose guest takes the keyboard when it shows.
	focusing string
	// layout is the window's content size and the zoom of the app's page,
	// as of the last frame the page reported: where the composer fits.
	layout layout
	// composer is the web view of the composer's page, nil until the first
	// pick; composing is the pick that waits for its comment, nil for none.
	composer  *mygo.WebView
	composing *composition
}

// layout is what placing the composer needs of the window.
type layout struct {
	width, height int
	zoom          float64
}

// composition is a pick waiting for its comment: the guest it was made in,
// at guestZoom, what the composer's page reads, and the height the page
// asked for, in its CSS pixels.
type composition struct {
	guest     *guest
	guestZoom float64
	capture   review.Capture
	height    float64
}

func newShell() *shell { return &shell{guests: map[string]*guest{}} }

// view builds the window's content: the app's page, filling it, and over
// it the guest that shows.
func (s *shell) view(c *ui.Context) {
	s.mu.Lock()
	zero, at := s.zero, s.at
	var shown, composer *mygo.WebView
	var composerAt review.Frame
	if guest := s.guests[s.shown]; guest != nil {
		shown = guest.view
		// The composer shows only over the guest its pick was made in.
		if composing := s.composing; composing != nil && composing.guest == guest && s.composer != nil && s.layout.width > 0 {
			composer = s.composer
			composerAt = review.PlaceComposer(composing.capture.Rect, composing.guestZoom, at, composing.height, s.layout.zoom, s.layout.width, s.layout.height)
		}
		if s.nudged {
			at.Width--
		}
	}
	s.mu.Unlock()
	if zero == nil {
		return
	}
	ui.WebView(c, zero).Fill().Children(func() {
		if shown != nil {
			ui.WebView(c, shown).Absolute().Left(at.X).Top(at.Y).Width(at.Width).Height(at.Height)
		}
		if composer != nil {
			ui.WebView(c, composer).Absolute().Left(composerAt.X).Top(composerAt.Y).Width(composerAt.Width).Height(composerAt.Height)
		}
	})
}

func (s *shell) zeroView() *mygo.WebView {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.zero
}

func (s *shell) setZero(zero *mygo.WebView) {
	s.mu.Lock()
	s.zero = zero
	s.mu.Unlock()
}

// guest finds the project's guest, nil when it has none.
func (s *shell) guest(project string) *guest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.guests[project]
}

// shownGuest is the guest that shows, nil when none does.
func (s *shell) shownGuest() *guest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.guests[s.shown]
}

// add keeps a project's new guest and answers the guest that leaves to make
// room, if any: the one shown longest ago that does not show now.
func (s *shell) add(added *guest) *guest {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.guests[added.project] = added
	s.recent = append(s.recent, added.project)
	if len(s.guests) <= maxGuests {
		return nil
	}
	for index, project := range s.recent {
		if project == s.shown || project == added.project {
			continue
		}
		evicted := s.guests[project]
		delete(s.guests, project)
		s.recent = append(s.recent[:index], s.recent[index+1:]...)
		return evicted
	}
	return nil
}

// remove forgets the project's guest and answers it, nil when it had none.
func (s *shell) remove(project string) *guest {
	s.mu.Lock()
	removed := s.guests[project]
	delete(s.guests, project)
	for index, each := range s.recent {
		if each == project {
			s.recent = append(s.recent[:index], s.recent[index+1:]...)
			break
		}
	}
	hidden := s.shown == project
	if hidden {
		s.shown = ""
	}
	if s.focusing == project {
		s.focusing = ""
	}
	if s.composing != nil && s.composing.guest == removed {
		s.composing = nil
	}
	s.mu.Unlock()
	if hidden {
		s.window.Invalidate()
	}
	return removed
}

// place shows the project's guest at at, in place of any other, in a window
// laid out as window.
func (s *shell) place(project string, at review.Frame, window layout) {
	s.mu.Lock()
	shown := s.guests[project]
	if shown == nil {
		s.mu.Unlock()
		return
	}
	appeared := s.shown != project
	s.shown, s.at, s.layout = project, at, window
	appearance := s.appearances
	if appeared {
		s.nudged = true
		s.appearances++
		appearance = s.appearances
		for index, each := range s.recent {
			if each == project {
				s.recent = append(append(s.recent[:index], s.recent[index+1:]...), project)
				break
			}
		}
	}
	focus := s.focusing == project && !appeared
	if focus {
		s.focusing = ""
	}
	s.mu.Unlock()
	s.window.Invalidate()
	if focus {
		shown.view.Focus()
	}
	if !appeared {
		return
	}
	time.AfterFunc(nudgeDelay, func() {
		s.mu.Lock()
		current := s.appearances == appearance && s.shown == project
		focus := current && s.focusing == project
		if current {
			s.nudged = false
		}
		if focus {
			s.focusing = ""
		}
		s.mu.Unlock()
		if !current {
			return
		}
		s.window.Invalidate()
		if focus {
			shown.view.Focus()
		}
	})
}

// hide stops showing the project's guest; its page stays. An empty project
// hides whichever shows.
func (s *shell) hide(project string) {
	s.mu.Lock()
	hidden := s.shown != "" && (project == "" || s.shown == project)
	if hidden {
		s.shown = ""
	}
	s.mu.Unlock()
	if hidden {
		s.window.Invalidate()
	}
}

// focusWhenShown gives the project's guest the keyboard: now when it shows,
// else when it next does.
func (s *shell) focusWhenShown(project string) {
	s.mu.Lock()
	shown := s.guests[project]
	now := shown != nil && s.shown == project && !s.nudged
	if !now {
		s.focusing = project
	}
	s.mu.Unlock()
	if now {
		shown.view.Focus()
	}
}

// close ends the window's guests; their web views close with the window.
func (s *shell) close() {
	s.mu.Lock()
	guests := s.guests
	s.guests, s.recent, s.shown, s.composing = map[string]*guest{}, nil, "", nil
	s.mu.Unlock()
	for _, each := range guests {
		each.stop()
	}
}

// composerView is the web view of the composer's page, nil before the
// first pick.
func (s *shell) composerView() *mygo.WebView {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.composer
}

// compose shows the composer for a pick; a pick that waited is replaced.
func (s *shell) compose(composing *composition) {
	s.mu.Lock()
	s.composing = composing
	s.mu.Unlock()
	s.window.Invalidate()
}

// capture answers a copy of what the waiting pick's composer reads.
func (s *shell) capture() *review.Capture {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.composing == nil {
		return nil
	}
	capture := s.composing.capture
	return &capture
}

// composed is the pick waiting for its comment, nil for none.
func (s *shell) composed() *composition {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.composing
}

// recompose changes the pick that waits, when it is still expected: the
// composer moves or grows with it.
func (s *shell) recompose(expected *composition, change func(*composition)) bool {
	s.mu.Lock()
	current := s.composing == expected && expected != nil
	if current {
		change(s.composing)
	}
	s.mu.Unlock()
	if current {
		s.window.Invalidate()
	}
	return current
}

// endComposing hides the composer and answers the pick that waited, nil
// for none. With of set, only that guest's pick ends.
func (s *shell) endComposing(of *guest) *composition {
	s.mu.Lock()
	ended := s.composing
	if ended == nil || (of != nil && ended.guest != of) {
		s.mu.Unlock()
		return nil
	}
	s.composing = nil
	s.mu.Unlock()
	s.window.Invalidate()
	return ended
}
