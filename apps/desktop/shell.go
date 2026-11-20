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
// Browser tab that shows goes over the rectangle the page reports. mygo
// allows web views only in such windows, and stacks them in the order the
// view builds them.
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
}

func newShell() *shell { return &shell{guests: map[string]*guest{}} }

// view builds the window's content: the app's page, filling it, and over
// it the guest that shows.
func (s *shell) view(c *ui.Context) {
	s.mu.Lock()
	zero, at := s.zero, s.at
	var shown *mygo.WebView
	if guest := s.guests[s.shown]; guest != nil {
		shown = guest.view
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
	s.mu.Unlock()
	if hidden {
		s.window.Invalidate()
	}
	return removed
}

// place shows the project's guest at at, in place of any other.
func (s *shell) place(project string, at review.Frame) {
	s.mu.Lock()
	shown := s.guests[project]
	if shown == nil {
		s.mu.Unlock()
		return
	}
	appeared := s.shown != project
	s.shown, s.at = project, at
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
	s.guests, s.recent, s.shown = map[string]*guest{}, nil, ""
	s.mu.Unlock()
	for _, each := range guests {
		each.stop()
	}
}
