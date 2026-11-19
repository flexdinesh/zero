package feedback

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Visual targets (decision 0176) point a thread at pixels instead of lines:
// one screenshot attachment, one rectangle on it in image pixels, and
// optionally the page it was captured from and the page's own word on the
// element there. They never re-anchor.

// Visual target bounds (decision 0176).
const (
	// MaxURLBytes bounds a page URL after normalization.
	MaxURLBytes = 2048
	// MaxTitleLength bounds a page title, in characters.
	MaxTitleLength = 256
	// MaxSelectorBytes bounds an element's selector.
	MaxSelectorBytes = 512
	// MaxTagBytes bounds an element's tag name.
	MaxTagBytes = 32
	// MaxRoleLength bounds an element's role, in characters.
	MaxRoleLength = 64
	// MaxElementTextLength bounds an element's name and text, in characters.
	MaxElementTextLength = 256
)

// Localhost values say what a loopback page URL refers to: the project's
// host or the reviewer's machine.
const (
	LocalhostProject = "project"
	LocalhostViewer  = "viewer"
)

// Rect is a rectangle of whole pixels from a top-left origin.
type Rect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

func (r Rect) String() string { return fmt.Sprintf("%d,%d %d×%d", r.X, r.Y, r.Width, r.Height) }

// Viewport is a page's layout viewport in CSS pixels and its device scale
// factor (zoom times devicePixelRatio).
type Viewport struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
}

// Frame is the captured frame's size in pixels: the viewport times its
// scale factor, rounded.
func (v Viewport) Frame() (width, height int) {
	return int(math.Round(float64(v.Width) * v.DeviceScaleFactor)), int(math.Round(float64(v.Height) * v.DeviceScaleFactor))
}

// Scroll is a page's scroll position in CSS pixels.
type Scroll struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// Page is the page a screenshot was captured from. URL is normalized and
// redacted; Clip, in frame pixels, is the part of the frame kept as the
// image (nil for the whole frame). Localhost is the server's, absent for a
// URL whose host is not loopback.
type Page struct {
	URL       string   `json:"url"`
	Title     string   `json:"title,omitempty"`
	Viewport  Viewport `json:"viewport"`
	Scroll    Scroll   `json:"scroll"`
	Clip      *Rect    `json:"clip,omitempty"`
	Localhost string   `json:"localhost,omitempty"`
}

// Element is the page's advisory word on the element at a target's center.
// Box is in image pixels.
type Element struct {
	Selector string `json:"selector"`
	Tag      string `json:"tag"`
	Role     string `json:"role,omitempty"`
	Name     string `json:"name,omitempty"`
	Text     string `json:"text,omitempty"`
	Box      *Rect  `json:"box,omitempty"`
}

// Attachment is a stored image's metadata, fixed when it was uploaded.
type Attachment struct {
	ID        string `json:"id"`
	MediaType string `json:"mediaType"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
}

// Visual is a thread's visual target. Head is the project's HEAD commit
// when the thread was created, "" without git.
type Visual struct {
	Attachment Attachment `json:"attachment"`
	Rect       Rect       `json:"rect"`
	Page       *Page      `json:"page,omitempty"`
	Element    *Element   `json:"element,omitempty"`
	Head       string     `json:"head,omitempty"`
}

// VisualDraft is a new thread's visual target: a staged upload's ID, a
// rectangle in its image pixels, and optionally the page (its Localhost is
// ignored) and an element, which needs the page.
type VisualDraft struct {
	Attachment string
	Rect       Rect
	Page       *Page
	Element    *Element
}

var (
	attachmentPattern = regexp.MustCompile(`^at-[a-z0-9]{10}$`)
	tagPattern        = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	jwtPattern        = regexp.MustCompile(`^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$`)
)

// ValidAttachmentID reports whether id is an attachment ID: at- and ten
// lowercase letters or digits. New IDs use base32's (a–z, 2–7).
func ValidAttachmentID(id string) bool { return attachmentPattern.MatchString(id) }

// excludedByVisual is the problem of a code field set beside visual.
const excludedByVisual = "doesn't apply with visual, which excludes path, side, lines, and compare"

// normalize trims text and normalizes the page URL; a URL that cannot be
// normalized is left as given for checkVisual to report.
func (v VisualDraft) normalize() VisualDraft {
	v.Attachment = strings.TrimSpace(v.Attachment)
	if v.Page != nil {
		page := *v.Page
		page.URL = strings.TrimSpace(page.URL)
		page.Title = strings.TrimSpace(page.Title)
		page.Localhost = ""
		if normalized, problem := NormalizeURL(page.URL); problem == "" {
			page.URL = normalized
		}
		v.Page = &page
	}
	if v.Element != nil {
		element := *v.Element
		element.Selector = strings.TrimSpace(element.Selector)
		element.Tag = strings.TrimSpace(element.Tag)
		element.Role = strings.TrimSpace(element.Role)
		element.Name = strings.TrimSpace(element.Name)
		element.Text = strings.TrimSpace(element.Text)
		v.Element = &element
	}
	return v
}

// checkVisual checks a normalized visual draft's structure; the image it
// names is checked by CheckVisualImage.
func checkVisual(add addProblem, visual VisualDraft) {
	switch {
	case visual.Attachment == "":
		add("visual.attachment", "is required: an upload's ID such as at-7hq2mx4kpa")
	case !ValidAttachmentID(visual.Attachment):
		add("visual.attachment", "must be at- and ten lowercase letters or digits, such as at-7hq2mx4kpa")
	}
	checkRect(add, "visual.rect", visual.Rect)
	if page := visual.Page; page != nil {
		if _, problem := NormalizeURL(page.URL); problem != "" {
			add("visual.page.url", "%s", problem)
		} else if len(page.URL) > MaxURLBytes {
			add("visual.page.url", "is %d bytes after redaction; the most is %d", len(page.URL), MaxURLBytes)
		}
		checkLine(add, "visual.page.title", page.Title, MaxTitleLength, "characters")
		viewport := page.Viewport
		viewportValid := viewport.Width >= 1 && viewport.Height >= 1 && viewport.DeviceScaleFactor > 0 && !math.IsInf(viewport.DeviceScaleFactor, 0)
		if !viewportValid {
			add("visual.page.viewport", "width and height must be at least 1 and deviceScaleFactor above 0")
		}
		if page.Clip != nil && checkRect(add, "visual.page.clip", *page.Clip) && viewportValid {
			width, height := viewport.Frame()
			checkInside(add, "visual.page.clip", *page.Clip, width, height, "frame")
		}
	}
	if element := visual.Element; element != nil {
		if visual.Page == nil {
			add("visual.element", "needs page: only a captured page has elements")
		}
		if element.Selector == "" {
			add("visual.element.selector", "is required")
		} else {
			checkLine(add, "visual.element.selector", element.Selector, MaxSelectorBytes, "bytes")
		}
		if len(element.Tag) > MaxTagBytes || !tagPattern.MatchString(element.Tag) {
			add("visual.element.tag", "must be a lowercase tag name of at most %d bytes, such as button", MaxTagBytes)
		}
		checkLine(add, "visual.element.role", element.Role, MaxRoleLength, "characters")
		checkLine(add, "visual.element.name", element.Name, MaxElementTextLength, "characters")
		checkLine(add, "visual.element.text", element.Text, MaxElementTextLength, "characters")
		if element.Box != nil {
			checkRect(add, "visual.element.box", *element.Box)
		}
	}
}

// checkRect reports a rectangle that starts left of or above the origin or
// is empty; it returns whether the rectangle is well formed.
func checkRect(add addProblem, field string, rect Rect) bool {
	valid := true
	if rect.X < 0 || rect.Y < 0 {
		add(field, "%s starts before the origin: x and y must be 0 or more", rect)
		valid = false
	}
	if rect.Width < 1 || rect.Height < 1 {
		add(field, "%s is empty: width and height must be at least 1", rect)
		valid = false
	}
	return valid
}

// checkInside reports a well-formed rectangle that ends past width or
// height of what (the image or the frame).
func checkInside(add addProblem, field string, rect Rect, width, height int, what string) {
	if end := rect.X + rect.Width; end > width {
		add(field, "%s ends at x %d, past the %s's width %d", rect, end, what, width)
	}
	if end := rect.Y + rect.Height; end > height {
		add(field, "%s ends at y %d, past the %s's height %d", rect, end, what, height)
	}
}

// checkLine reports text over limit (counted in unit, bytes or characters)
// or spanning lines.
func checkLine(add addProblem, field, text string, limit int, unit string) {
	length := len(text)
	if unit == "characters" {
		length = utf8.RuneCountInString(text)
	}
	if length > limit || strings.ContainsAny(text, "\r\n") {
		add(field, "must be one line of at most %d %s", limit, unit)
	}
}

// staleUpload is the problem of an attachment that is not a live upload.
const staleUpload = "is not an upload of this repository, or it expired after 1 hour"

// CheckVisualImage checks a normalized visual draft against the upload it
// names: image is the upload's metadata, nil when the repository has none,
// and live whether it is still staged within its lifetime. The rectangle
// and element box must lie inside the image, and the image must be the
// page's clip or frame within 1 px. A malformed attachment ID is
// checkVisual's to report.
func CheckVisualImage(visual VisualDraft, image *Attachment, live bool) Problems {
	if !ValidAttachmentID(visual.Attachment) {
		return nil
	}
	var problems Problems
	add := collector(&problems)
	if !live {
		add("visual.attachment", staleUpload)
	}
	if image == nil {
		return problems
	}
	if wellFormed(visual.Rect) {
		checkInside(add, "visual.rect", visual.Rect, image.Width, image.Height, "image")
	}
	if page := visual.Page; page != nil {
		switch clip := page.Clip; {
		case clip != nil && wellFormed(*clip):
			if !within(clip.Width, image.Width) || !within(clip.Height, image.Height) {
				add("visual.page.clip", "is %d×%d, but the image is %d×%d", clip.Width, clip.Height, image.Width, image.Height)
			}
		case clip == nil && page.Viewport.Width >= 1 && page.Viewport.Height >= 1 && page.Viewport.DeviceScaleFactor > 0:
			width, height := page.Viewport.Frame()
			if !within(width, image.Width) || !within(height, image.Height) {
				add("visual.page.viewport", "makes a %d×%d frame at %g×, but the image is %d×%d; send the kept part as clip", width, height, page.Viewport.DeviceScaleFactor, image.Width, image.Height)
			}
		}
	}
	if element := visual.Element; element != nil && element.Box != nil && wellFormed(*element.Box) {
		checkInside(add, "visual.element.box", *element.Box, image.Width, image.Height, "image")
	}
	return problems
}

func wellFormed(rect Rect) bool {
	return rect.X >= 0 && rect.Y >= 0 && rect.Width >= 1 && rect.Height >= 1
}

// within reports whether two sizes differ by at most 1 px.
func within(a, b int) bool { return a-b <= 1 && b-a <= 1 }

// secretNames are query and fragment parameter names whose values are
// redacted, matched without case; X-Amz-* names are too.
var secretNames = map[string]bool{
	"token": true, "access_token": true, "id_token": true, "refresh_token": true, "code": true,
	"key": true, "api_key": true, "apikey": true, "secret": true, "client_secret": true,
	"password": true, "pass": true, "pwd": true, "auth": true, "authorization": true,
	"session": true, "sessionid": true, "sid": true, "sig": true, "signature": true,
	"jwt": true, "otp": true,
}

// Redacted replaces a secret value.
const Redacted = "REDACTED"

// NormalizeURL normalizes a page URL as the server stores it: http or https
// with a host, userinfo dropped, the values of secret query and fragment
// parameters and every JWT-shaped path segment or value replaced with
// REDACTED. It returns the problem instead when the URL is not one.
func NormalizeURL(raw string) (normalized string, problem string) {
	parsed, err := url.Parse(raw)
	switch {
	case err != nil:
		return "", "is not a URL"
	case parsed.Scheme != "http" && parsed.Scheme != "https":
		return "", "must be an http or https URL"
	case parsed.Opaque != "" || parsed.Host == "":
		return "", "must name a host"
	}
	var out strings.Builder
	out.WriteString(parsed.Scheme + "://" + parsed.Host)
	segments := strings.Split(parsed.EscapedPath(), "/")
	for i, segment := range segments {
		if jwtShaped(segment, url.PathUnescape) {
			segments[i] = Redacted
		}
	}
	out.WriteString(strings.Join(segments, "/"))
	if parsed.RawQuery != "" {
		out.WriteString("?" + redactParameters(parsed.RawQuery))
	}
	if fragment := parsed.EscapedFragment(); fragment != "" {
		out.WriteString("#" + redactParameters(fragment))
	}
	return out.String(), ""
}

// redactParameters redacts &-separated name=value parameters: a secret
// name's value, and any JWT-shaped value or bare item.
func redactParameters(raw string) string {
	parameters := strings.Split(raw, "&")
	for i, parameter := range parameters {
		name, value, hasValue := strings.Cut(parameter, "=")
		switch {
		case !hasValue:
			if jwtShaped(name, url.QueryUnescape) {
				parameters[i] = Redacted
			}
		case secretName(name) || jwtShaped(value, url.QueryUnescape):
			parameters[i] = name + "=" + Redacted
		}
	}
	return strings.Join(parameters, "&")
}

func secretName(raw string) bool {
	name, err := url.QueryUnescape(raw)
	if err != nil {
		name = raw
	}
	name = strings.ToLower(name)
	return secretNames[name] || strings.HasPrefix(name, "x-amz-")
}

// jwtShaped reports a value that is eyJ… and three dot-separated base64url
// parts, escaped or not.
func jwtShaped(raw string, unescape func(string) (string, error)) bool {
	if jwtPattern.MatchString(raw) {
		return true
	}
	value, err := unescape(raw)
	return err == nil && jwtPattern.MatchString(value)
}

// IsLoopbackURL reports whether a URL's host is loopback: localhost,
// *.localhost, 127.0.0.0/8, or [::1].
func IsLoopbackURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
