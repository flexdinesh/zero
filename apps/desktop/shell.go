package main

import (
	"sync"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// shell is a connection's window with experimental features on (decision
// 0184): a window of native UI whose view places web views, where a page
// window can hold only its page. Zero's page fills it. mygo allows web views
// only in such windows, and stacks them in the order the view builds them.
type shell struct {
	mu sync.Mutex
	// zero is the web view of the app's page, nil until the window has made
	// it.
	zero *mygo.WebView
}

// view builds the window's content: the app's page, filling it.
func (s *shell) view(c *ui.Context) {
	zero := s.zeroView()
	if zero == nil {
		return
	}
	ui.WebView(c, zero).Fill()
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
