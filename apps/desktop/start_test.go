package main

import (
	"errors"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/flexdinesh/zero/apps/desktop/internal/connect"
	"github.com/flexdinesh/zero/apps/desktop/internal/proxy"
	"github.com/flexdinesh/zero/pkg/connection"
)

func TestOnlyMacOSHidesTheTitleBar(t *testing.T) {
	if style := windowChrome("darwin"); style != mygo.TitleBarHidden {
		t.Errorf("darwin chrome = %q; want a hidden title bar", style)
	}
	for _, goos := range []string{"linux", "windows"} {
		if style := windowChrome(goos); style != mygo.TitleBarDefault {
			t.Errorf("%s chrome = %q; want the native title bar", goos, style)
		}
	}
}

func TestMacOSAndLinuxFollowThePageAppearance(t *testing.T) {
	// Decision 0185: GTK's title bar and menus follow the theme's light or
	// dark on Linux, as macOS's do.
	for _, goos := range []string{"darwin", "linux"} {
		if !followsPageAppearance(goos) {
			t.Errorf("%s keeps the OS appearance", goos)
		}
	}
	if followsPageAppearance("windows") {
		t.Error("windows follows the page appearance")
	}
}

func TestTitleBarRoomInThePagesPixels(t *testing.T) {
	room := ui.TitleBar{Height: 28, Left: 78, Right: 0}
	cases := []struct {
		zoom float64
		want titleBar
	}{
		{1, titleBar{Height: 28, Left: 78}},
		{2, titleBar{Height: 14, Left: 39}},
		{0.5, titleBar{Height: 56, Left: 156}},
		// A zoom the page cannot have counts as none.
		{0, titleBar{Height: 28, Left: 78}},
		{-1, titleBar{Height: 28, Left: 78}},
	}
	for _, c := range cases {
		if got := titleBarCSS(room, c.zoom); got != c.want {
			t.Errorf("titleBarCSS(%+v, %v) = %+v; want %+v", room, c.zoom, got, c.want)
		}
	}
	if got := titleBarCSS(ui.TitleBar{}, 1.5); got != (titleBar{}) {
		t.Errorf("full screen room = %+v; want none", got)
	}
}

func TestWindowIdentityFollowsTheConnection(t *testing.T) {
	if got := windowStateKey(proxy.Host); got != "main" {
		t.Errorf("local state key = %q: its remembered bounds would be lost", got)
	}
	if windowStateKey("r-0123456789ab") == windowStateKey("r-000000000000") {
		t.Error("two connections share remembered bounds")
	}
	if got := windowTitle(proxy.Host, ""); got != "Zero" {
		t.Errorf("local title = %q", got)
	}
	if got := windowTitle("r-0123456789ab", "box"); got != "Zero: box" {
		t.Errorf("remote title = %q", got)
	}
}

func TestOnlyNamesConnection(t *testing.T) {
	for raw, want := range map[string]bool{
		"zero-app://r-0123456789ab/":              true,
		"zero-app://r-0123456789ab":               true,
		"zero-app://r-0123456789ab/?project=%2Fa": false,
		"zero-app://r-0123456789ab/view":          false,
		"zero-app://r-0123456789ab/#L1":           false,
	} {
		if got := onlyNamesConnection(raw); got != want {
			t.Errorf("onlyNamesConnection(%q) = %v", raw, got)
		}
	}
}

func TestFirstPageOpensOnTheStartPage(t *testing.T) {
	var first firstPage
	got := ""
	first.open("start", func(page string) { got = page })
	if got != "start" {
		t.Fatalf("first page %q", got)
	}
}

func TestALinkBeforeTheWindowBecomesTheFirstPage(t *testing.T) {
	var first firstPage
	if !first.request("one") || !first.request("two") {
		t.Fatal("requests before the window were not kept")
	}
	got := ""
	first.open("start", func(page string) { got = page })
	if got != "two" {
		t.Fatalf("first page %q, want the latest link", got)
	}
}

func TestALinkAfterTheWindowLoadsThere(t *testing.T) {
	var first firstPage
	first.open("start", func(string) {})
	if first.request("link") {
		t.Fatal("request after the window was kept")
	}
}

func TestReloadLimiterAllowsOneReloadPerPeriod(t *testing.T) {
	var limiter reloadLimiter
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	if !limiter.allow(now) {
		t.Fatal("first crash did not reload")
	}
	if limiter.allow(now.Add(crashReloadEvery - time.Second)) {
		t.Fatal("second crash inside the period reloaded")
	}
	if !limiter.allow(now.Add(crashReloadEvery)) {
		t.Fatal("crash after the period did not reload")
	}
}

// A launch that cannot do what its arguments ask still opens the default
// page, and says why.
func TestStartURLReportsWhatItCouldNotOpen(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"unknown link", []string{"zero://nope:x/"}, "Not a zero link."},
		{"folder", []string{"/no/such/folder"}, "Could not open folder"},
		{"connection not saved here", []string{"zero://r-0123456789ab/"}, "This computer has no such zero connection"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var reported []string
			daemon := connect.NewDaemon("", errors.New("no daemon"), nil, nil)
			h := &host{
				daemon:      daemon,
				connections: proxy.NewConnections(daemon, connection.NewStore(filepath.Join(t.TempDir(), "connections.json")), ""),
				notify:      func(message, _ string) { reported = append(reported, message) },
			}
			if got := h.startURL(c.args, "/"); got != proxy.Origin+"/" {
				t.Errorf("start page %q", got)
			}
			if len(reported) != 1 || reported[0] != c.want {
				t.Errorf("reported %v, want %q", reported, c.want)
			}
		})
	}
}

func TestWindowMenuClosesTabsInsteadOfTheWindow(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			item := (&host{}).windowMenu(goos)
			found := false
			for _, entry := range item.Submenu {
				if entry.Role == mygo.RoleClose {
					t.Fatal("native Close bypasses the workspace")
				}
				found = found || (entry.Accelerator == "CmdOrCtrl+W" && entry.Click != nil)
			}
			if !found {
				t.Fatal("no Cmd/Ctrl+W tab action")
			}
		})
	}
}

func TestGoMenuMovesThroughHistoryWithVSCodeKeys(t *testing.T) {
	for goos, keys := range map[string][]string{"darwin": {"Ctrl+-", "Ctrl+Shift+-"}, "linux": {"Ctrl+Alt+-", "Ctrl+Shift+-"}} {
		t.Run(goos, func(t *testing.T) {
			item := (&host{}).goMenu(goos)
			if item.Label != "Go" {
				t.Fatalf("label %q", item.Label)
			}
			var accelerators []string
			for _, entry := range item.Submenu {
				if entry.Label != "" && entry.Click == nil {
					t.Fatalf("%s does nothing", entry.Label)
				}
				if entry.Accelerator != "" {
					accelerators = append(accelerators, entry.Accelerator)
				}
			}
			if !slices.Equal(accelerators, keys) {
				t.Fatalf("accelerators %v, want %v", accelerators, keys)
			}
		})
	}
}
