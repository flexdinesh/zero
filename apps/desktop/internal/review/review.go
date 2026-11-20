// Package review is the pure part of the Browser view in the desktop app
// (decisions 0175, 0184): the script guest pages run, which addresses a
// guest may show, where a guest goes in its window, and its load failures.
// It knows no mygo: the main package drives web views.
package review

import (
	_ "embed"
	"math"
	"net/url"
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

// Frame is where a guest shows in its window, in the window's layout
// units from its content's top left.
type Frame struct {
	X, Y, Width, Height float32
}

// minFrameSide is the least side a guest shows with.
const minFrameSide = 16

// Place turns the rectangle the app's page reports, in CSS pixels of its
// viewport, into the guest's frame in a window whose content is width by
// height: scaled by the page's zoom and cut to the window. ok is false when
// too little of it would show.
func Place(x, y, w, h, zoom float64, width, height int) (Frame, bool) {
	if !finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0 {
		return Frame{}, false
	}
	if !finite(zoom) || zoom <= 0 || zoom > 16 {
		zoom = 1
	}
	left := math.Max(0, math.Round(x*zoom))
	top := math.Max(0, math.Round(y*zoom))
	right := math.Min(float64(width), math.Round((x+w)*zoom))
	bottom := math.Min(float64(height), math.Round((y+h)*zoom))
	if right-left < minFrameSide || bottom-top < minFrameSide {
		return Frame{}, false
	}
	return Frame{X: float32(left), Y: float32(top), Width: float32(right - left), Height: float32(bottom - top)}, true
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
