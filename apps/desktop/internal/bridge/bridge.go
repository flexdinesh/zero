// Package bridge validates what pages send through window.zeroDesktop
// (decision 0081). Pages are untrusted input: every field is checked and
// anything invalid is refused whole. It is pure but for a RealPath callback.
package bridge

import (
	"errors"
	"math"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/flexdinesh/zero/apps/desktop/internal/appearance"
	"github.com/flexdinesh/zero/apps/desktop/internal/review"
	"github.com/flexdinesh/zero/apps/desktop/internal/viewed"
	"github.com/flexdinesh/zero/pkg/contract"
	"github.com/flexdinesh/zero/pkg/logfile"
)

const (
	maxMenuItems   = 32
	maxItemID      = 64
	maxItemLabel   = 128
	maxAccelerator = 40
	maxPathLength  = 4096
)

// Reveal refusals, shown without blocking.
var (
	ErrNotServed          = errors.New("The project is not in a folder zero serves.")
	ErrProjectUnavailable = errors.New("The project is unavailable.")
	ErrPathMissing        = errors.New("The file no longer exists.")
	ErrPathEscapes        = errors.New("The path leads outside its project.")
)

// Item is one validated row of a context menu.
type Item struct {
	Separator bool
	ID        string
	Label     string
	Enabled   bool
	// Accelerator is a display hint, never registered: the page owns its keys.
	Accelerator string
}

// Point is a validated menu position in the page.
type Point struct{ X, Y int }

var (
	itemID      = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
	accelerator = regexp.MustCompile("^(?:(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta)\\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|[,./;'`=\\[\\]\\\\-])$")
)

// IsAppPage reports the app's own page: an origin known says is the app's, and
// the routes the web app runs on. Bytes served from the same origin (/api/raw)
// get no bridge.
func IsAppPage(raw, scheme string, known func(host string) bool) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != scheme || u.User != nil || !known(u.Host) {
		return false
	}
	return u.Path == "" || u.Path == "/" || u.Path == "/view"
}

// IsComposerPage reports the composer's page: path on an origin known says
// is the app's.
func IsComposerPage(raw, scheme, path string, known func(host string) bool) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == scheme && u.User == nil && known(u.Host) && u.Path == path
}

// ParsePoint validates a menu point: finite numbers inside the content size,
// rounded to integers.
func ParsePoint(x, y any, width, height int) (Point, bool) {
	fx, okX := x.(float64)
	fy, okY := y.(float64)
	if !okX || !okY || math.IsNaN(fx) || math.IsNaN(fy) || math.IsInf(fx, 0) || math.IsInf(fy, 0) {
		return Point{}, false
	}
	if fx < 0 || fy < 0 || fx > float64(width) || fy > float64(height) {
		return Point{}, false
	}
	return Point{int(math.Round(fx)), int(math.Round(fy))}, true
}

// ParseItems validates menu items: {id, label, enabled?, accelerator?} or
// {separator: true}, ids unique. Leading, trailing, and repeated separators
// are dropped; a menu needs at least one item. Anything else is refused.
func ParseItems(value any) ([]Item, bool) {
	raw, ok := value.([]any)
	if !ok || len(raw) == 0 || len(raw) > maxMenuItems {
		return nil, false
	}
	items := make([]Item, 0, len(raw))
	ids := map[string]bool{}
	for _, entry := range raw {
		item, ok := parseItem(entry)
		if !ok {
			return nil, false
		}
		if item.Separator {
			if len(items) > 0 && !items[len(items)-1].Separator {
				items = append(items, item)
			}
			continue
		}
		if ids[item.ID] {
			return nil, false
		}
		ids[item.ID] = true
		items = append(items, item)
	}
	if len(items) > 0 && items[len(items)-1].Separator {
		items = items[:len(items)-1]
	}
	return items, len(items) > 0
}

func parseItem(value any) (Item, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return Item{}, false
	}
	if separator, ok := record["separator"].(bool); ok && separator {
		return Item{Separator: true}, len(record) == 1
	}
	id, okID := record["id"].(string)
	label, okLabel := record["label"].(string)
	if !okID || !okLabel || len(id) > maxItemID || !itemID.MatchString(id) {
		return Item{}, false
	}
	if strings.TrimSpace(label) == "" || utf8.RuneCountInString(label) > maxItemLabel || hasControl(label) {
		return Item{}, false
	}
	item := Item{ID: id, Label: label, Enabled: true}
	if enabled, present := record["enabled"]; present {
		flag, ok := enabled.(bool)
		if !ok {
			return Item{}, false
		}
		item.Enabled = flag
	}
	if hint, present := record["accelerator"]; present {
		text, ok := hint.(string)
		if !ok || len(text) > maxAccelerator || !accelerator.MatchString(text) {
			return Item{}, false
		}
		item.Accelerator = text
	}
	return item, true
}

func hasControl(text string) bool {
	return strings.ContainsFunc(text, func(r rune) bool { return r < 0x20 || r == 0x7f })
}

// RealPath resolves symlinks of an existing path, or fails.
type RealPath func(name string) (string, error)

// ParseReveal validates {project, path}: project absolute and normalized,
// path relative with "/" separators, no leading "/", backslash, empty, ".",
// or ".." segment; a directory's trailing "/" is allowed.
func ParseReveal(project, relative any) (string, string, bool) {
	p, okP := project.(string)
	r, okR := relative.(string)
	if !okP || !okR || !isPlainAbsolute(p) || segments(r) == nil {
		return "", "", false
	}
	return p, r, true
}

// ParseAppearance validates the source a page asks native surfaces to follow
// (decision 0119): "system", "light", or "dark".
func ParseAppearance(value any) (string, bool) {
	source, ok := value.(string)
	return source, ok && appearance.IsSource(source)
}

// Notifications is what a page tells the notifier: the project it shows and
// the user's settings (decision 0099).
type Notifications struct {
	// Project is "" when the page shows none.
	Project      string
	Commits      bool
	Branches     bool
	Edits        bool
	Walkthroughs bool
	// Feedback is agents' replies to review feedback (decision 0120).
	Feedback bool
}

// NotificationStatus is whether notices can reach the user.
type NotificationStatus struct {
	Supported bool `json:"supported"`
	Denied    bool `json:"denied"`
}

// ParseNotifications validates {project, commits, branches, edits,
// walkthroughs, feedback}: project "" or absolute and normalized, the rest
// booleans, and nothing else. feedback may be absent, as from a page of an
// older server, which means off.
func ParseNotifications(value any) (Notifications, bool) {
	fields, ok := value.(map[string]any)
	if !ok {
		return Notifications{}, false
	}
	feedback, wanted := false, 5
	if raw, present := fields["feedback"]; present {
		flag, ok := raw.(bool)
		if !ok {
			return Notifications{}, false
		}
		feedback, wanted = flag, 6
	}
	if len(fields) != wanted {
		return Notifications{}, false
	}
	project, okProject := fields["project"].(string)
	commits, okCommits := fields["commits"].(bool)
	branches, okBranches := fields["branches"].(bool)
	edits, okEdits := fields["edits"].(bool)
	walkthroughs, okWalkthroughs := fields["walkthroughs"].(bool)
	if !okProject || !okCommits || !okBranches || !okEdits || !okWalkthroughs || (project != "" && !isPlainAbsolute(project)) {
		return Notifications{}, false
	}
	return Notifications{Project: project, Commits: commits, Branches: branches, Edits: edits, Walkthroughs: walkthroughs, Feedback: feedback}, true
}

func isPlainAbsolute(name string) bool {
	if len(name) > maxPathLength || strings.ContainsRune(name, 0) || !filepath.IsAbs(name) || filepath.Clean(name) != name {
		return false
	}
	return true
}

func segments(name string) []string {
	if name == "" || len(name) > maxPathLength || strings.ContainsRune(name, 0) || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") {
		return nil
	}
	parts := strings.Split(strings.TrimSuffix(name, "/"), "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil
		}
	}
	return parts
}

// within reports child at or below parent; both are real paths.
func within(parent, child string) bool {
	if child == parent {
		return true
	}
	prefix := parent
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(child, prefix)
}

// ResolveReveal returns the real path to reveal: the project's real path
// must lie in a root's real path, and the target's inside the project.
func ResolveReveal(roots []string, project, relative string, realpath RealPath) (string, error) {
	parts := segments(relative)
	if parts == nil {
		return "", ErrPathEscapes
	}
	real, err := realpath(project)
	if err != nil {
		return "", ErrProjectUnavailable
	}
	served := false
	for _, root := range roots {
		// A root missing on disk serves nothing.
		if resolved, err := realpath(root); err == nil && within(resolved, real) {
			served = true
			break
		}
	}
	if !served {
		return "", ErrNotServed
	}
	target, err := realpath(filepath.Join(append([]string{real}, parts...)...))
	if err != nil {
		return "", ErrPathMissing
	}
	if !within(real, target) {
		return "", ErrPathEscapes
	}
	return target, nil
}

// Diagnostics is what the page's problem report says about the app
// (decision 0152): its build, where its logs live, and its newest log and
// crash lines, all redacted.
type Diagnostics struct {
	Version    string   `json:"version"`
	Commit     string   `json:"commit"`
	LogDir     string   `json:"logDir"`
	LogLines   []string `json:"logLines"`
	CrashLines []string `json:"crashLines"`
}

// NewDiagnostics redacts the app's log directory and lines with home, never
// leaving the lines null.
func NewDiagnostics(version, commit, logDir string, lines, crash []string, home string) Diagnostics {
	redact := func(lines []string) []string {
		if lines == nil {
			return []string{}
		}
		return logfile.RedactLines(lines, home)
	}
	return Diagnostics{Version: version, Commit: commit, LogDir: logfile.Redact(logDir, home), LogLines: redact(lines), CrashLines: redact(crash)}
}

// BrowserOpen is browserOpen's payload (decision 0184): the page to show in a
// project's guest, an absolute http or https URL.
type BrowserOpen struct {
	Project string
	// Tab is the project's Browser tab, set from ParseBrowserTab.
	Tab int
	URL string
}

// ParseBrowserOpen validates browserOpen's payload: an absolute project
// directory and a page URL review.CheckURL accepts.
func ParseBrowserOpen(project, pageURL any) (BrowserOpen, bool) {
	p, okP := ParseBrowserProject(project)
	u, okU := pageURL.(string)
	if !okP || !okU {
		return BrowserOpen{}, false
	}
	checked, ok := review.CheckURL(u)
	if !ok {
		return BrowserOpen{}, false
	}
	return BrowserOpen{Project: p, URL: checked}, true
}

// MaxBrowserTabs bounds a project's Browser tabs (decision 0195).
const MaxBrowserTabs = 99

// ParseBrowserTab validates the tab of the Browser tab's calls (decision
// 0195): a whole number from 1 to MaxBrowserTabs. The preload passes 1 for
// a page that names none, as pages before 0195 did.
func ParseBrowserTab(tab any) (int, bool) {
	return wholeNumber(tab, 1, MaxBrowserTabs)
}

// ParseBrowserProject validates a project of the Browser tab's calls: an
// absolute project directory.
func ParseBrowserProject(project any) (string, bool) {
	p, ok := project.(string)
	if !ok || !isPlainAbsolute(p) {
		return "", false
	}
	return p, true
}

// BrowserAction is browserAction's payload: what to do with a project's
// guest.
type BrowserAction struct {
	Project string
	// Tab is the project's Browser tab, set from ParseBrowserTab.
	Tab    int
	Action string
}

// Browser actions: history moves, loading, closing the guest, and comment
// mode on and off.
const (
	BrowserBack       = "back"
	BrowserForward    = "forward"
	BrowserReload     = "reload"
	BrowserStop       = "stop"
	BrowserClose      = "close"
	BrowserComment    = "comment"
	BrowserEndComment = "endComment"
)

// ParseBrowserAction validates browserAction's payload: an absolute project
// directory and one of the Browser actions.
func ParseBrowserAction(project, action any) (BrowserAction, bool) {
	p, okP := ParseBrowserProject(project)
	a, okA := action.(string)
	if !okP || !okA {
		return BrowserAction{}, false
	}
	switch a {
	case BrowserBack, BrowserForward, BrowserReload, BrowserStop, BrowserClose, BrowserComment, BrowserEndComment:
		return BrowserAction{Project: p, Action: a}, true
	}
	return BrowserAction{}, false
}

// BrowserFrame is browserFrame's payload: where a project's guest shows, in
// CSS pixels of the sender's viewport, or Shown false to hide it.
type BrowserFrame struct {
	Project string
	// Tab is the project's Browser tab, set from ParseBrowserTab.
	Tab                 int
	Shown               bool
	X, Y, Width, Height float64
}

// maxFrameCoordinate bounds a frame's numbers; nothing lays out farther.
const maxFrameCoordinate = 1 << 20

// ParseBrowserFrame validates browserFrame's payload: an absolute project
// directory, and null or a rectangle of finite numbers with a size.
func ParseBrowserFrame(project, frame any) (BrowserFrame, bool) {
	p, ok := ParseBrowserProject(project)
	if !ok {
		return BrowserFrame{}, false
	}
	if frame == nil {
		return BrowserFrame{Project: p}, true
	}
	fields, ok := frame.(map[string]any)
	if !ok {
		return BrowserFrame{}, false
	}
	number := func(name string) (float64, bool) {
		value, ok := fields[name].(float64)
		return value, ok && !math.IsNaN(value) && math.Abs(value) <= maxFrameCoordinate
	}
	x, okX := number("x")
	y, okY := number("y")
	width, okW := number("width")
	height, okH := number("height")
	if !okX || !okY || !okW || !okH || width <= 0 || height <= 0 {
		return BrowserFrame{}, false
	}
	return BrowserFrame{Project: p, Shown: true, X: x, Y: y, Width: width, Height: height}, true
}

// BrowserPins is browserPins's payload: the marks of earlier comments on a
// project's page, and whether they show.
type BrowserPins struct {
	Project string
	// Tab is the project's Browser tab, set from ParseBrowserTab.
	Tab     int
	Pins    []review.Pin
	Visible bool
}

// ParseBrowserPins validates browserPins's payload: an absolute project
// directory, at most review.MaxPins pins, and whether they show. A pin is
// its thread's number from 1, whether it is resolved, an optional selector
// of at most 512 bytes without control characters, and a point of whole
// CSS pixels of the document.
func ParseBrowserPins(project, pins, visible any) (BrowserPins, bool) {
	p, okP := ParseBrowserProject(project)
	rows, okRows := pins.([]any)
	shown, okShown := visible.(bool)
	if !okP || !okRows || !okShown || len(rows) > review.MaxPins {
		return BrowserPins{}, false
	}
	parsed := make([]review.Pin, 0, len(rows))
	seen := map[int]bool{}
	for _, row := range rows {
		fields, ok := row.(map[string]any)
		if !ok {
			return BrowserPins{}, false
		}
		thread, okThread := wholeNumber(fields["thread"], 1, 1e9)
		x, okX := wholeNumber(fields["x"], -1e7, 1e7)
		y, okY := wholeNumber(fields["y"], -1e7, 1e7)
		resolved, okResolved := fields["resolved"].(bool)
		if !okThread || !okX || !okY || !okResolved || seen[thread] {
			return BrowserPins{}, false
		}
		seen[thread] = true
		pin := review.Pin{Thread: thread, Resolved: resolved, X: x, Y: y}
		if selector, given := fields["selector"]; given && selector != nil {
			text, ok := selector.(string)
			if !ok || len(text) > 512 || !utf8.ValidString(text) || strings.IndexFunc(text, unicode.IsControl) >= 0 {
				return BrowserPins{}, false
			}
			pin.Selector = text
		}
		parsed = append(parsed, pin)
	}
	return BrowserPins{Project: p, Pins: parsed, Visible: shown}, true
}

// wholeNumber reads a JSON number that is a whole number within [low, high].
func wholeNumber(value any, low, high float64) (int, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || number < low || number > high || number != math.Trunc(number) {
		return 0, false
	}
	return int(number), true
}

// Walk directions of the composer's Alt+Up and Alt+Down.
const (
	WalkParent = "parent"
	WalkChild  = "child"
)

// ParseWalk validates composerWalk's payload: one of the Walk directions.
func ParseWalk(direction any) (string, bool) {
	text, ok := direction.(string)
	return text, ok && (text == WalkParent || text == WalkChild)
}

// ParseComposerHeight validates composerResize's payload: the composer's
// content height in CSS pixels, a finite number above 0.
func ParseComposerHeight(height any) (float64, bool) {
	number, ok := height.(float64)
	return number, ok && !math.IsNaN(number) && number > 0 && number < 1<<20
}

// ParseIdentity validates a repository identity a page names (decision
// 0188): lowercase "host/path", as servers write them.
func ParseIdentity(value any) (string, bool) {
	identity, ok := value.(string)
	return identity, ok && viewed.IsIdentity(identity)
}

// ParseViewedMarks validates an identity's Viewed marks, file path to blob
// (decision 0188), as path and blob pairs sorted by path. Any invalid entry,
// or more than viewed.MaxFiles, refuses the payload.
func ParseViewedMarks(identity, marks any) (string, [][2]string, bool) {
	id, ok := ParseIdentity(identity)
	files, isMap := marks.(map[string]any)
	if !ok || !isMap || len(files) > viewed.MaxFiles {
		return "", nil, false
	}
	pairs := make([][2]string, 0, len(files))
	for path, value := range files {
		blob, isText := value.(string)
		if !isText || !viewed.IsPath(path) || hasControl(path) || !viewed.IsBlob(blob) {
			return "", nil, false
		}
		pairs = append(pairs, [2]string{path, blob})
	}
	slices.SortFunc(pairs, func(a, b [2]string) int { return strings.Compare(a[0], b[0]) })
	return id, pairs, true
}

// ProjectMatch is a checkout of an identity on another connection: its id,
// its name for people, and the project there (decision 0188).
type ProjectMatch struct {
	Connection string `json:"connection"`
	Label      string `json:"label"`
	Project    string `json:"project"`
}

// ParseOpenProject validates a project to open in a connection's window: a
// connection id or "local", and an absolute path.
func ParseOpenProject(connection, project any, isConnection func(string) bool) (string, string, bool) {
	c, okC := connection.(string)
	p, okP := project.(string)
	if !okC || !okP || !isConnection(c) || !isPlainAbsolute(p) {
		return "", "", false
	}
	return c, p, true
}

// MatchesOf lists a connection's available checkouts of identity.
func MatchesOf(response contract.ProjectsResponse, connection, label, identity string) []ProjectMatch {
	var matches []ProjectMatch
	for _, project := range response.Projects {
		if project.Available && project.ID != "" && project.Identity == identity {
			matches = append(matches, ProjectMatch{Connection: connection, Label: label, Project: project.ID})
		}
	}
	return matches
}
