package bridge

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/apps/desktop/internal/review"
	"github.com/flexdinesh/zero/pkg/contract"
)

func TestParseAppearance(t *testing.T) {
	for _, source := range []string{"system", "light", "dark"} {
		if got, ok := ParseAppearance(source); !ok || got != source {
			t.Errorf("ParseAppearance(%q) = %q, %v", source, got, ok)
		}
	}
	for _, value := range []any{"", "auto", "Dark", "dracula", nil, 1, true, []any{"dark"}} {
		if _, ok := ParseAppearance(value); ok {
			t.Errorf("ParseAppearance(%#v) accepted", value)
		}
	}
}

func TestParseNotifications(t *testing.T) {
	valid := func() map[string]any {
		return map[string]any{"project": "/code/zero", "commits": true, "branches": true, "edits": false, "walkthroughs": true, "feedback": true}
	}
	got, ok := ParseNotifications(valid())
	want := Notifications{Project: "/code/zero", Commits: true, Branches: true, Walkthroughs: true, Feedback: true}
	if !ok || got != want {
		t.Errorf("ParseNotifications = %+v, %v; want %+v", got, ok, want)
	}
	// An older server's page has no feedback choice: feedback is off.
	older := valid()
	delete(older, "feedback")
	if got, ok := ParseNotifications(older); !ok || got.Feedback || !got.Walkthroughs {
		t.Errorf("without feedback = %+v, %v", got, ok)
	}
	none := valid()
	none["project"] = ""
	if got, ok := ParseNotifications(none); !ok || got.Project != "" {
		t.Errorf("no project = %+v, %v", got, ok)
	}
	bad := []func(map[string]any){
		func(fields map[string]any) { fields["project"] = "relative/path" },
		func(fields map[string]any) { fields["project"] = "/code/../etc" },
		func(fields map[string]any) { fields["project"] = 1 },
		func(fields map[string]any) { delete(fields, "project") },
		func(fields map[string]any) { fields["commits"] = "yes" },
		func(fields map[string]any) { delete(fields, "branches") },
		func(fields map[string]any) { fields["edits"] = nil },
		func(fields map[string]any) { fields["walkthroughs"] = 1 },
		func(fields map[string]any) { fields["feedback"] = "on" },
		func(fields map[string]any) { fields["feedback"] = nil },
		func(fields map[string]any) { delete(fields, "feedback"); fields["connection"] = "r-000000000000" },
		func(fields map[string]any) { fields["connection"] = "r-000000000000" },
	}
	for i, change := range bad {
		fields := valid()
		change(fields)
		if _, ok := ParseNotifications(fields); ok {
			t.Errorf("bad payload %d accepted: %v", i, fields)
		}
	}
	for _, value := range []any{nil, "x", 1, []any{}} {
		if _, ok := ParseNotifications(value); ok {
			t.Errorf("ParseNotifications(%v) accepted", value)
		}
	}
}

func TestIsAppPage(t *testing.T) {
	for raw, want := range map[string]bool{
		"app://local":                      true,
		"app://local/":                     true,
		"app://local/view?project=/a#L1":   true,
		"app://local/api/raw?path=a.svg":   false,
		"app://local/assets/x.js":          false,
		"app://other/":                     false,
		"app://user@local/":                false,
		"https://local/":                   false,
		"mygo://localhost/":                false,
		"file:///local/":                   false,
		"about:blank":                      false,
		"":                                 false,
		"app://local:80/":                  false,
		"app://local.evil.example/":        false,
		"javascript:alert(1)//app://local": false,
	} {
		if got := IsAppPage(raw, "app", func(host string) bool { return host == "local" }); got != want {
			t.Errorf("IsAppPage(%q) = %v", raw, got)
		}
	}
	// What a remote window's page may call and what a local one may are
	// separate questions: the caller says which hosts it accepts.
	remote := func(host string) bool { return host == "r-0123456789ab" }
	if !IsAppPage("app://r-0123456789ab/view", "app", remote) || IsAppPage("app://local/", "app", remote) {
		t.Error("a host check did not decide the page")
	}
}

func TestParsePoint(t *testing.T) {
	if point, ok := ParsePoint(10.4, 20.6, 100, 100); !ok || point != (Point{10, 21}) {
		t.Errorf("point = %v, %v", point, ok)
	}
	for _, bad := range [][2]any{
		{-1.0, 1.0}, {1.0, -1.0}, {101.0, 1.0}, {1.0, 101.0}, {"1", 1.0}, {nil, 1.0}, {math.NaN(), 1.0}, {math.Inf(1), 1.0},
	} {
		if _, ok := ParsePoint(bad[0], bad[1], 100, 100); ok {
			t.Errorf("ParsePoint(%v) accepted", bad)
		}
	}
}

func item(id, label string) map[string]any { return map[string]any{"id": id, "label": label} }

func TestParseItems(t *testing.T) {
	separator := map[string]any{"separator": true}
	items, ok := ParseItems([]any{separator, item("a", "A"), separator, separator, map[string]any{"id": "b", "label": "B", "enabled": false, "accelerator": "CmdOrCtrl+W"}, separator})
	if !ok || len(items) != 3 || !items[1].Separator || items[0].ID != "a" || !items[0].Enabled || items[2].Enabled || items[2].Accelerator != "CmdOrCtrl+W" {
		t.Errorf("items = %+v, %v", items, ok)
	}
	many := make([]any, maxMenuItems+1)
	for i := range many {
		many[i] = separator
	}
	for name, bad := range map[string]any{
		"not a list":         "a",
		"empty":              []any{},
		"too many":           many,
		"only separators":    []any{separator},
		"not a record":       []any{"a"},
		"separator extras":   []any{map[string]any{"separator": true, "id": "a"}},
		"missing label":      []any{map[string]any{"id": "a"}},
		"blank label":        []any{item("a", "  ")},
		"control in label":   []any{item("a", "a\nb")},
		"long label":         []any{item("a", strings.Repeat("x", maxItemLabel+1))},
		"bad id":             []any{item("a b", "A")},
		"long id":            []any{item(strings.Repeat("a", maxItemID+1), "A")},
		"duplicate id":       []any{item("a", "A"), item("a", "B")},
		"enabled not a bool": []any{map[string]any{"id": "a", "label": "A", "enabled": "yes"}},
		"bad accelerator":    []any{map[string]any{"id": "a", "label": "A", "accelerator": "Hyper+W"}},
		"a bad item spoils":  []any{item("a", "A"), item("b c", "B")},
	} {
		if _, ok := ParseItems(bad); ok {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestParseReveal(t *testing.T) {
	if project, relative, ok := ParseReveal("/a/b", "c/d.md"); !ok || project != "/a/b" || relative != "c/d.md" {
		t.Errorf("ParseReveal = %q %q %v", project, relative, ok)
	}
	if _, _, ok := ParseReveal("/a/b", "c/d/"); !ok {
		t.Error("a directory's trailing slash refused")
	}
	for _, bad := range [][2]any{
		{"a/b", "c"}, {"/a/../b", "c"}, {"/a/b/", "c"}, {"/a\x00", "c"}, {1.0, "c"}, {"/a", 1.0}, {nil, nil},
		{"/a", ""}, {"/a", "/c"}, {"/a", "../c"}, {"/a", "c/../d"}, {"/a", "./c"}, {"/a", "c//d"}, {"/a", `c\d`}, {"/a", "c\x00"},
		{"/a", strings.Repeat("x", maxPathLength+1)}, {"/" + strings.Repeat("x", maxPathLength), "c"},
	} {
		if _, _, ok := ParseReveal(bad[0], bad[1]); ok {
			t.Errorf("ParseReveal(%q) accepted", bad)
		}
	}
}

func TestResolveReveal(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "root")
	project := filepath.Join(root, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{filepath.Join(project, "file.md"), filepath.Join(outside, "secret")} {
		if err := os.WriteFile(name, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(project, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	roots := []string{filepath.Join(base, "missing"), root}

	target, err := ResolveReveal(roots, project, "file.md", filepath.EvalSymlinks)
	if err != nil || target != filepath.Join(project, "file.md") {
		t.Errorf("served file: %q, %v", target, err)
	}
	for name, test := range map[string]struct {
		roots             []string
		project, relative string
		want              error
	}{
		"symlink out of the project":      {roots, project, "escape", ErrPathEscapes},
		"project symlinked out of a root": {roots, filepath.Join(root, "linked"), "secret", ErrNotServed},
		"project outside the roots":       {roots, outside, "secret", ErrNotServed},
		"no roots":                        {nil, project, "file.md", ErrNotServed},
		"root prefix is not a parent":     {[]string{root + "x"}, project, "file.md", ErrNotServed},
		"missing project":                 {roots, filepath.Join(root, "gone"), "a", ErrProjectUnavailable},
		"missing file":                    {roots, project, "gone.md", ErrPathMissing},
		"dot dot":                         {roots, project, "../project/file.md", ErrPathEscapes},
	} {
		if _, err := ResolveReveal(test.roots, test.project, test.relative, filepath.EvalSymlinks); !errors.Is(err, test.want) {
			t.Errorf("%s: %v, want %v", name, err, test.want)
		}
	}
}

// The app's report is redacted and never carries null lines.
func TestNewDiagnosticsRedacts(t *testing.T) {
	got := NewDiagnostics("1.2.3", "abc", "/home/u/.local/state/zero/logs", []string{"opened /home/u/src"}, nil, "/home/u")
	if got.LogDir != "~/.local/state/zero/logs" || len(got.LogLines) != 1 || got.LogLines[0] != "opened ~/src" {
		t.Errorf("NewDiagnostics = %+v", got)
	}
	if got.CrashLines == nil || len(got.CrashLines) != 0 {
		t.Errorf("crash lines = %#v, want empty", got.CrashLines)
	}
	if got.Version != "1.2.3" || got.Commit != "abc" {
		t.Errorf("build = %q %q", got.Version, got.Commit)
	}
}

func TestParseBrowserOpen(t *testing.T) {
	request, ok := ParseBrowserOpen("/home/u/app", "localhost:5173/settings")
	if !ok || request != (BrowserOpen{Project: "/home/u/app", URL: "http://localhost:5173/settings"}) {
		t.Errorf("ParseBrowserOpen = %+v, %v", request, ok)
	}
	for name, args := range map[string][2]any{
		"relative project": {"app", "http://a.test/"},
		"script URL":       {"/p", "javascript:alert(1)"},
		"file URL":         {"/p", "file:///etc/passwd"},
		"app URL":          {"/p", "zero-app://local/"},
		"not text":         {"/p", 3.0},
	} {
		if request, ok := ParseBrowserOpen(args[0], args[1]); ok {
			t.Errorf("%s: accepted %+v", name, request)
		}
	}
}

func TestParseBrowserTab(t *testing.T) {
	for _, value := range []any{1.0, 2.0, float64(MaxBrowserTabs)} {
		if got, ok := ParseBrowserTab(value); !ok || float64(got) != value {
			t.Errorf("ParseBrowserTab(%v) = %d, %v", value, got, ok)
		}
	}
	for name, value := range map[string]any{
		"zero":     0.0,
		"negative": -1.0,
		"too many": float64(MaxBrowserTabs + 1),
		"fraction": 1.5,
		"text":     "1",
		"missing":  nil,
	} {
		if got, ok := ParseBrowserTab(value); ok {
			t.Errorf("%s: accepted %d", name, got)
		}
	}
}

func TestParseBrowserProject(t *testing.T) {
	if got, ok := ParseBrowserProject("/home/u/app"); !ok || got != "/home/u/app" {
		t.Errorf("ParseBrowserProject = %q, %v", got, ok)
	}
	for name, value := range map[string]any{
		"relative":   "app",
		"unclean":    "/home/u/../app",
		"trailing /": "/home/u/app/",
		"empty":      "",
		"NUL":        "/home/u\x00app",
		"not text":   3.0,
		"missing":    nil,
	} {
		if got, ok := ParseBrowserProject(value); ok {
			t.Errorf("%s: accepted %q", name, got)
		}
	}
}

func TestParseBrowserAction(t *testing.T) {
	for _, action := range []string{"back", "forward", "reload", "stop", "close", "comment", "endComment"} {
		got, ok := ParseBrowserAction("/home/u/app", action)
		if !ok || got != (BrowserAction{Project: "/home/u/app", Action: action}) {
			t.Errorf("ParseBrowserAction(%q) = %+v, %v", action, got, ok)
		}
	}
	for name, args := range map[string][2]any{
		"unknown action":   {"/p", "navigate"},
		"a gone action":    {"/p", "show"},
		"case":             {"/p", "Back"},
		"empty action":     {"/p", ""},
		"action not text":  {"/p", 1.0},
		"relative project": {"p", "back"},
		"project not text": {nil, "back"},
	} {
		if got, ok := ParseBrowserAction(args[0], args[1]); ok {
			t.Errorf("%s: accepted %+v", name, got)
		}
	}
}

func TestParseBrowserFrame(t *testing.T) {
	frame := func(x, y, width, height any) map[string]any {
		return map[string]any{"x": x, "y": y, "width": width, "height": height}
	}
	got, ok := ParseBrowserFrame("/home/u/app", frame(300.5, 80.0, 600.0, 400.0))
	if !ok || got != (BrowserFrame{Project: "/home/u/app", Shown: true, X: 300.5, Y: 80, Width: 600, Height: 400}) {
		t.Errorf("ParseBrowserFrame = %+v, %v", got, ok)
	}
	if got, ok := ParseBrowserFrame("/home/u/app", nil); !ok || got != (BrowserFrame{Project: "/home/u/app"}) {
		t.Errorf("hidden: ParseBrowserFrame = %+v, %v", got, ok)
	}
	for name, args := range map[string][2]any{
		"relative project": {"p", frame(0.0, 0.0, 10.0, 10.0)},
		"not a rectangle":  {"/p", "0,0,10,10"},
		"a list":           {"/p", []any{0.0, 0.0, 10.0, 10.0}},
		"a side missing":   {"/p", map[string]any{"x": 0.0, "y": 0.0, "width": 10.0}},
		"text for a side":  {"/p", frame("0", 0.0, 10.0, 10.0)},
		"no width":         {"/p", frame(0.0, 0.0, 0.0, 10.0)},
		"negative height":  {"/p", frame(0.0, 0.0, 10.0, -1.0)},
		"not a number":     {"/p", frame(math.NaN(), 0.0, 10.0, 10.0)},
		"endless":          {"/p", frame(0.0, 0.0, math.Inf(1), 10.0)},
		"far away":         {"/p", frame(1e9, 0.0, 10.0, 10.0)},
	} {
		if got, ok := ParseBrowserFrame(args[0], args[1]); ok {
			t.Errorf("%s: accepted %+v", name, got)
		}
	}
}

func TestParseBrowserPins(t *testing.T) {
	pin := func(fields map[string]any) []any { return []any{fields} }
	got, ok := ParseBrowserPins("/repo", []any{
		map[string]any{"thread": 2.0, "resolved": false, "selector": `main > button[data-testid="save"]`, "x": 605.0, "y": 1640.0},
		map[string]any{"thread": 5.0, "resolved": true, "x": -4.0, "y": 0.0},
	}, true)
	want := BrowserPins{Project: "/repo", Visible: true, Pins: []review.Pin{
		{Thread: 2, Selector: `main > button[data-testid="save"]`, X: 605, Y: 1640},
		{Thread: 5, Resolved: true, X: -4, Y: 0},
	}}
	if !ok || !reflect.DeepEqual(got, want) {
		t.Errorf("pins = %+v, %v", got, ok)
	}
	if got, ok := ParseBrowserPins("/repo", []any{}, false); !ok || len(got.Pins) != 0 || got.Visible {
		t.Errorf("no pins = %+v, %v", got, ok)
	}
	many := make([]any, review.MaxPins+1)
	for index := range many {
		many[index] = map[string]any{"thread": float64(index + 1), "resolved": false, "x": 0.0, "y": 0.0}
	}
	valid := map[string]any{"thread": 1.0, "resolved": false, "x": 0.0, "y": 0.0}
	with := func(name string, value any) []any {
		changed := map[string]any{}
		for key, each := range valid {
			changed[key] = each
		}
		changed[name] = value
		return pin(changed)
	}
	for name, each := range map[string][3]any{
		"relative project":  {"repo", pin(valid), true},
		"no pins":           {"/repo", nil, true},
		"no visible":        {"/repo", pin(valid), nil},
		"too many":          {"/repo", many, true},
		"not an object":     {"/repo", []any{"pin"}, true},
		"thread zero":       {"/repo", with("thread", 0.0), true},
		"thread fraction":   {"/repo", with("thread", 1.5), true},
		"thread text":       {"/repo", with("thread", "1"), true},
		"resolved missing":  {"/repo", with("resolved", nil), true},
		"x not a number":    {"/repo", with("x", math.NaN()), true},
		"y too far":         {"/repo", with("y", 1e8), true},
		"selector a number": {"/repo", with("selector", 1.0), true},
		"selector control":  {"/repo", with("selector", "a\nb"), true},
		"selector too long": {"/repo", with("selector", strings.Repeat("a", 513)), true},
		"thread twice":      {"/repo", []any{valid, valid}, true},
	} {
		if got, ok := ParseBrowserPins(each[0], each[1], each[2]); ok {
			t.Errorf("%s: pins = %+v", name, got)
		}
	}
}

func TestParseComposerPayloads(t *testing.T) {
	for _, direction := range []string{WalkParent, WalkChild} {
		if got, ok := ParseWalk(direction); !ok || got != direction {
			t.Errorf("ParseWalk(%q) = %q, %v", direction, got, ok)
		}
	}
	for _, direction := range []any{"up", "", nil, 1.0} {
		if got, ok := ParseWalk(direction); ok {
			t.Errorf("ParseWalk(%v) = %q", direction, got)
		}
	}
	if got, ok := ParseComposerHeight(212.5); !ok || got != 212.5 {
		t.Errorf("ParseComposerHeight = %v, %v", got, ok)
	}
	for _, height := range []any{0.0, -1.0, math.NaN(), math.Inf(1), "200", nil} {
		if got, ok := ParseComposerHeight(height); ok {
			t.Errorf("ParseComposerHeight(%v) = %v", height, got)
		}
	}
}

func TestIsComposerPage(t *testing.T) {
	for raw, want := range map[string]bool{
		"app://local/composer":         true,
		"app://local/composer?x=1#top": true,
		"app://local/":                 false,
		"app://local/composer/":        false,
		"app://local/view":             false,
		"app://other/composer":         false,
		"app://user@local/composer":    false,
		"https://local/composer":       false,
		"":                             false,
	} {
		if got := IsComposerPage(raw, "app", "/composer", func(host string) bool { return host == "local" }); got != want {
			t.Errorf("IsComposerPage(%q) = %v", raw, got)
		}
	}
}

const viewedBlob = "0123456789abcdef0123456789abcdef01234567"

func TestParseIdentity(t *testing.T) {
	for value, want := range map[any]bool{
		"github.com/flexdinesh/zero": true, "GitHub.com/me/zero": false, "github.com": false, "": false, 42: false, nil: false,
	} {
		if _, got := ParseIdentity(value); got != want {
			t.Errorf("ParseIdentity(%v) = %v, want %v", value, got, want)
		}
	}
}

func TestParseViewedMarks(t *testing.T) {
	id, files, ok := ParseViewedMarks("github.com/me/zero", map[string]any{"src/b.go": viewedBlob, "a.go": viewedBlob})
	if !ok || id != "github.com/me/zero" || !reflect.DeepEqual(files, [][2]string{{"a.go", viewedBlob}, {"src/b.go", viewedBlob}}) {
		t.Errorf("ParseViewedMarks = %q, %v, %v", id, files, ok)
	}
	if _, files, ok := ParseViewedMarks("github.com/me/zero", map[string]any{}); !ok || len(files) != 0 {
		t.Errorf("empty marks = %v, %v", files, ok)
	}
	for name, marks := range map[string]any{
		"not a map":     []any{"a.go"},
		"absolute path": map[string]any{"/etc/passwd": viewedBlob},
		"bad blob":      map[string]any{"a.go": "nope"},
		"not text":      map[string]any{"a.go": 7},
		"control":       map[string]any{"a\x07.go": viewedBlob},
	} {
		if _, _, ok := ParseViewedMarks("github.com/me/zero", marks); ok {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, _, ok := ParseViewedMarks("Not An Identity", map[string]any{"a.go": viewedBlob}); ok {
		t.Error("bad identity accepted")
	}
}

func TestParseOpenProject(t *testing.T) {
	known := func(host string) bool { return host == "local" || host == "r-0123456789ab" }
	if c, p, ok := ParseOpenProject("r-0123456789ab", "/home/dev/zero", known); !ok || c != "r-0123456789ab" || p != "/home/dev/zero" {
		t.Errorf("ParseOpenProject = %q, %q, %v", c, p, ok)
	}
	for _, args := range [][2]any{{"r-ffffffffffff", "/home/dev/zero"}, {"local", "relative"}, {"local", "/a/../b"}, {1, "/a"}} {
		if _, _, ok := ParseOpenProject(args[0], args[1], known); ok {
			t.Errorf("ParseOpenProject(%v) accepted", args)
		}
	}
}

func TestMatchesOf(t *testing.T) {
	response := contract.ProjectsResponse{Projects: []contract.Project{
		{ID: "/home/dev/zero", Identity: "github.com/me/zero", Available: true},
		{ID: "", Identity: "github.com/me/zero", Available: false},
		{ID: "/home/dev/other", Identity: "github.com/me/other", Available: true},
	}}
	want := []ProjectMatch{{Connection: "r-0123456789ab", Label: "devbox", Project: "/home/dev/zero"}}
	if got := MatchesOf(response, "r-0123456789ab", "devbox", "github.com/me/zero"); !reflect.DeepEqual(got, want) {
		t.Errorf("MatchesOf = %+v", got)
	}
}
