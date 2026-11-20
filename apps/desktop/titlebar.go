package main

import (
	"log"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// titleBar is the room a window's controls take, in the CSS pixels of
// Zero's page: what mygo's --mygo-titlebar-* variables say in a page
// window (decision 0185).
type titleBar struct {
	Height float64 `json:"height"`
	Left   float64 `json:"left"`
	Right  float64 `json:"right"`
}

// titleBarEvent tells Zero's page in a window of native UI the room of the
// window's controls. mygo tells only a page window's page; the preload
// writes the same variables from it, so the page's title band draws in
// both kinds of window (decision 0185).
var titleBarEvent = mygo.NewEvent[titleBar]("zero:title-bar")

// titleBarCSS is room, in window points, in the CSS pixels of a page at
// zoom, as mygo converts it for a page window.
func titleBarCSS(room ui.TitleBar, zoom float64) titleBar {
	if zoom <= 0 {
		zoom = 1
	}
	return titleBar{
		Height: float64(room.Height) / zoom,
		Left:   float64(room.Left) / zoom,
		Right:  float64(room.Right) / zoom,
	}
}

// noteTitleBar keeps the room the view sees and tells Zero's page when it
// changed: on the first frame, and entering or leaving full screen. Main
// thread only, from the view.
func (s *shell) noteTitleBar(room ui.TitleBar) {
	if !s.hidesTitleBar {
		return
	}
	s.mu.Lock()
	changed := s.room != room
	s.room = room
	s.mu.Unlock()
	if changed {
		go s.sendTitleBar()
	}
}

// sendTitleBar tells Zero's page the room of the window's controls at the
// page's zoom: after a change, a load of the page, or a zoom. Not on the
// main thread: it reads the page's zoom.
func (s *shell) sendTitleBar() {
	if !s.hidesTitleBar {
		return
	}
	zero := s.zeroView()
	if zero == nil {
		return
	}
	s.mu.Lock()
	room := s.room
	s.mu.Unlock()
	page := zero.Page()
	if err := titleBarEvent.EmitPage(page, titleBarCSS(room, page.ZoomFactor())); err != nil {
		log.Printf("zero-app: %v", err)
	}
}
