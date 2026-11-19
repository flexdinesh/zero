// Package review is the pure part of screen comments in the desktop app
// (decisions 0175, 0176, 0177): the script guest pages run, the page facts
// and element hints it answers through Page.Eval, which are the page's word
// and so are validated and bounded here, and the guest window's title. It
// knows no mygo: the main package drives windows.
package review

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Guest is the script every guest page runs before its own (guest.js).
//
//go:embed guest.js
var Guest string

// CheckURL accepts an absolute http or https URL with a host, answering its
// canonical form; a bare host:port takes http.
func CheckURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 || strings.ContainsAny(raw, " \t\r\n") {
		return "", false
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return "", false
	}
	return parsed.String(), true
}

// AllowsNavigation reports a navigation a guest window lets its page make
// (decision 0175): http and https, and the about:blank, about:srcdoc,
// data:, and blob: documents of frames, which Linux reports as the main
// frame's. zero-app:, zero:, file:, and every other scheme stay out.
func AllowsNavigation(raw string) bool {
	if _, ok := CheckURL(raw); ok && strings.Contains(raw, "://") {
		return true
	}
	lower := strings.ToLower(strings.TrimSpace(raw))
	return lower == "about:blank" || lower == "about:srcdoc" || strings.HasPrefix(lower, "data:") || strings.HasPrefix(lower, "blob:http://") || strings.HasPrefix(lower, "blob:https://")
}

// Title is a guest window's title: the page's URL without its scheme, the
// project's folder name, and the branch new threads join ("detached HEAD"
// without one).
func Title(pageURL, project, branch string) string {
	shown := pageURL
	if parsed, err := url.Parse(pageURL); err == nil && parsed.Host != "" {
		shown = parsed.Host + parsed.EscapedPath()
		if parsed.RawQuery != "" {
			shown += "?" + parsed.RawQuery
		}
	}
	if branch == "" {
		branch = "detached HEAD"
	}
	return shown + " · " + path.Base(strings.TrimRight(project, "/")) + " · " + branch
}

// MaxViewportSide bounds a viewport side in CSS pixels.
const MaxViewportSide = 16384

// Viewport is a page's layout viewport in CSS pixels. DeviceScaleFactor is
// the guest's zoom factor times devicePixelRatio (decision 0175): the
// capture is round(Width × it) by round(Height × it).
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

// Page is what a screen capture records of its page (decision 0176). URL is
// the window's, never the page's word.
type Page struct {
	URL      string   `json:"url"`
	Title    string   `json:"title"`
	Viewport Viewport `json:"viewport"`
	Scroll   Scroll   `json:"scroll"`
}

// ParseFacts reads guest.js's facts() answer for the page at pageURL, shown
// at zoom: the title (one line, at most 256 characters), the viewport, and
// the scroll. A page that is not http or https cannot be commented on.
func ParseFacts(raw, pageURL string, zoom float64) (Page, error) {
	checked, ok := CheckURL(pageURL)
	if !ok || !strings.Contains(pageURL, "://") {
		return Page{}, errors.New("only http and https pages can be commented on")
	}
	var facts struct {
		Title            string  `json:"title"`
		Width            float64 `json:"width"`
		Height           float64 `json:"height"`
		DevicePixelRatio float64 `json:"devicePixelRatio"`
		ScrollX          float64 `json:"scrollX"`
		ScrollY          float64 `json:"scrollY"`
	}
	if err := json.Unmarshal([]byte(raw), &facts); err != nil {
		return Page{}, fmt.Errorf("read the page: %w", err)
	}
	width, okW := whole(facts.Width, 1, MaxViewportSide)
	height, okH := whole(facts.Height, 1, MaxViewportSide)
	scrollX, okX := whole(facts.ScrollX, -1e7, 1e7)
	scrollY, okY := whole(facts.ScrollY, -1e7, 1e7)
	if !okW || !okH || !okX || !okY || !finite(facts.DevicePixelRatio) || facts.DevicePixelRatio <= 0 || facts.DevicePixelRatio > 16 {
		return Page{}, errors.New("read the page: its viewport or scroll is not a size")
	}
	if !finite(zoom) || zoom <= 0 || zoom > 16 {
		zoom = 1
	}
	return Page{
		URL:      checked,
		Title:    oneLine(facts.Title, 256),
		Viewport: Viewport{Width: width, Height: height, DeviceScaleFactor: math.Round(zoom*facts.DevicePixelRatio*1e4) / 1e4},
		Scroll:   Scroll{X: scrollX, Y: scrollY},
	}, nil
}

// SameView reports whether a page still shows what a capture recorded: the
// same URL, viewport size, and scroll.
func SameView(captured, now Page) bool {
	return captured.URL == now.URL && captured.Scroll == now.Scroll &&
		captured.Viewport.Width == now.Viewport.Width && captured.Viewport.Height == now.Viewport.Height
}

// Rect is a rectangle in CSS pixels from the viewport's top left.
type Rect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Element is the page's word on the element at a point (decision 0176):
// advisory, bounded, never trusted. Box is its border box clipped to the
// viewport, in CSS pixels.
type Element struct {
	Selector string `json:"selector"`
	Tag      string `json:"tag"`
	Role     string `json:"role,omitempty"`
	Name     string `json:"name,omitempty"`
	Text     string `json:"text,omitempty"`
	Box      *Rect  `json:"box,omitempty"`
}

var tagPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// ParseElement reads guest.js's elementAt() answer within viewport: null,
// or an element with a selector of at most 512 bytes and a lowercase tag of
// at most 32. Role (at most 64), name, and text (at most 256 characters)
// become one line; a role past its bound is dropped, a name or text cut.
// The box is clipped to the viewport and dropped when nothing is left. An
// element that breaks the selector or tag rules is no element.
func ParseElement(raw string, viewport Viewport) (*Element, bool) {
	if strings.TrimSpace(raw) == "null" {
		return nil, true
	}
	var element struct {
		Selector string `json:"selector"`
		Tag      string `json:"tag"`
		Role     string `json:"role"`
		Name     string `json:"name"`
		Text     string `json:"text"`
		Box      *struct {
			X, Y, Width, Height float64
		} `json:"box"`
	}
	if err := json.Unmarshal([]byte(raw), &element); err != nil {
		return nil, false
	}
	if element.Selector == "" || len(element.Selector) > 512 || !utf8.ValidString(element.Selector) || strings.IndexFunc(element.Selector, unicode.IsControl) >= 0 ||
		len(element.Tag) > 32 || !tagPattern.MatchString(element.Tag) {
		return nil, false
	}
	parsed := &Element{Selector: element.Selector, Tag: element.Tag, Name: oneLine(element.Name, 256), Text: oneLine(element.Text, 256)}
	if role := oneLine(element.Role, 1<<10); utf8.RuneCountInString(role) <= 64 {
		parsed.Role = role
	}
	if box := element.Box; box != nil && finite(box.X) && finite(box.Y) && finite(box.Width) && finite(box.Height) {
		left := math.Max(0, math.Round(box.X))
		top := math.Max(0, math.Round(box.Y))
		right := math.Min(float64(viewport.Width), math.Round(box.X+box.Width))
		bottom := math.Min(float64(viewport.Height), math.Round(box.Y+box.Height))
		if right-left >= 1 && bottom-top >= 1 {
			parsed.Box = &Rect{X: int(left), Y: int(top), Width: int(right - left), Height: int(bottom - top)}
		}
	}
	return parsed, true
}

// Capture is one screen capture waiting for its comment: Project's guest
// page as a PNG of its whole frame, base64, and the page it shows.
type Capture struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	PNG     string `json:"png"`
	Page    Page   `json:"page"`
}

var captureID = regexp.MustCompile(`^[0-9a-f]{12}$`)

// IsCaptureID reports a capture ID: twelve lowercase hex digits.
func IsCaptureID(id string) bool { return captureID.MatchString(id) }

// oneLine collapses whitespace and control characters to single spaces and
// cuts the result to limit characters.
func oneLine(text string, limit int) string {
	text = strings.ToValidUTF8(text, "")
	fields := strings.FieldsFunc(text, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	line := strings.Join(fields, " ")
	if utf8.RuneCountInString(line) <= limit {
		return line
	}
	runes := []rune(line)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

// whole rounds a finite value within [low, high].
func whole(value, low, high float64) (int, bool) {
	if !finite(value) || value < low || value > high {
		return 0, false
	}
	return int(math.Round(value)), true
}
