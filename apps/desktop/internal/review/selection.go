package review

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxViewportSide bounds a viewport side in CSS pixels.
const MaxViewportSide = 16384

// Bounds of what a comment carries of an element (decisions 0176, 0184);
// the server checks the same.
const (
	maxSelectorBytes = 512
	maxPathBytes     = 512
	maxSourceBytes   = 512
	maxClassesBytes  = 256
	maxComponent     = 256
	maxText          = 256
	maxRole          = 64
	maxAttributes    = 8
	maxStyles        = 24
	maxPairName      = 64
	maxAttribute     = 256
	maxStyle         = 128
	maxEventBytes    = 1 << 20
	// MaxPins bounds the pins a page shows.
	MaxPins = 200
)

// Rect is a rectangle in CSS pixels from the viewport's top left.
type Rect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Viewport is a page's layout viewport in CSS pixels. DeviceScaleFactor is
// the web view's zoom times the page's devicePixelRatio: frame pixels per
// CSS pixel.
type Viewport struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
}

// Scroll is a page's scroll position in CSS pixels.
type Scroll struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// Page is what a comment records of its page (decision 0176). URL is the
// web view's own word; the rest is the page's.
type Page struct {
	URL         string   `json:"url"`
	Title       string   `json:"title"`
	Viewport    Viewport `json:"viewport"`
	Scroll      Scroll   `json:"scroll"`
	ColorScheme string   `json:"colorScheme"`
}

// Pair is one attribute or computed style of an element.
type Pair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Element is the page's word on a picked element (decisions 0176, 0184):
// advisory, bounded here, never trusted. Box is the part the page showed,
// in CSS pixels of the viewport.
type Element struct {
	Tag          string `json:"tag"`
	Box          Rect   `json:"box"`
	Selector     string `json:"selector,omitempty"`
	Role         string `json:"role,omitempty"`
	Name         string `json:"name,omitempty"`
	Text         string `json:"text,omitempty"`
	Path         string `json:"path,omitempty"`
	Classes      string `json:"classes,omitempty"`
	Attributes   []Pair `json:"attributes,omitempty"`
	Styles       []Pair `json:"styles,omitempty"`
	Component    string `json:"component,omitempty"`
	Source       string `json:"source,omitempty"`
	Nearby       string `json:"nearby,omitempty"`
	SelectedText string `json:"selectedText,omitempty"`
}

// Selection kinds: an element the reviewer clicked, or a region they
// dragged.
const (
	KindElement = "element"
	KindRegion  = "region"
)

// Selection is one pick: its rectangle in CSS pixels of the viewport, the
// element (for a region, the one at its center, or none), and whether the
// reviewer can walk to its parent or back.
type Selection struct {
	Kind        string   `json:"kind"`
	Rect        Rect     `json:"rect"`
	Element     *Element `json:"element"`
	CanWalkUp   bool     `json:"canWalkUp"`
	CanWalkDown bool     `json:"canWalkDown"`
	Page        Page     `json:"page"`
}

// Capture is a pick waiting for its comment, as the composer's page reads
// it: the project it comments on, the guest's whole frame as a base64 PNG
// with nothing of the app's drawn on it, and the pick.
type Capture struct {
	Project string `json:"project"`
	PNG     string `json:"png"`
	Selection
}

// Event types guest.js answers to next().
const (
	EventPick     = "pick"     // the reviewer picked: Selection is set
	EventCancel   = "cancel"   // Escape while picking: comment mode ends
	EventEscape   = "escape"   // Escape while a pick is held: its comment is dropped
	EventFocus    = "focus"    // a press on the page while a pick is held
	EventPin      = "pin"      // a click on Thread's pin
	EventReplaced = "replaced" // another next() took this one's place
)

// Event is one answer of guest.js's next().
type Event struct {
	Type      string
	Thread    int
	Selection *Selection
}

var tagPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// ParseEvent reads an answer of guest.js's next() from the page at pageURL,
// shown at zoom.
func ParseEvent(raw, pageURL string, zoom float64) (Event, error) {
	if len(raw) > maxEventBytes {
		return Event{}, errors.New("read the page: its answer is too long")
	}
	var head struct {
		Type   string  `json:"type"`
		Thread float64 `json:"thread"`
	}
	if err := json.Unmarshal([]byte(raw), &head); err != nil {
		return Event{}, fmt.Errorf("read the page: %w", err)
	}
	switch head.Type {
	case EventCancel, EventEscape, EventFocus, EventReplaced:
		return Event{Type: head.Type}, nil
	case EventPin:
		thread, ok := whole(head.Thread, 1, 1e9)
		if !ok {
			return Event{}, errors.New("read the page: a pin without its thread")
		}
		return Event{Type: EventPin, Thread: thread}, nil
	case EventPick:
		selection, err := ParseSelection(raw, pageURL, zoom)
		if err != nil {
			return Event{}, err
		}
		return Event{Type: EventPick, Selection: &selection}, nil
	}
	return Event{}, errors.New("read the page: an answer of no known type")
}

// ParseSelection reads a pick as guest.js describes it. The rectangle and
// the element's box are cut to the viewport; text is one line and bounded;
// a part that does not hold is left out, never the whole pick unless its
// page or rectangle is no such thing.
func ParseSelection(raw, pageURL string, zoom float64) (Selection, error) {
	checked, ok := CheckURL(pageURL)
	if !ok || !strings.Contains(pageURL, "://") {
		return Selection{}, errors.New("only http and https pages can be commented on")
	}
	var answer struct {
		Kind        string   `json:"kind"`
		Rect        *box     `json:"rect"`
		CanWalkUp   bool     `json:"canWalkUp"`
		CanWalkDown bool     `json:"canWalkDown"`
		Element     *element `json:"element"`
		Page        *struct {
			Title            string  `json:"title"`
			Width            float64 `json:"width"`
			Height           float64 `json:"height"`
			DevicePixelRatio float64 `json:"devicePixelRatio"`
			ScrollX          float64 `json:"scrollX"`
			ScrollY          float64 `json:"scrollY"`
			ColorScheme      string  `json:"colorScheme"`
		} `json:"page"`
	}
	if err := json.Unmarshal([]byte(raw), &answer); err != nil {
		return Selection{}, fmt.Errorf("read the page: %w", err)
	}
	if answer.Page == nil || answer.Rect == nil || (answer.Kind != KindElement && answer.Kind != KindRegion) {
		return Selection{}, errors.New("read the page: its pick is incomplete")
	}
	facts := answer.Page
	width, okW := whole(facts.Width, 1, MaxViewportSide)
	height, okH := whole(facts.Height, 1, MaxViewportSide)
	scrollX, okX := whole(facts.ScrollX, -1e7, 1e7)
	scrollY, okY := whole(facts.ScrollY, -1e7, 1e7)
	if !okW || !okH || !okX || !okY || !finite(facts.DevicePixelRatio) || facts.DevicePixelRatio <= 0 || facts.DevicePixelRatio > 16 {
		return Selection{}, errors.New("read the page: its viewport or scroll is not a size")
	}
	if !finite(zoom) || zoom <= 0 || zoom > 16 {
		zoom = 1
	}
	viewport := Viewport{Width: width, Height: height, DeviceScaleFactor: math.Round(zoom*facts.DevicePixelRatio*1e4) / 1e4}
	rect, ok := answer.Rect.within(viewport)
	if !ok {
		return Selection{}, errors.New("read the page: its pick shows nothing")
	}
	scheme := "light"
	if facts.ColorScheme == "dark" {
		scheme = "dark"
	}
	selection := Selection{
		Kind:        answer.Kind,
		Rect:        rect,
		CanWalkUp:   answer.Kind == KindElement && answer.CanWalkUp,
		CanWalkDown: answer.Kind == KindElement && answer.CanWalkDown,
		Page:        Page{URL: checked, Title: oneLine(facts.Title, maxText), Viewport: viewport, Scroll: Scroll{X: scrollX, Y: scrollY}, ColorScheme: scheme},
	}
	if answer.Element != nil {
		selection.Element = answer.Element.bounded(viewport)
	}
	if selection.Kind == KindElement && selection.Element == nil {
		return Selection{}, errors.New("read the page: its pick names no element")
	}
	return selection, nil
}

type box struct {
	X, Y, Width, Height float64
}

// within cuts the box to the viewport; false when nothing is left.
func (b box) within(viewport Viewport) (Rect, bool) {
	if !finite(b.X) || !finite(b.Y) || !finite(b.Width) || !finite(b.Height) {
		return Rect{}, false
	}
	left := math.Max(0, math.Floor(b.X))
	top := math.Max(0, math.Floor(b.Y))
	right := math.Min(float64(viewport.Width), math.Ceil(b.X+b.Width))
	bottom := math.Min(float64(viewport.Height), math.Ceil(b.Y+b.Height))
	if right-left < 1 || bottom-top < 1 {
		return Rect{}, false
	}
	return Rect{X: int(left), Y: int(top), Width: int(right - left), Height: int(bottom - top)}, true
}

type element struct {
	Tag          string `json:"tag"`
	Box          *box   `json:"box"`
	Selector     string `json:"selector"`
	Role         string `json:"role"`
	Name         string `json:"name"`
	Text         string `json:"text"`
	Path         string `json:"path"`
	Classes      string `json:"classes"`
	Attributes   []Pair `json:"attributes"`
	Styles       []Pair `json:"styles"`
	Component    string `json:"component"`
	Source       string `json:"source"`
	Nearby       string `json:"nearby"`
	SelectedText string `json:"selectedText"`
}

// bounded is the element with every part checked; nil when its tag or box
// is none.
func (e element) bounded(viewport Viewport) *Element {
	if len(e.Tag) > 32 || !tagPattern.MatchString(e.Tag) || e.Box == nil {
		return nil
	}
	shown, ok := e.Box.within(viewport)
	if !ok {
		return nil
	}
	out := &Element{
		Tag:          e.Tag,
		Box:          shown,
		Selector:     plainBytes(e.Selector, maxSelectorBytes),
		Name:         oneLine(e.Name, maxText),
		Text:         oneLine(e.Text, maxText),
		Path:         lineBytes(e.Path, maxPathBytes),
		Classes:      lineBytes(e.Classes, maxClassesBytes),
		Attributes:   pairs(e.Attributes, maxAttributes, maxAttribute),
		Styles:       pairs(e.Styles, maxStyles, maxStyle),
		Component:    oneLine(e.Component, maxComponent),
		Source:       lineBytes(e.Source, maxSourceBytes),
		Nearby:       oneLine(e.Nearby, maxText),
		SelectedText: oneLine(e.SelectedText, maxText),
	}
	if role := oneLine(e.Role, 1<<10); utf8.RuneCountInString(role) <= maxRole {
		out.Role = role
	}
	return out
}

// pairNamePattern is an attribute or CSS property name.
var pairNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// pairs keeps at most limit well-named pairs, each value one line of at
// most valueLimit characters; never "value", whatever the page says.
func pairs(in []Pair, limit, valueLimit int) []Pair {
	var out []Pair
	for _, pair := range in {
		if len(out) >= limit {
			break
		}
		if len(pair.Name) > maxPairName || !pairNamePattern.MatchString(pair.Name) || pair.Name == "value" {
			continue
		}
		out = append(out, Pair{Name: pair.Name, Value: oneLine(pair.Value, valueLimit)})
	}
	return out
}

// plainBytes is text kept whole when it is valid, has no control
// characters, and fits limit bytes; "" otherwise. A selector cut short
// would find something else.
func plainBytes(text string, limit int) string {
	if len(text) > limit || !utf8.ValidString(text) || strings.IndexFunc(text, unicode.IsControl) >= 0 {
		return ""
	}
	return text
}

// lineBytes is text as one line of at most limit bytes, cut at a
// character.
func lineBytes(text string, limit int) string {
	line := oneLine(text, limit)
	for len(line) > limit {
		_, size := utf8.DecodeLastRuneInString(line)
		line = line[:len(line)-size]
	}
	return strings.TrimSpace(line)
}

// whole rounds a finite value within [low, high].
func whole(value, low, high float64) (int, bool) {
	if !finite(value) || value < low || value > high {
		return 0, false
	}
	return int(math.Round(value)), true
}

// Pin is one earlier comment's mark on the page: its thread's number,
// whether it is resolved, and where it goes: on the element Selector finds,
// or without one at X, Y in CSS pixels of the document.
type Pin struct {
	Thread   int    `json:"thread"`
	Resolved bool   `json:"resolved"`
	Selector string `json:"selector,omitempty"`
	X        int    `json:"x"`
	Y        int    `json:"y"`
}

// Composer sizes, in CSS pixels of the app's page.
const (
	ComposerWidth      = 360
	ComposerHeight     = 196
	minComposerHeight  = 120
	maxComposerHeight  = 480
	composerGap        = 8
	composerEdgeMargin = 8
)

// ComposerHeightOf bounds the height the composer's page asks for.
func ComposerHeightOf(height float64) float64 {
	if !finite(height) {
		return ComposerHeight
	}
	return math.Max(minComposerHeight, math.Min(maxComposerHeight, math.Ceil(height)))
}

// PlaceComposer puts the composer beside a pick: under it, left edges
// aligned, else over it, else where it fits; always inside the window and,
// while the guest is wide enough, inside the guest's frame. rect is the
// pick in CSS pixels of the guest's viewport, guestZoom the guest's zoom,
// guest its frame; size is the composer's in CSS pixels of the app's page,
// which appZoom scales; the window's content is width by height.
func PlaceComposer(rect Rect, guestZoom float64, guest Frame, composerHeight, appZoom float64, width, height int) Frame {
	if !finite(guestZoom) || guestZoom <= 0 {
		guestZoom = 1
	}
	if !finite(appZoom) || appZoom <= 0 {
		appZoom = 1
	}
	w := math.Min(ComposerWidth*appZoom, float64(width)-2*composerEdgeMargin)
	h := math.Min(composerHeight*appZoom, float64(height)-2*composerEdgeMargin)
	left := float64(guest.X) + float64(rect.X)*guestZoom
	top := float64(guest.Y) + float64(rect.Y)*guestZoom
	bottom := top + float64(rect.Height)*guestZoom

	lowX, highX := float64(composerEdgeMargin), float64(width)-w-composerEdgeMargin
	if float64(guest.Width) >= w+2*composerEdgeMargin {
		lowX = math.Max(lowX, float64(guest.X)+composerEdgeMargin)
		highX = math.Min(highX, float64(guest.X)+float64(guest.Width)-w-composerEdgeMargin)
	}
	x := math.Max(lowX, math.Min(left, highX))

	lowY, highY := float64(composerEdgeMargin), float64(height)-h-composerEdgeMargin
	y := bottom + composerGap
	if y > highY {
		y = top - composerGap - h
	}
	if y < lowY {
		y = math.Max(lowY, math.Min(bottom+composerGap, highY))
	}
	return Frame{X: float32(math.Round(x)), Y: float32(math.Round(y)), Width: float32(math.Round(w)), Height: float32(math.Round(h))}
}
