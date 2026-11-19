// Package review is the pure part of screen comments in the desktop app
// (decisions 0175, 0176, 0177, 0180): the script guest pages run, the page
// facts and hit map it answers through Page.Eval, which are the page's word
// and so are validated and bounded here, the capture flow over any guest
// page (CaptureFrom), and the guest window's title. It knows no mygo: the
// main package drives windows.
package review

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
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

// Rect is a rectangle in CSS pixels from the viewport's top left.
type Rect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Bounds of a capture's hit map (decision 0180).
const (
	// MaxHitCells bounds the grid's cells; guest.js keeps to 20000.
	MaxHitCells = 1 << 15
	// MaxHitElements bounds the elements a hit map describes.
	MaxHitElements = 2000
	// maxHitsBytes bounds the page's answer before it is read.
	maxHitsBytes = 8 << 20
)

// Hits is a capture's hit map (decision 0180): what the page showed where,
// recorded in the same step as the page's facts and before the frame. Grid
// holds, row by row, the element (an index into Elements, -1 for none)
// topmost at the center of each Step-pixel cell, Columns × Rows covering
// the viewport. The page's word: validated and bounded, never trusted.
type Hits struct {
	Step     int          `json:"step"`
	Columns  int          `json:"columns"`
	Rows     int          `json:"rows"`
	Grid     []int        `json:"grid"`
	Elements []HitElement `json:"elements"`
}

// HitElement is one element of a hit map. Parent is the nearest ancestor
// the map holds, always earlier, or -1. Box is the part of its border box
// the page showed, cut to the viewport and to ancestors that clip it, in
// CSS pixels; nil when nothing showed. Meaningful marks an element a click
// inside it means: one with a role, input, replaced content, or a name the
// page gave it. The rest is decision 0176's element hint, present while
// the page had time to describe it: Tag "" and Selector "" mean it cannot
// be a hint.
type HitElement struct {
	Parent     int    `json:"parent"`
	Tag        string `json:"tag,omitempty"`
	Selector   string `json:"selector,omitempty"`
	Role       string `json:"role,omitempty"`
	Name       string `json:"name,omitempty"`
	Text       string `json:"text,omitempty"`
	Box        *Rect  `json:"box,omitempty"`
	Meaningful bool   `json:"meaningful,omitempty"`
}

var tagPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// ParseHits reads the hits of guest.js's capture() answer within viewport.
// A map whose shape is wrong (the grid's size, an index out of range, a
// parent that is not earlier, past the bounds) is no map: nil. Within a
// sound map each element's metadata is bounded as decision 0176 bounds a
// hint: a selector over 512 bytes or with control characters, a tag that is
// not lowercase letters, digits, and hyphens or longer than 32, and a role
// over 64 characters are dropped; name and text become one line of at most
// 256 characters. Boxes are clipped to the viewport and dropped when
// nothing is left.
func ParseHits(raw string, viewport Viewport) *Hits {
	if len(raw) > maxHitsBytes {
		return nil
	}
	var answer struct {
		Hits *struct {
			Step     int   `json:"step"`
			Columns  int   `json:"columns"`
			Rows     int   `json:"rows"`
			Grid     []int `json:"grid"`
			Elements []struct {
				Parent     int    `json:"parent"`
				Tag        string `json:"tag"`
				Selector   string `json:"selector"`
				Role       string `json:"role"`
				Name       string `json:"name"`
				Text       string `json:"text"`
				Meaningful bool   `json:"meaningful"`
				Box        *struct {
					X, Y, Width, Height float64
				} `json:"box"`
			} `json:"elements"`
		} `json:"hits"`
	}
	if err := json.Unmarshal([]byte(raw), &answer); err != nil || answer.Hits == nil {
		return nil
	}
	in := answer.Hits
	if in.Step < 1 || in.Step > MaxViewportSide || viewport.Width < 1 || viewport.Height < 1 ||
		in.Columns != (viewport.Width+in.Step-1)/in.Step || in.Rows != (viewport.Height+in.Step-1)/in.Step ||
		in.Columns*in.Rows > MaxHitCells || len(in.Grid) != in.Columns*in.Rows || len(in.Elements) > MaxHitElements {
		return nil
	}
	for _, cell := range in.Grid {
		if cell < -1 || cell >= len(in.Elements) {
			return nil
		}
	}
	hits := &Hits{Step: in.Step, Columns: in.Columns, Rows: in.Rows, Grid: in.Grid, Elements: make([]HitElement, len(in.Elements))}
	for index, element := range in.Elements {
		if element.Parent < -1 || element.Parent >= index {
			return nil
		}
		out := HitElement{Parent: element.Parent, Meaningful: element.Meaningful, Name: oneLine(element.Name, 256), Text: oneLine(element.Text, 256)}
		if len(element.Tag) <= 32 && tagPattern.MatchString(element.Tag) {
			out.Tag = element.Tag
		}
		if selector := element.Selector; len(selector) <= 512 && utf8.ValidString(selector) && strings.IndexFunc(selector, unicode.IsControl) < 0 {
			out.Selector = selector
		}
		if role := oneLine(element.Role, 1<<10); utf8.RuneCountInString(role) <= 64 {
			out.Role = role
		}
		if box := element.Box; box != nil && finite(box.X) && finite(box.Y) && finite(box.Width) && finite(box.Height) {
			left := math.Max(0, math.Floor(box.X))
			top := math.Max(0, math.Floor(box.Y))
			right := math.Min(float64(viewport.Width), math.Ceil(box.X+box.Width))
			bottom := math.Min(float64(viewport.Height), math.Ceil(box.Y+box.Height))
			if right-left >= 1 && bottom-top >= 1 {
				out.Box = &Rect{X: int(left), Y: int(top), Width: int(right - left), Height: int(bottom - top)}
			}
		}
		hits.Elements[index] = out
	}
	return hits
}

// Capture is one screen capture waiting for its comment: Project's guest
// page as a PNG of its whole frame, base64, the page it shows, and its hit
// map, nil when the page gave none that holds. Drift says the page's layout
// moved while it was captured, twice: the hit map may not match the pixels.
type Capture struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	PNG     string `json:"png"`
	Page    Page   `json:"page"`
	Hits    *Hits  `json:"hits,omitempty"`
	Drift   bool   `json:"drift,omitempty"`
}

// PageDriver is the guest page a capture reads: a review window's page, or
// any other surface that shows a guest page under guest.js (decision 0180).
// Eval runs code in the page and answers the string it returns.
type PageDriver interface {
	URL() string
	ZoomFactor() float64
	Eval(ctx context.Context, code string) (string, error)
	CapturePage() ([]byte, error)
}

// CaptureFrom captures page for a comment on project (decision 0180): the
// facts and hit map in one step, then the frame, then the layout's
// signature again. When the layout moved in between, it captures once
// more, and marks the capture Drift if it moved again. Call it before
// anything takes focus from the page, so menus and hovers stay as shown.
func CaptureFrom(ctx context.Context, page PageDriver, project string) (Capture, error) {
	var capture Capture
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := page.Eval(ctx, "return window.__zeroReview.capture()")
		if err != nil {
			return Capture{}, fmt.Errorf("read the page: %w", err)
		}
		facts, err := ParseFacts(raw, page.URL(), page.ZoomFactor())
		if err != nil {
			return Capture{}, err
		}
		frame, err := page.CapturePage()
		if err != nil {
			return Capture{}, fmt.Errorf("capture the page: %w", err)
		}
		var before struct {
			Signature string `json:"signature"`
		}
		_ = json.Unmarshal([]byte(raw), &before)
		after, err := page.Eval(ctx, "return window.__zeroReview.signature()")
		moved := err != nil || before.Signature == "" || after != before.Signature
		capture = Capture{Project: project, PNG: base64.StdEncoding.EncodeToString(frame), Page: facts, Hits: ParseHits(raw, facts.Viewport), Drift: moved}
		if !moved {
			break
		}
	}
	id := make([]byte, 6)
	_, _ = rand.Read(id)
	capture.ID = hex.EncodeToString(id)
	return capture, nil
}

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
