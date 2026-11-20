//go:build e2e

// Package e2e launches the built app on a display and drives its page over
// mygo's automation protocol (decision 0094). Run it under a display and a
// session bus, with the real zero binary:
//
//	xvfb-run -a dbus-run-session -- sh apps/desktop/scripts/e2e.sh
//
// It writes screenshots and report.json to ZERO_DESKTOP_E2E_OUT. Resource
// scenarios additionally write RSS files when ZERO_DESKTOP_EXTENDED=1.
package e2e

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/png"
	"io"
	"io/fs"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/flexdinesh/zero/pkg/connection"
)

const (
	pageTimeout = 45 * time.Second
	callTimeout = 8 * time.Second
)

// session is a launch of the app and a connection to its automation socket.
type session struct {
	t      *testing.T
	cmd    *exec.Cmd
	socket string
	conn   net.Conn
	reader *bufio.Reader
	nextID int
	// target is the window evals run in; 0 is the focused window.
	target int
}

// connectionLink finds the link `zero connect` prints.
var connectionLink = regexp.MustCompile(`desktop: zero://(r-[0-9a-f]{12})/`)

func proxyOrigin(host string) string { return "zero-app://" + host }

type windowListing struct {
	Windows []struct {
		ID    int    `json:"id"`
		URL   string `json:"url"`
		Title string `json:"title"`
	} `json:"windows"`
}

func (s *session) listWindows() windowListing {
	s.t.Helper()
	var listing windowListing
	if err := s.call("windows", nil, &listing); err != nil {
		s.t.Fatal(err)
	}
	return listing
}

func (s *session) windowCount() int {
	s.t.Helper()
	return len(s.listWindows().Windows)
}

// windowOn returns the window showing origin, or 0.
func (s *session) windowOn(origin string) int {
	s.t.Helper()
	for _, window := range s.listWindows().Windows {
		if strings.HasPrefix(window.URL, origin) {
			return window.ID
		}
	}
	return 0
}

// waitWindow waits for a window showing origin.
func (s *session) waitWindow(origin string) int {
	s.t.Helper()
	deadline := time.Now().Add(pageTimeout)
	for {
		if id := s.windowOn(origin); id != 0 {
			return id
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("no window on %s: %+v", origin, s.listWindows())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

type world struct {
	t       *testing.T
	bin     string
	env     []string
	sock    string
	daemon  string
	project string
	out     string
	notices string
	report  map[string]any
	// driverSock is the app's own e2e driver (ZERO_E2E_DRIVER), which
	// reaches the page of a window of native UI (decision 0184).
	driverSock string
}

// driver connects to the app's e2e driver. Its session evaluates in the
// local window's page of the app, whichever kind of window holds it.
func (w *world) driver(t *testing.T) *session {
	t.Helper()
	deadline := time.Now().Add(pageTimeout)
	for {
		conn, err := net.Dial("unix", w.driverSock)
		if err == nil {
			t.Cleanup(func() { _ = conn.Close() })
			return &session{t: t, socket: w.driverSock, conn: conn, reader: bufio.NewReader(conn)}
		}
		if time.Now().After(deadline) {
			t.Fatalf("e2e driver socket: %v", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// shells counts the windows of native UI, through the app's driver.
func (s *session) shells() int {
	s.t.Helper()
	var listing struct {
		Windows []struct {
			Shell bool `json:"shell"`
		} `json:"windows"`
	}
	if err := s.call("windows", nil, &listing); err != nil {
		s.t.Fatal(err)
	}
	count := 0
	for _, window := range listing.Windows {
		if window.Shell {
			count++
		}
	}
	return count
}

func newWorld(t *testing.T) (*world, string) {
	t.Helper()
	binary := os.Getenv("ZERO_DESKTOP_BINARY")
	if binary == "" {
		t.Fatal("ZERO_DESKTOP_BINARY must name the zero binary")
	}
	out := os.Getenv("ZERO_DESKTOP_E2E_OUT")
	if out == "" {
		out = t.TempDir()
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	// Socket paths are short: t.TempDir under a long test name is too long.
	base, err := os.MkdirTemp("", "snv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	w := &world{t: t, out: out, report: map[string]any{}, sock: filepath.Join(base, "a.sock"), daemon: filepath.Join(base, "d.sock")}
	w.project = filepath.Join(base, "project")
	writeFixture(t, w.project)
	w.notices = filepath.Join(base, "notices.jsonl")
	// Validation may supply the app built from the same immutable source snapshot.
	w.bin = os.Getenv("ZERO_DESKTOP_APP_BINARY")
	if w.bin == "" {
		w.bin = filepath.Join(base, "zero-app")
		build := exec.Command("go", "build", "-tags", "e2e", "-o", w.bin, ".")
		build.Dir = ".."
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("building the app: %v\n%s", err, output)
		}
	}
	home := filepath.Join(base, "home")
	w.env = append(os.Environ(),
		"HOME="+home, "XDG_DATA_HOME="+filepath.Join(home, "data"), "XDG_CONFIG_HOME="+filepath.Join(home, "config"), "XDG_CACHE_HOME="+filepath.Join(home, "cache"),
		"XDG_RUNTIME_DIR="+filepath.Join(base, "run"),
		"ZERO_DESKTOP_SOCKET="+w.daemon, "ZERO_DESKTOP_ROOTS_FILE="+filepath.Join(base, "roots.json"),
		"MYGO_AUTOMATION="+w.sock, "MYGO_ENV=production", "ZERO_E2E_NOTICES="+w.notices,
		"ZERO_E2E_DRIVER="+filepath.Join(base, "e.sock"),
	)
	w.driverSock = filepath.Join(base, "e.sock")
	for _, dir := range []string{home, filepath.Join(base, "run")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		stop := exec.Command(binary, "daemon", "stop", "--socket", w.daemon)
		stop.Env = w.env
		_ = stop.Run()
		data, _ := json.MarshalIndent(w.report, "", "  ")
		_ = os.WriteFile(filepath.Join(out, "report.json"), data, 0o644)
	})
	return w, base
}

func TestWebViewApp(t *testing.T) {
	w, base := newWorld(t)
	binary := os.Getenv("ZERO_DESKTOP_BINARY")
	home := filepath.Join(base, "home")

	app := w.launch(w.project)
	app.waitEval("the project's tree", treeShows("README.md"))
	w.report["userAgent"] = app.eval(`return navigator.userAgent`)
	w.report["origin"] = app.eval(`return location.origin`)
	app.capture("workspace.png")

	// Failures in one part leave the others to run: each part reports through
	// its own t.
	parent := t
	run := func(name string, part func(t *testing.T)) {
		parent.Run(name, func(t *testing.T) {
			app.t = t
			defer func() { app.t = parent }()
			part(t)
		})
	}

	run("secure context", func(t *testing.T) {
		if got := app.eval(`return window.isSecureContext`); got != true {
			t.Errorf("isSecureContext = %v", got)
		}
		if got := app.eval(`return typeof crypto.subtle`); got != "object" {
			t.Errorf("crypto.subtle = %v", got)
		}
		app.eval(`localStorage.setItem("e2e-persist", "kept"); return true`)
		w.report["clipboardWrite"] = app.eval(`try { await navigator.clipboard.writeText("e2e"); return "ok" } catch (error) { return String(error) }`)
	})

	// Decision 0184: the page reads the state its window opened with, and
	// the Settings choice reopens the window in the new state on the page it
	// showed: a window of native UI, whose page only the app's own driver
	// reaches, then a page window again.
	run("experimental features", func(t *testing.T) {
		if got := app.eval(`return JSON.stringify(window.zeroDesktop.experimental)`); got != `{"enabled":false,"source":""}` {
			t.Fatalf("experimental = %v, want off with no source", got)
		}
		shell := w.driver(t)
		if got := shell.shells(); got != 0 {
			t.Fatalf("%d windows of native UI before turning experimental features on", got)
		}
		app.eval(`void window.zeroDesktop.setExperimental(true); return true`)
		shell.waitEval("the window of native UI with experimental features on",
			`return window.zeroDesktop?.experimental?.enabled === true && window.zeroDesktop.experimental.source === "setting"`)
		shell.waitEval("the project's tree in the window of native UI", treeShows("README.md"))
		if got := shell.shells(); got != 1 {
			t.Errorf("%d windows of native UI, want 1", got)
		}
		if got := shell.eval(`return new URL(location.href).searchParams.get("project")`); got != w.project {
			t.Errorf("the reopened window shows project %v, want %s", got, w.project)
		}
		// The page works as it did: the proxy serves it, the bridge answers
		// it with its window, and its storage is the connection's.
		if got := shell.eval(`return (await fetch("/api/projects")).status`); got != float64(200) {
			t.Errorf("fetch /api/projects in the window of native UI = %v", got)
		}
		if got := shell.eval(`return typeof (await window.zeroDesktop.diagnostics()).version`); got != "string" {
			t.Errorf("the bridge's diagnostics in the window of native UI = %v", got)
		}
		if got := shell.eval(`return localStorage.getItem("e2e-persist")`); got != "kept" {
			t.Errorf("localStorage in the window of native UI = %v", got)
		}
		if got := shell.eval(`const size = [innerWidth, innerHeight]; return size[0] >= 640 && size[1] >= 400`); got != true {
			t.Errorf("the page does not fill the window of native UI")
		}
		shell.capture("shell-workspace.png")
		// The app's menu still reaches the page.
		if err := app.call("menu", map[string]any{"path": []string{"Help", "Report a Problem…"}}, nil); err != nil {
			t.Errorf("Help > Report a Problem: %v", err)
		}
		shell.waitEval("the problem report from the menu", `return document.querySelector("dialog[open]") !== null`)
		shell.eval(`document.querySelector("dialog[open]")?.close(); return true`)
		// mygo's zoom and reload items do nothing in a window of native UI;
		// the app's own act on its page.
		wide := shell.eval(`return innerWidth`)
		if err := app.call("menu", map[string]any{"path": []string{"View", "Zoom In"}}, nil); err != nil {
			t.Errorf("View > Zoom In: %v", err)
		}
		shell.waitEval("the page zoomed in from the menu", fmt.Sprintf(`return innerWidth < %v`, wide))
		if err := app.call("menu", map[string]any{"path": []string{"View", "Actual Size"}}, nil); err != nil {
			t.Errorf("View > Actual Size: %v", err)
		}
		shell.waitEval("the page at its size again", fmt.Sprintf(`return innerWidth === %v`, wide))
		shell.eval(`window.__e2eLoaded = true; return true`)
		if err := app.call("menu", map[string]any{"path": []string{"View", "Reload"}}, nil); err != nil {
			t.Errorf("View > Reload: %v", err)
		}
		shell.waitEval("the page reloaded from the menu", `return window.__e2eLoaded === undefined && document.readyState === "complete"`)

		shell.eval(`void window.zeroDesktop.setExperimental(false); return true`)
		app.waitEval("the page window with experimental features off",
			`return window.zeroDesktop?.experimental?.enabled === false && window.zeroDesktop.experimental.source === ""`)
		app.waitEval("the project's tree after turning them off", treeShows("README.md"))
		deadline := time.Now().Add(callTimeout)
		for app.windowCount() != 1 && time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
		}
		if got := app.windowCount(); got != 1 {
			t.Errorf("%d windows after reopening twice, want 1", got)
		}
		if got := shell.shells(); got != 0 {
			t.Errorf("%d windows of native UI after turning experimental features off", got)
		}
	})

	run("refusals", func(t *testing.T) {
		// "//x" alone would name another host, which the page's CSP refuses.
		for _, name := range []string{"/_daemon/status", "/%5Fdaemon/status", "//_daemon/status", "/_zero/status", "/x/%2e%2e/_daemon/status", "/_daemon/..%2fstatus", "/_daemon%2f..%2fstatus", "/_zero/..%2fstatus"} {
			got := app.eval(fmt.Sprintf(`return (await fetch(location.origin + %q)).status`, name))
			if got != float64(403) {
				t.Errorf("fetch %s = %v, want 403", name, got)
			}
		}
	})

	run("post bodies arrive", func(t *testing.T) {
		got := app.eval(`const r = await fetch("/api/walkthroughs", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({unknownField: 1})}); return [r.status, await r.text()]`)
		values, _ := got.([]any)
		if len(values) != 2 || values[0] != float64(400) || !strings.Contains(fmt.Sprint(values[1]), "unknownField") {
			t.Errorf("POST answered %v: the server should reject the field it read", got)
		}
	})

	run("bytes", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(w.project, "pic.png"))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		want := hex.EncodeToString(sum[:])
		project := strconv.Quote(w.project)
		for _, endpoint := range []string{"/api/image", "/api/raw"} {
			got := app.eval(`const r = await fetch(` + strconv.Quote(endpoint) + ` + "?project=" + encodeURIComponent(` + project + `) + "&path=pic.png");
				const bytes = await r.arrayBuffer();
				const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
				return [r.status, r.headers.get("content-type"), bytes.byteLength, hash]`)
			values, _ := got.([]any)
			if len(values) != 4 || values[0] != float64(200) || values[1] != "image/png" || values[2] != float64(len(data)) || values[3] != want {
				t.Errorf("%s = %v, want %d bytes with sha256 %s", endpoint, got, len(data), want)
			}
		}
		// The server has no range support and the web asks for none: a Range
		// header passes through and the whole image comes back unchanged.
		ranged := app.eval(`const r = await fetch("/api/raw?project=" + encodeURIComponent(` + project + `) + "&path=pic.png", {headers: {Range: "bytes=0-3"}}); return [r.status, (await r.arrayBuffer()).byteLength]`)
		w.report["rawWithRange"] = ranged
		if values, _ := ranged.([]any); len(values) != 2 || values[1] != float64(len(data)) {
			t.Errorf("/api/raw with Range = %v", ranged)
		}
		// An <img> of the page's own origin, with what CSP says about it.
		image := app.eval(`const violations = [];
			document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective + " " + event.blockedURI));
			const image = new Image();
			image.src = "/api/raw?project=" + encodeURIComponent(` + project + `) + "&path=pic.png";
			await new Promise((resolve) => { image.onload = resolve; image.onerror = resolve });
			await new Promise((resolve) => setTimeout(resolve, 100));
			return [image.naturalWidth, violations]`)
		w.report["sameOriginImage"] = image
		if values, _ := image.([]any); len(values) != 2 || values[0] != float64(4) {
			t.Errorf("img from /api/raw = %v, want naturalWidth 4", image)
		}
	})

	run("event streams", func(t *testing.T) {
		project := strconv.Quote(w.project)
		app.eval(`window.__stream = {events: [], source: new EventSource("/api/events?project=" + encodeURIComponent(` + project + `))};
			for (const name of ["status", "head", "change"]) window.__stream.source.addEventListener(name, (event) => window.__stream.events.push([name, Date.now(), event.data]));
			return true`)
		app.waitEval("the stream's first events", `return window.__stream.events.some((event) => event[0] === "head")`)
		if err := os.WriteFile(filepath.Join(w.project, "live.md"), []byte("# one\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		app.waitEval("a change over the stream", `return window.__stream.events.some((event) => event[0] === "change" && event[2].includes("live.md"))`)
		first := app.eval(`return window.__stream.events.filter((event) => event[0] === "change").length`)
		// A second change while the stream stays open: nothing buffers.
		if err := os.WriteFile(filepath.Join(w.project, "live2.md"), []byte("# two\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		app.waitEval("a second change over the same stream", `return window.__stream.events.some((event) => event[0] === "change" && event[2].includes("live2.md"))`)
		w.report["streamEvents"] = app.eval(`return window.__stream.events.map((event) => [event[0], event[2].slice(0, 60)])`)
		w.report["changesBeforeSecond"] = first
		w.report["streamState"] = app.eval(`return window.__stream.source.readyState`)

		// Closing streams ends their upstream requests within a keepalive tick.
		before := countSocketPeers(t, w.daemon)
		app.eval(`window.__streams = [1, 2, 3].map(() => new EventSource("/api/events?project=" + encodeURIComponent(` + project + `))); return true`)
		app.waitEval("three streams open", `return window.__streams.every((source) => source.readyState === EventSource.OPEN)`)
		time.Sleep(500 * time.Millisecond)
		open := countSocketPeers(t, w.daemon)
		app.eval(`window.__streams.forEach((source) => source.close()); window.__stream.source.close(); return true`)
		closed := time.Now()
		var after int
		for time.Since(closed) < 15*time.Second {
			after = countSocketPeers(t, w.daemon)
			if after <= open-3 {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		w.report["streamCancel"] = map[string]any{"before": before, "open": open, "after": after, "seconds": time.Since(closed).Seconds()}
		if after > open-3 {
			t.Errorf("daemon connections %d with streams, %d after closing: the upstream requests did not end", open, after)
		}
	})

	run("document, highlighting, diagram, links", func(t *testing.T) {
		w.exerciseDocuments(app)
	})

	run("live update reaches the page", func(t *testing.T) {
		app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=README.md"; return true`)
		app.waitEval("the document", `return document.body.innerText.includes("A paragraph.")`)
		file, err := os.OpenFile(filepath.Join(w.project, "README.md"), os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = file.WriteString("\nLive marker from the e2e test.\n")
		_ = file.Close()
		app.waitEval("the changed file in the page", `return document.body.innerText.includes("Live marker from the e2e test.")`)
	})

	run("unchanged focus refresh preserves a cached review and viewport", func(t *testing.T) {
		project := filepath.Join(base, "focus-review")
		writeFixture(t, project)
		writeDiffs := func(version string) {
			t.Helper()
			for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
				var content strings.Builder
				for line := range 360 {
					fmt.Fprintf(&content, "%s %s line %03d\n", name, version, line)
				}
				if err := os.WriteFile(filepath.Join(project, name), []byte(content.String()), 0o644); err != nil {
					t.Fatal(err)
				}
			}
		}
		writeDiffs("before")
		for _, args := range [][]string{{"add", "a.txt", "b.txt", "c.txt"}, {"-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Review fixture"}} {
			git := exec.Command("git", args...)
			git.Dir = project
			if output, err := git.CombinedOutput(); err != nil {
				t.Fatalf("git %v: %v\n%s", args, err, output)
			}
		}
		writeDiffs("after")
		if got := app.eval(`const response = await fetch('/api/roots', {method: 'POST', headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({path: ` + strconv.Quote(project) + `})}); return response.ok`); got != true {
			t.Fatal("could not serve the review fixture")
		}
		// Preserve later scenarios' project even if this regression fails.
		defer func() {
			app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=README.md"; return true`)
			app.waitEval("the original project after the review", `return new URLSearchParams(location.search).get('project') === `+strconv.Quote(w.project)+` && document.body.innerText.includes('A paragraph.')`)
			if got := app.eval(`return (await fetch('/api/roots?path=' + encodeURIComponent(` + strconv.Quote(project) + `), {method: 'DELETE'})).ok`); got != true {
				t.Error("could not remove the review fixture root")
			}
		}()
		// This is the first review in the profile. Its direct URL must load
		// the renderer over zero-app:// from the document session.
		app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(project) + `) + "&review=working#f=a.txt"; return true`)
		app.waitEval("A's rendered review", `return location.origin === "zero-app://local"
			&& (document.querySelector('[data-review-path="a.txt"] .diff-view')?.shadowRoot?.querySelectorAll('[data-line]').length ?? 0) > 0
			&& document.querySelectorAll('[data-review-path]').length === 3`)
		app.eval(`const state = window.__focusReview = {
			fetch: window.fetch, calls: [], completed: [], pending: [], hold: false,
			section: (path) => document.querySelector('[data-review-path="' + path + '"]'),
			pane: document.querySelector('main'),
		};
		state.rows = () => Array.from(state.section('b.txt').querySelector('.diff-view')?.shadowRoot?.querySelectorAll('[data-line]') ?? []);
		state.scrollTo = (path, offset = 2400) => {
			const section = state.section(path);
			state.pane.scrollTop += section.getBoundingClientRect().top - state.pane.getBoundingClientRect().top + offset;
		};
		window.fetch = async (...args) => {
			const input = args[0];
			const url = new URL(typeof input === 'string' ? input : input.url ?? String(input), location.href);
			if (url.pathname !== '/api/diff') return state.fetch.apply(window, args);
			const path = url.searchParams.get('path');
			state.calls.push(path);
			if (state.hold) await new Promise((resolve) => state.pending.push({path, resolve}));
			const response = await state.fetch.apply(window, args);
			state.completed.push(path);
			return response;
		};
		return true`)
		defer app.eval(`const state = window.__focusReview; if (state) {
			state.stop = true; state.hold = false; state.pending.forEach((request) => request.resolve()); window.fetch = state.fetch;
		} return true`)
		// Wait past both the 3 s reveal pin and the 2 s focus throttle.
		time.Sleep(3500 * time.Millisecond)
		// Load the section at its header before scrolling into its interior; an
		// unloaded section has no 2400px interior yet.
		app.eval(`window.__focusReview.scrollTo('b.txt', 0); return true`)
		app.waitEval("B's first rendered diff", `return window.__focusReview.rows().some((row) => row.textContent.includes('b.txt after'))`)
		app.eval(`const state = window.__focusReview;
			state.bReads = state.calls.filter((path) => path === 'b.txt').length;
			state.scrollTo('c.txt', 0); return true`)
		app.waitEval("C's rendered diff", `return (window.__focusReview.section('c.txt').querySelector('.diff-view')?.shadowRoot?.querySelectorAll('[data-line]').length ?? 0) > 0`)
		// C now has content, so scroll into its interior.
		app.eval(`window.__focusReview.scrollTo('c.txt'); return true`)
		app.waitEval("B's rows virtualized outside the viewport", `const state = window.__focusReview;
			return state.rows().length === 0
				&& (state.section('c.txt').querySelector('.diff-view')?.shadowRoot?.querySelectorAll('[data-line]').length ?? 0) > 0`)
		app.eval(`window.__focusReview.scrollTo('b.txt'); return true`)
		app.waitEval("B rendered from cache", `const state = window.__focusReview;
			return state.rows().some((row) => row.textContent.includes('b.txt after'))
				&& state.calls.filter((path) => path === 'b.txt').length === state.bReads`)
		if got := app.eval(`return location.hash`); got != "#f=a.txt" {
			t.Fatalf("scrolling B changed the chosen file: %v", got)
		}
		// xdotool is already required by this harness. X focus None and back
		// produces trusted WebKit blur/focus events without a window manager.
		app.waitEval("native review focus before leaving", `return document.hasFocus()`)
		focused, err := exec.Command("xdotool", "getwindowfocus").Output()
		if err != nil {
			t.Fatalf("xdotool getwindowfocus: %v", err)
		}
		focus := func(window string) {
			t.Helper()
			if output, err := exec.Command("xdotool", "windowfocus", window).CombinedOutput(); err != nil {
				t.Fatalf("xdotool windowfocus %s: %v\n%s", window, err, output)
			}
		}
		focus("0x0")
		defer focus(strings.TrimSpace(string(focused)))
		app.waitEval("native review window blur", `return !document.hasFocus()`)
		time.Sleep(3500 * time.Millisecond)
		app.waitEval("a visible row in B", `const state = window.__focusReview;
			const pane = state.pane.getBoundingClientRect();
			return state.rows().some((row) => row.textContent.includes('b.txt after') && row.getBoundingClientRect().top > pane.top + 80 && row.getBoundingClientRect().bottom < pane.bottom)`)
		app.eval(`const state = window.__focusReview;
			const pane = state.pane.getBoundingClientRect();
			const row = state.rows().find((row) => row.textContent.includes('b.txt after') && row.getBoundingClientRect().top > pane.top + 80 && row.getBoundingClientRect().bottom < pane.bottom);
			state.baseline = {scroll: state.pane.scrollTop, height: state.section('b.txt').offsetHeight, text: row.textContent, top: row.getBoundingClientRect().top};
			state.bCompleted = state.completed.filter((path) => path === 'b.txt').length;
			state.hold = true; state.frames = 0; state.failures = []; state.focusEvents = [];
			window.addEventListener('focus', (event) => state.focusEvents.push(event.isTrusted));
			state.sample = () => {
				const row = state.rows().find((row) => row.textContent === state.baseline.text);
				const sample = {scroll: state.pane.scrollTop, height: state.section('b.txt').offsetHeight,
					top: row?.getBoundingClientRect().top ?? null, loading: state.section('b.txt').textContent.includes('Loading diff'), hash: location.hash};
				if (Math.abs(sample.scroll - state.baseline.scroll) > 2 || Math.abs(sample.height - state.baseline.height) > 2
					|| sample.top === null || Math.abs(sample.top - state.baseline.top) > 2 || sample.loading || sample.hash !== '#f=a.txt') {
					if (state.failures.length < 10) state.failures.push(sample);
				}
				state.frames++;
			};
			const frame = () => { if (!state.stop) { state.sample(); requestAnimationFrame(frame); } };
			requestAnimationFrame(frame); return true`)
		focus(strings.TrimSpace(string(focused)))
		app.waitEval("trusted native focus and B's pending refetch", `const state = window.__focusReview;
			return document.hasFocus() && state.focusEvents.includes(true) && state.pending.some((request) => request.path === 'b.txt')`)
		time.Sleep(750 * time.Millisecond)
		if got := app.eval(`const state = window.__focusReview; state.sample();
			return state.failures.length === 0 && state.frames > 5 && state.completed.filter((path) => path === 'b.txt').length === state.bCompleted`); got != true {
			t.Errorf("review changed with diff refetch pending: %v", app.eval(`return {baseline: window.__focusReview.baseline, failures: window.__focusReview.failures, frames: window.__focusReview.frames}`))
		}
		app.eval(`const state = window.__focusReview; state.hold = false; state.pending.forEach((request) => request.resolve()); return true`)
		app.waitEval("B's unchanged refetch completed", `const state = window.__focusReview;
			return state.completed.filter((path) => path === 'b.txt').length > state.bCompleted`)
		time.Sleep(time.Second)
		w.report["reviewFocusRefresh"] = app.eval(`const state = window.__focusReview; state.sample(); state.stop = true;
			return {baseline: state.baseline, frames: state.frames, failures: state.failures, focusEvents: state.focusEvents, calls: state.calls, completed: state.completed}`)
		if got := app.eval(`return window.__focusReview.failures.length === 0`); got != true {
			t.Errorf("unchanged focus refresh moved or replaced the rendered review: %v", w.report["reviewFocusRefresh"])
		}
		app.capture("review-focus-refresh.png")
	})

	run("native title bar outside macOS", func(t *testing.T) {
		// Decision 0119: only macOS hides the title bar, so the page's band
		// has no height here and the workspace starts at the top.
		got := app.eval(`const band = document.querySelector(".title-bar"); return [band !== null, band ? band.getBoundingClientRect().height : -1, getComputedStyle(document.documentElement).getPropertyValue("--mygo-titlebar-height").trim()]`)
		if values, _ := got.([]any); len(values) != 3 || values[0] != true || values[1] != float64(0) || (values[2] != "" && values[2] != "0px") {
			t.Errorf("title band [present, height, --mygo-titlebar-height] = %v; want [true 0 none]", got)
		}
	})

	run("bridge", func(t *testing.T) {
		if got := app.eval(`return window.zeroDesktop.version`); got != float64(2) {
			t.Errorf("bridge version = %v", got)
		}
		if got := app.eval(`return typeof window.zeroDesktop.openFolder`); got != "undefined" {
			t.Errorf("typeof openFolder = %v; the page browses for folders itself (decision 0146)", got)
		}
		if got := app.eval(`return typeof window.zeroDesktop.setAppearance`); got != "function" {
			t.Errorf("setAppearance = %v", got)
		}
		if got := app.eval(`try { await window.mygo.call("Bridge.SetAppearance", "dark"); return "resolved" } catch (error) { return String(error) }`); got != "resolved" {
			t.Errorf("SetAppearance(dark) = %v", got)
		}
		refused := func(script string) {
			t.Helper()
			got := app.eval(`try { return ["resolved", await ` + script + `] } catch (error) { return ["rejected", String(error)] }`)
			if values, _ := got.([]any); len(values) != 2 || values[0] != "rejected" {
				t.Errorf("%s = %v, want a refusal", script, got)
			}
		}
		refused(`window.mygo.call("Bridge.SetAppearance", "auto")`)
		refused(`window.mygo.call("Bridge.SetAppearance", 1)`)
		refused(`window.zeroDesktop.revealPath("relative", "a")`)
		refused(`window.zeroDesktop.revealPath(` + strconv.Quote(w.project) + `, "../escape")`)
		refused(`window.zeroDesktop.showContextMenu([], 1, 1)`)
		refused(`window.zeroDesktop.showContextMenu([{id: "a b", label: "A"}], 1, 1)`)
		refused(`window.zeroDesktop.showContextMenu([{id: "a", label: "A"}], -1, 1)`)
		if got := app.eval(`return await window.zeroDesktop.revealPath(` + strconv.Quote(w.project) + `, "README.md")`); got != true {
			t.Errorf("revealPath of a served file = %v", got)
		}
		outside := filepath.Join(w.project, "escape")
		if err := os.Symlink("/etc/hostname", outside); err != nil {
			t.Fatal(err)
		}
		if got := app.eval(`return await window.zeroDesktop.revealPath(` + strconv.Quote(w.project) + `, "escape")`); got != false {
			t.Errorf("revealPath through a symlink out of the project = %v", got)
		}
		app.eval(`window.__chosen = "pending"; void window.zeroDesktop.showContextMenu([{id: "first", label: "First"}, {separator: true}, {id: "second", label: "Second"}], 40, 40).then((id) => { window.__chosen = id }); return true`)
		time.Sleep(time.Second)
		app.capture("context-menu.png")
		key := exec.Command("xdotool", "key", "--delay", "100", "Down", "Return")
		if output, err := key.CombinedOutput(); err != nil {
			t.Fatalf("xdotool: %v\n%s", err, output)
		}
		app.waitEval("the chosen menu item", `return window.__chosen !== "pending"`)
		w.report["contextMenuChosen"] = app.eval(`return window.__chosen`)
		if got := app.eval(`return window.__chosen`); got != "first" {
			t.Errorf("chosen = %v, want first", got)
		}
	})

	readme := `"/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=README.md"`
	run("navigation stays in the app", func(t *testing.T) {
		app.eval(`location.href = ` + readme + `; return true`)
		app.waitEval("the document", `return document.body.innerText.includes("A paragraph.")`)
		before := app.eval(`return location.href`)
		for _, target := range []string{"https://example.invalid/out", "file:///etc/hostname"} {
			app.eval(`location.href = ` + strconv.Quote(target) + `; return true`)
			time.Sleep(1500 * time.Millisecond)
			if got := app.eval(`return location.href`); got != before {
				t.Errorf("navigating to %s left the page at %v", target, got)
			}
		}
		// The app's own scheme routes to the window, as a link does.
		app.eval(`location.href = "zero://local/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=main.go"; return true`)
		app.waitEval("the link's document", `return location.origin + location.pathname === "zero-app://local/view" && location.search.includes("path=main.go")`)
	})

	run("bridge refuses other pages of the origin", func(t *testing.T) {
		app.eval(`location.href = "/api/projects"; return true`)
		app.waitEval("the JSON page", `return location.pathname === "/api/projects" && document.readyState === "complete" && window.zeroDesktop !== undefined`)
		got := app.eval(`try { return ["resolved", await window.zeroDesktop.revealPath(` + strconv.Quote(w.project) + `, "README.md")] } catch (error) { return ["rejected", String(error)] }`)
		if values, _ := got.([]any); len(values) != 2 || values[0] != "rejected" {
			t.Errorf("revealPath from /api/projects = %v, want a refusal", got)
		}
		w.report["bridgeFromOtherPage"] = got
	})

	run("bridge refuses a raw file", func(t *testing.T) {
		app.eval(`location.href = "/api/raw?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=pic.png"; return true`)
		// The raw page's sandbox may stop scripts: nothing to wait on there.
		time.Sleep(2 * time.Second)
		got, err := app.evalErr(`try { return ["resolved", await window.zeroDesktop.revealPath(` + strconv.Quote(w.project) + `, "README.md")] } catch (error) { return ["rejected", String(error)] }`)
		w.report["bridgeFromRaw"] = fmt.Sprint(got, " ", err)
		if values, _ := got.([]any); len(values) == 2 && values[0] == "resolved" {
			t.Errorf("revealPath from /api/raw = %v, want a refusal", got)
		}
		// Back through a link, which needs no script in the page.
		second := exec.Command(w.bin, "zero://local/view?project="+urlEscape(w.project)+"&path=README.md")
		second.Env = w.env
		if output, err := second.CombinedOutput(); err != nil {
			t.Fatalf("second instance: %v\n%s", err, output)
		}
		app.waitEval("the page after the link", treeShows("README.md"))
	})

	run("opening a folder after the daemon idled out", func(t *testing.T) {
		// A page without event streams: nothing else ensures the daemon.
		app.eval(`location.href = "/api/projects"; return true`)
		app.waitEval("the JSON page", `return location.pathname === "/api/projects" && document.readyState === "complete"`)
		stop := exec.Command(binary, "daemon", "stop", "--socket", w.daemon)
		stop.Env = w.env
		if output, err := stop.CombinedOutput(); err != nil {
			t.Fatalf("daemon stop: %v\n%s", err, output)
		}
		second := exec.Command(w.bin, w.project)
		second.Env = w.env
		if output, err := second.CombinedOutput(); err != nil {
			t.Errorf("second instance: %v\n%s", err, output)
		}
		// The landing page goes on to the project's last tab.
		app.waitEval("the folder's project", `return location.pathname !== "/api/projects" && location.search.includes("project=")`)
	})

	// Screen comments (decisions 0175, 0176, 0177, 0180): a page of the
	// developer's app opens in a guest window of its own that reaches nothing
	// of Zero's; Comment on Screen (F8) takes its facts, hit map, and frame
	// while it still has focus and hands them to the local window.
	run("Review URL opens a guest window whose screen reaches the local window", func(t *testing.T) {
		fixture, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "review", "guest", "index.html"))
		if err != nil {
			t.Fatal(err)
		}
		guest := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = response.Write(fixture)
		}))
		defer guest.Close()
		local := app.windowOn(proxyOrigin("local"))
		app.target = local
		defer func() { app.target = 0 }()
		if got := app.eval(`return typeof window.zeroDesktop.openReview`); got != "function" {
			t.Fatalf("openReview = %v", got)
		}
		app.eval(`window.zeroDesktop.openReview(` + strconv.Quote(w.project) + `, ` + strconv.Quote(guest.URL+"/settings") + `); return true`)
		review := app.waitWindow(guest.URL)
		if review == local {
			t.Fatal("the page opened in the local window")
		}
		app.target = review
		app.waitEval("the guest page and its script", `return document.title === "Review fixture" && typeof window.__zeroReview === "object" && typeof window.__fixture === "object"`)
		if got := app.eval(`return typeof window.zeroDesktop`); got != "undefined" {
			t.Errorf("guest page: zeroDesktop is %v, want no bridge", got)
		}
		// The guest's requests to the app's scheme carry no Origin; the proxy
		// refuses them by their page.
		reached := app.eval(`const image = new Image();
			image.src = "zero-app://local/api/image?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=pic.png";
			return await new Promise((resolve) => { image.onload = () => resolve("loaded"); image.onerror = () => resolve("refused") })`)
		if reached != "refused" {
			t.Errorf("a guest image from zero-app = %v, want refused", reached)
		}
		for _, window := range app.listWindows().Windows {
			if window.ID == review && !strings.Contains(window.Title, "/settings · "+filepath.Base(w.project)+" · ") {
				t.Errorf("guest window title %q", window.Title)
			}
		}

		// The test stands in for the composer: it keeps the event from the
		// web app, which would take the capture first.
		app.target = local
		app.eval(`window.__screenComment = 0
			window.addEventListener("zero:screen-comment", (event) => { event.stopImmediatePropagation(); window.__screenComment++ }, { capture: true })
			return true`)

		// focusGuest gives the guest window the keyboard, as it has when the
		// developer presses F8, so its menu is open until Zero comes forward.
		focusGuest := func() {
			t.Helper()
			found, err := exec.Command("xdotool", "search", "--onlyvisible", "--name", regexp.QuoteMeta("/settings · "+filepath.Base(w.project)+" · ")).Output()
			ids := strings.Fields(string(found))
			if err != nil || len(ids) == 0 {
				t.Fatalf("xdotool search for the guest window: %v %q", err, found)
			}
			if output, err := exec.Command("xdotool", "windowfocus", "--sync", ids[len(ids)-1]).CombinedOutput(); err != nil {
				t.Fatalf("xdotool windowfocus: %v\n%s", err, output)
			}
			app.target = review
			app.waitEval("the guest window's focus", `return document.hasFocus()`)
		}
		comments := 0
		// captureScreen chooses Comment on Screen in the focused guest window
		// and takes the capture the local window receives, saving its frame
		// as name.
		captureScreen := func(name string) (screenCapture, image.Image) {
			t.Helper()
			focusGuest()
			if err := app.call("menu", map[string]any{"window": review, "path": []string{"Review", "Comment on Screen"}}, nil); err != nil {
				t.Fatal(err)
			}
			comments++
			app.target = local
			app.waitEval("the screen comment in the local window", `return window.__screenComment === `+strconv.Itoa(comments))
			raw := app.eval(`return JSON.stringify(await window.zeroDesktop.screenCapture())`)
			var capture screenCapture
			text, _ := raw.(string)
			if err := json.Unmarshal([]byte(text), &capture); err != nil {
				t.Fatalf("screenCapture() = %.200v: %v", raw, err)
			}
			if strings.Contains(text, "hunter2") {
				t.Error("the capture holds the password field's value")
			}
			frame, err := base64.StdEncoding.DecodeString(capture.PNG)
			if err != nil {
				t.Fatal(err)
			}
			_ = os.WriteFile(filepath.Join(os.Getenv("ZERO_DESKTOP_E2E_OUT"), name), frame, 0o644)
			decoded, err := png.Decode(bytes.NewReader(frame))
			if err != nil {
				t.Fatal(err)
			}
			page := capture.Page
			scale := page.Viewport.DeviceScaleFactor
			if size := decoded.Bounds().Size(); size.X != int(math.Round(float64(page.Viewport.Width)*scale)) || size.Y != int(math.Round(float64(page.Viewport.Height)*scale)) {
				t.Errorf("capture is %dx%d, want the %dx%d viewport at %v", size.X, size.Y, page.Viewport.Width, page.Viewport.Height, scale)
			}
			if capture.Project != w.project || page.URL != guest.URL+"/settings" || page.Title != "Review fixture" || scale <= 0 {
				t.Errorf("capture = %s %+v", capture.Project, page)
			}
			if capture.Hits == nil {
				t.Fatal("the capture has no hit map")
			}
			return capture, decoded
		}

		// A transient menu (decision 0180): it closes when the window loses
		// focus, so the capture must hold it, in both the hit map and the
		// pixels, before Zero's window takes focus.
		app.target = review
		app.eval(`window.__fixture.openMenu(); return true`)
		capture, frame := captureScreen("screen-capture-menu.png")
		if capture.Drift {
			t.Error("the still fixture page drifted while it was captured")
		}
		for selector, want := range map[string]screenRect{
			`[data-testid="project-menu"]`:     {X: 8, Y: 8, Width: 120, Height: 32},
			`[data-testid="menu-rename"]`:      {X: 12, Y: 48, Width: 212, Height: 32},
			`[data-testid="menu-delete"]`:      {X: 12, Y: 80, Width: 212, Height: 32},
			`[data-testid="card-a"]`:           {X: 40, Y: 120, Width: 200, Height: 120},
			`[data-testid="clipped-dropdown"]`: {X: 60, Y: 340, Width: 200, Height: 40},
			`[data-testid="chart"]`:            {X: 800, Y: 120, Width: 320, Height: 200},
		} {
			element := capture.Hits.bySelector(selector)
			if element == nil || element.Box == nil || *element.Box != want {
				t.Errorf("%s in the hit map = %+v, want its box %+v", selector, element, want)
			}
		}
		if element := capture.Hits.bySelector(`[data-testid="menu-delete"]`); element == nil || element.Role != "menuitem" || element.Name != "Delete project" || !element.Meaningful {
			t.Errorf("the menu item = %+v", element)
		}
		// The gap between the cards answers the cards' row.
		if element := capture.Hits.at(270, 180); element == nil || element.Selector != `[data-testid="cards"]` {
			t.Errorf("the gap between the cards = %+v, want the row", element)
		}
		// Screenshot and hit map agree: each box shows its element's color.
		scale := capture.Page.Viewport.DeviceScaleFactor
		for selector, want := range map[string][3]uint8{
			`[data-testid="project-menu"]`:     {60, 90, 200},
			`[data-testid="menu-delete"]`:      {200, 30, 90},
			`[data-testid="menu-rename"]`:      {230, 230, 240},
			`[data-testid="card-a"]`:           {90, 170, 110},
			`[data-testid="clipped-dropdown"]`: {120, 60, 180},
			`[data-testid="chart"]`:            {20, 150, 160},
		} {
			if element := capture.Hits.bySelector(selector); element != nil && element.Box != nil {
				checkPixel(t, frame, selector, float64(element.Box.X+3)*scale, float64(element.Box.Y+3)*scale, want)
			}
		}
		checkPixel(t, frame, "the gap", 270*scale, 180*scale, [3]uint8{235, 238, 245})
		// The guest loses focus only after the capture, and its menu closes
		// then. Xvfb has no window manager to move X focus when Zero's window
		// comes forward, so the test moves it.
		if output, err := exec.Command("xdotool", "windowfocus", "0x0").CombinedOutput(); err != nil {
			t.Fatalf("xdotool windowfocus: %v\n%s", err, output)
		}
		app.target = review
		app.waitEval("the guest menu closed by the focus change", `return !window.__fixture.menuOpen && window.__fixture.blurs > 0`)
		w.report["screenCapture"] = map[string]any{"elements": len(capture.Hits.Elements), "step": capture.Hits.Step, "deviceScaleFactor": scale}

		app.target = local
		if again := app.eval(`return await window.zeroDesktop.screenCapture()`); again != nil {
			t.Errorf("a second screenCapture() = %.80v, want null: a capture is taken once", again)
		}
		if got := app.eval(`return typeof window.zeroDesktop.screenElement`); got != "undefined" {
			t.Errorf("screenElement = %v, want none: the hit map answers", got)
		}

		// A scrolled page: boxes are in the viewport, and the scroll is the page's.
		app.target = review
		app.eval(`scrollTo(0, 700); return true`)
		scrolled, scrolledFrame := captureScreen("screen-capture-scrolled.png")
		if scrolled.Page.Scroll.Y != 700 {
			t.Errorf("scroll = %+v, want 700 down", scrolled.Page.Scroll)
		}
		far := scrolled.Hits.bySelector(`[data-testid="far"]`)
		if far == nil || far.Box == nil || *far.Box != (screenRect{X: 40, Y: 300, Width: 160, Height: 40}) {
			t.Errorf("the far button = %+v, want its box in the viewport", far)
		} else {
			checkPixel(t, scrolledFrame, "the far button", float64(far.Box.X+3)*scale, float64(far.Box.Y+3)*scale, [3]uint8{240, 120, 20})
		}

		if err := app.call("menu", map[string]any{"window": review, "path": []string{"Page", "Close Window"}}, nil); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(pageTimeout)
		for app.windowOn(guest.URL) != 0 {
			if time.Now().After(deadline) {
				t.Fatal("the guest window did not close")
			}
			time.Sleep(100 * time.Millisecond)
		}
	})

	// The Browser tab (decision 0181): the local window reads and drives the
	// project's guest window through the bridge and hears of its changes.
	run("the Browser tab drives the project's guest window", func(t *testing.T) {
		site := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			response.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(response, `<!doctype html><title>`+request.URL.Path+`</title><a href="/two">Two</a>`)
		}))
		defer site.Close()
		secure := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(response, "secure")
		}))
		defer secure.Close()
		closed, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		closedURL := "http://" + closed.Addr().String() + "/"
		_ = closed.Close()

		local := app.windowOn(proxyOrigin("local"))
		app.target = local
		defer func() { app.target = 0 }()
		project := strconv.Quote(w.project)
		state := `(await window.zeroDesktop.browserState(` + project + `))`
		if got := app.eval(`return typeof window.zeroDesktop.browserState + " " + typeof window.zeroDesktop.browserAction`); got != "function function" {
			t.Fatalf("bridge methods = %v", got)
		}
		app.waitEval("no guest window yet", `return `+state+` === null`)
		app.eval(`window.__browserEvents = []
			window.__browserFocus = []
			window.addEventListener("zero:browser", (event) => window.__browserEvents.push(event.detail))
			window.addEventListener("zero:browser-focus", (event) => { event.stopImmediatePropagation(); window.__browserFocus.push(event.detail) }, { capture: true })
			return true`)

		app.eval(`window.zeroDesktop.openReview(` + project + `, ` + strconv.Quote(site.URL+"/one") + `); return true`)
		guest := app.waitWindow(site.URL)
		app.waitEval("the first page's state", `const s = `+state+`; return s?.url === `+strconv.Quote(site.URL+"/one")+` && !s.loading && !s.canGoBack && !s.canGoForward && s.failure === null`)
		app.waitEval("a zero:browser event for the project", `return window.__browserEvents.includes(`+project+`)`)

		app.target = guest
		if got := app.eval(`return typeof window.zeroDesktop`); got != "undefined" {
			t.Errorf("guest page reaches %v, want no bridge", got)
		}
		app.eval(`document.querySelector("a").click(); return true`)
		app.target = local
		app.waitEval("the second page's state", `const s = `+state+`; return s?.url === `+strconv.Quote(site.URL+"/two")+` && !s.loading && s.canGoBack && !s.canGoForward`)

		app.eval(`await window.zeroDesktop.browserAction(` + project + `, "back"); return true`)
		app.waitEval("back on the first page", `const s = `+state+`; return s?.url === `+strconv.Quote(site.URL+"/one")+` && !s.loading && !s.canGoBack && s.canGoForward`)

		// A page asking for the app's scheme is refused, and the failure
		// names only the scheme and host.
		app.target = guest
		app.eval(`location.href = "zero-app://local/view?project=/secret"; return true`)
		app.target = local
		app.waitEval("the refused navigation", `const s = `+state+`; return s?.failure?.kind === "refused" && s.failure.url === "zero-app://local" && s.url === `+strconv.Quote(site.URL+"/one"))
		app.eval(`await window.zeroDesktop.browserAction(` + project + `, "reload"); return true`)
		app.waitEval("a reload clears the failure", `const s = `+state+`; return s?.failure === null && !s.loading`)

		app.eval(`await window.zeroDesktop.openReview(` + project + `, ` + strconv.Quote(closedURL) + `); return true`)
		app.waitEval("the failed load", `const s = `+state+`; return s?.failure?.kind === "load" && s.failure.url === `+strconv.Quote(closedURL)+` && s.failure.description !== "" && !s.loading`)
		app.eval(`await window.zeroDesktop.openReview(` + project + `, ` + strconv.Quote(secure.URL+"/") + `); return true`)
		app.waitEval("the refused certificate", `const s = `+state+`; return s?.failure?.kind === "certificate" && s.failure.url === `+strconv.Quote(secure.URL+"/")+` && !s.loading`)
		app.eval(`await window.zeroDesktop.openReview(` + project + `, ` + strconv.Quote(site.URL+"/one") + `); return true`)
		app.waitEval("a new page clears the failure", `const s = `+state+`; return s?.url === `+strconv.Quote(site.URL+"/one")+` && s.failure === null && !s.loading`)

		if got := app.eval(`return await window.zeroDesktop.browserAction(` + project + `, "navigate").then(() => "done", () => "refused")`); got != "refused" {
			t.Errorf("an unknown action = %v, want refused", got)
		}
		if got := app.eval(`return await window.zeroDesktop.browserAction("/no/such/project", "back").then(() => "done", () => "refused")`); got != "done" {
			t.Errorf("an action for a project without a window = %v, want a no-op", got)
		}
		if got := app.eval(`return await window.zeroDesktop.browserState("relative").then(() => "done", () => "refused")`); got != "refused" {
			t.Errorf("a relative project = %v, want refused", got)
		}

		// Open Location… in the guest window hands the keyboard to the tab.
		if err := app.call("menu", map[string]any{"window": guest, "path": []string{"Page", "Open Location…"}}, nil); err != nil {
			t.Fatal(err)
		}
		app.waitEval("zero:browser-focus for the project", `return window.__browserFocus.length === 1 && window.__browserFocus[0] === `+project)

		app.eval(`window.__browserEvents = []; await window.zeroDesktop.browserAction(` + project + `, "close"); return true`)
		deadline := time.Now().Add(pageTimeout)
		for app.windowOn(site.URL) != 0 {
			if time.Now().After(deadline) {
				t.Fatal("the guest window did not close")
			}
			time.Sleep(100 * time.Millisecond)
		}
		app.waitEval("no guest window after close", `return `+state+` === null && window.__browserEvents.includes(`+project+`)`)
	})

	run("a crashed page reloads once, then says so", func(t *testing.T) {
		app.waitEval("the page", treeShows("README.md"))
		w.killWebProcess(t, app.cmd.Process.Pid)
		app.waitEval("the page after one crash", treeShows("README.md"))
		w.killWebProcess(t, app.cmd.Process.Pid)
		app.waitEval("the crash page", `return document.body.innerText.includes("crashed")`)
		app.capture("crashed.png")
		app.eval(`document.querySelector("a").click(); return true`)
		app.waitEval("the page after Try again", treeShows("README.md"))
	})

	app.stop()

	// Decision 0184: ZERO_EXPERIMENTAL=1 opens the first window as native
	// UI, and the setting says the environment decided.
	t.Run("the environment turns experimental features on", func(t *testing.T) {
		w.t = t
		w.env = append(w.env, "ZERO_EXPERIMENTAL=1")
		defer func() { w.env = w.env[:len(w.env)-1] }()
		app := w.launch(w.project)
		defer app.stop()
		shell := w.driver(t)
		shell.waitEval("the project's tree", treeShows("README.md"))
		if got := shell.eval(`return JSON.stringify(window.zeroDesktop.experimental)`); got != `{"enabled":true,"source":"env"}` {
			t.Errorf("experimental = %v, want on by the environment", got)
		}
		if got := shell.shells(); got != 1 {
			t.Errorf("%d windows of native UI, want 1", got)
		}
		// The setting cannot turn off what the environment decided.
		if got := shell.eval(`return JSON.stringify(await window.zeroDesktop.setExperimental(false))`); got != `{"enabled":true,"source":"env"}` {
			t.Errorf("setExperimental(false) under ZERO_EXPERIMENTAL=1 = %v", got)
		}
		// A crashed page comes back in a window of native UI too.
		w.killWebProcess(t, app.cmd.Process.Pid)
		shell.waitEval("the page after a crash", treeShows("README.md"))
	})

	t.Run("state survives a restart", func(t *testing.T) {
		w.t = t
		// The install scripts replace only zero-app/app and keep the rest,
		// so the page's state must be beside it, where they expect it.
		stored := storageFiles(t, home)
		w.report["storageFiles"] = stored
		if len(stored) == 0 {
			t.Error("no localStorage files found")
		}
		for _, file := range stored {
			if !strings.HasPrefix(file, filepath.Join("data", "zero-app", "localstorage")+string(filepath.Separator)) {
				t.Errorf("localStorage at %s", file)
			}
		}
		app := w.launch(w.project)
		defer app.stop()
		app.waitEval("the page", treeShows("README.md"))
		if got := app.eval(`return localStorage.getItem("e2e-persist")`); got != "kept" {
			t.Errorf("localStorage after restart = %v", got)
		}
		app.waitEval("the restored tabs", `return Array.from(document.querySelectorAll("[role=tab]")).some((tab) => tab.textContent.includes("main.go"))`)
		app.capture("restored.png")
	})

	// zeroGate runs the real binary, failing or slow at `daemon ensure` while
	// the files beside it say so.
	gate := filepath.Join(base, "zero-gate")
	gateClosed, gateSlow := filepath.Join(base, "gate-closed"), filepath.Join(base, "gate-slow")
	script := "#!/bin/sh\nif [ \"$1 $2\" = \"daemon ensure\" ]; then\n  if [ -e " + gateClosed + " ]; then echo 'gate closed' >&2; exit 1; fi\n  if [ -e " + gateSlow + " ]; then sleep 4; fi\nfi\nexec " + binary + " \"$@\"\n"
	if err := os.WriteFile(gate, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	isolate := func(name string) {
		home := filepath.Join(base, name)
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
		w.daemon = filepath.Join(base, name+".sock")
		w.env = append(w.env, "ZERO_DESKTOP_BINARY="+gate, "HOME="+home, "XDG_DATA_HOME="+filepath.Join(home, "data"), "XDG_CONFIG_HOME="+filepath.Join(home, "config"), "XDG_CACHE_HOME="+filepath.Join(home, "cache"),
			"ZERO_DESKTOP_SOCKET="+w.daemon, "ZERO_DESKTOP_ROOTS_FILE="+filepath.Join(base, name+"-roots.json"))
		t.Cleanup(func() {
			stop := exec.Command(binary, "daemon", "stop", "--socket", filepath.Join(base, name+".sock"))
			stop.Env = w.env
			_ = stop.Run()
		})
	}

	// useHandler makes w a home where the built app handles zero:// links
	// (real xdg-mime and xdg-open), with the CLI's default socket and roots.
	useHandler := func(t *testing.T, name string) {
		t.Helper()
		home := filepath.Join(base, name)
		dataHome := filepath.Join(home, "data")
		if err := os.MkdirAll(filepath.Join(dataHome, "applications"), 0o700); err != nil {
			t.Fatal(err)
		}
		entry := "[Desktop Entry]\nType=Application\nName=Zero\nExec=" + w.bin + " %U\nTerminal=false\nMimeType=x-scheme-handler/zero;\n"
		if err := os.WriteFile(filepath.Join(dataHome, "applications", "zero-app.desktop"), []byte(entry), 0o644); err != nil {
			t.Fatal(err)
		}
		// The CLI knows only the default socket and roots: so must the app here.
		run := filepath.Join(base, name+"-r")
		if err := os.MkdirAll(run, 0o700); err != nil {
			t.Fatal(err)
		}
		w.env = append(w.env, "ZERO_DESKTOP_BINARY="+binary, "HOME="+home, "XDG_DATA_HOME="+dataHome, "XDG_CONFIG_HOME="+filepath.Join(home, "config"),
			"XDG_CACHE_HOME="+filepath.Join(home, "cache"), "XDG_RUNTIME_DIR="+run, "ZERO_DESKTOP_SOCKET=", "ZERO_DESKTOP_ROOTS_FILE=", "TMPDIR="+base,
			"SSH_CONNECTION=", "SSH_CLIENT=", "SSH_TTY=")
		t.Cleanup(func() {
			stop := exec.Command(binary, "daemon", "stop")
			stop.Env = w.env
			_ = stop.Run()
		})
		register := exec.Command("xdg-mime", "default", "zero-app.desktop", "x-scheme-handler/zero")
		register.Env = w.env
		if output, err := register.CombinedOutput(); err != nil {
			t.Fatalf("xdg-mime default: %v\n%s", err, output)
		}
		query := exec.Command("xdg-mime", "query", "default", "x-scheme-handler/zero")
		query.Env = w.env
		if output, err := query.CombinedOutput(); err != nil || strings.TrimSpace(string(output)) != "zero-app.desktop" {
			t.Fatalf("xdg-mime query = %q, %v", output, err)
		}
	}

	// The way users get here: `zero <dir>` asks the OS for the zero://
	// handler and the running app takes the link.
	t.Run("zero opens a folder through the zero handler", func(t *testing.T) {
		w.t = t
		useHandler(t, "handler")
		app := w.launch()
		defer app.stop()
		other := filepath.Join(base, "handler project")
		writeFixture(t, other)
		cli := exec.Command(binary, other)
		cli.Env = w.env
		output, err := cli.CombinedOutput()
		w.report["cliOpen"] = string(output)
		if err != nil {
			t.Fatalf("zero %s: %v\n%s", other, err, output)
		}
		if !strings.Contains(string(output), "opened "+other+" in zero") || strings.Contains(string(output), "browser mode") {
			t.Errorf("zero printed %q", output)
		}
		app.waitEval("the folder's project in the window", `return location.origin === "zero-app://local" && new URLSearchParams(location.search).get("project") === `+strconv.Quote(other))
		app.waitEval("the project's tree", treeShows("README.md"))
		app.capture("cli-open.png")
	})

	const browsing = `const input = document.querySelector('dialog[open] input[aria-label="Folder path"]'); return input !== null && input.value.startsWith("/") && input.value.endsWith("/")`
	t.Run("a first launch with no folder offers to open one", func(t *testing.T) {
		w.t = t
		isolate("empty")
		app := w.launch()
		defer app.stop()
		app.waitEval("the no folder state", `return document.body.innerText.includes("No folder is open.") && !document.body.innerText.includes("invalid page")`)
		app.waitEval("a status bar without an error", `return document.querySelector(".status-state").textContent.trim() === "Ready"`)
		app.capture("no-folder.png")
		app.eval(`[...document.querySelectorAll("button")].find((button) => button.textContent === "Open a folder").click(); return true`)
		app.waitEval("the picker's Open Folder", `return document.body.innerText.includes("No projects yet.")`)
		app.capture("no-folder-picker.png")
		// The picker browses the daemon's disk from home (decision 0146).
		app.eval(`[...document.querySelectorAll("button")].find((button) => button.textContent === "Open folder…").click(); return true`)
		app.waitEval("Browse at home", browsing)
		app.capture("no-folder-browse.png")
	})

	t.Run("keyboard shortcuts with the sidebar hidden", func(t *testing.T) {
		w.t = t
		// A fresh WebKit profile keeps earlier scenarios' dialog assets out
		// of this document's first opens.
		isolate("hidden-sidebar")
		app := w.launch(w.project)
		defer app.stop()
		app.waitEval("the project's tree", treeShows("README.md"))
		app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=main.go"; return true`)
		app.waitEval("the source document", `return location.origin === "zero-app://local" && document.querySelector("main")?.innerText.includes("func main()") === true`)
		app.eval(`document.querySelector("main").focus(); return true`)
		app.waitEval("the focused document pane", `return document.hasFocus() && document.activeElement.matches("main")`)

		xdotool := func(args ...string) {
			t.Helper()
			if output, err := exec.Command("xdotool", args...).CombinedOutput(); err != nil {
				t.Fatalf("xdotool %v: %v\n%s", args, err, output)
			}
		}
		press := func(key string) {
			t.Helper()
			xdotool("key", "--clearmodifiers", key)
		}
		const sidebarHidden = `return document.querySelector('[data-sidebar="hidden"]') !== null`
		const focusReturned = `return !document.querySelector("dialog[open]") && document.activeElement.matches("main")`
		press("ctrl+b")
		app.waitEval("the hidden sidebar", sidebarHidden)

		// File › Open Folder… must enter Browse on the first open.
		press("ctrl+o")
		app.waitEval("Browse from the menu", browsing)
		press("Escape")
		app.waitEval("focus returned from Open Folder", focusReturned)

		press("ctrl+comma")
		app.waitEval("the focused Settings search", `return document.activeElement.matches('dialog[open] input[aria-label="Search settings"]')`)
		press("Escape")
		app.waitEval("focus returned from Settings", focusReturned)
		app.exerciseProblemReport("local")

		press("F1")
		app.waitEval("the focused Command field", `return document.activeElement.matches('dialog[open] [role="combobox"][aria-label="Command"]')`)
		press("Escape")
		app.waitEval("focus returned from the Command palette", focusReturned)

		press("ctrl+p")
		app.waitEval("the focused Go to file field", `return document.activeElement.matches('dialog[open] [role="combobox"][aria-label="Go to file"]')`)
		press("Escape")
		app.waitEval("focus returned from Quick Open", focusReturned)
		app.waitEval("the sidebar still hidden after both dialogs", sidebarHidden)

		const searchFocused = `document.activeElement.matches('input[aria-label="Search"]')`
		const match = `document.querySelector('[role="tree"][aria-label="Search results"] [role="treeitem"][title="README.md:3"]')`
		press("ctrl+shift+f")
		app.waitEval("the focused Search field", `return `+searchFocused)
		xdotool("type", "--clearmodifiers", "A paragraph.")
		app.waitEval("the README search match", `return `+match+` !== null`)
		press("Escape")
		app.waitEval("focus returned from Search", focusReturned)
		press("ctrl+b")
		app.waitEval("Search hidden", sidebarHidden)
		press("F4")
		app.waitEval("the match opened by F4", `return new URLSearchParams(location.search).get("path") === "README.md" && location.hash === "#L3"`)
		app.waitEval("the sidebar still hidden after F4", sidebarHidden)
		press("ctrl+shift+f")
		app.waitEval("Search focused with the query and match retained", `return `+searchFocused+` && document.activeElement.value === "A paragraph." && `+match+`?.getAttribute("aria-selected") === "true"`)
	})

	t.Run("close shortcut closes the active tab, then the empty window", func(t *testing.T) {
		w.t = t
		isolate("close-tabs")
		app := w.launch(w.project)
		app.waitEval("Welcome", `return document.querySelector('[role=tab][aria-selected=true]')?.textContent === "Welcome"`)
		// Clicking the final tab's X keeps the empty workspace open.
		app.eval(`document.querySelector(".buffer-tab-close").click(); return true`)
		app.waitEval("the empty workspace", `return document.querySelectorAll('[role=tab]').length === 0`)
		for index, path := range []string{"README.md", "main.go"} {
			app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=" + ` + strconv.Quote(path) + `; return true`)
			app.waitEval("the open document tabs", fmt.Sprintf(`return document.querySelectorAll('[role=tab]').length === %d && document.querySelector('[role=tab][aria-selected=true]')?.textContent === %q`, index+1, path))
		}
		pressClose := func() {
			t.Helper()
			key := exec.Command("xdotool", "key", "--clearmodifiers", "ctrl+w")
			if output, err := key.CombinedOutput(); err != nil {
				t.Fatalf("xdotool: %v\n%s", err, output)
			}
		}
		waitForExit := func(app *session) {
			t.Helper()
			defer app.conn.Close()
			done := make(chan error, 1)
			go func() { done <- app.cmd.Wait() }()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("close shortcut exit: %v", err)
				}
			case <-time.After(pageTimeout):
				_ = app.cmd.Process.Kill()
				<-done
				t.Fatal("close shortcut did not quit the app")
			}
		}
		// Native shortcuts must work even while a text input owns focus.
		app.eval(`document.body.appendChild(document.createElement("input")).focus(); return true`)
		pressClose()
		app.waitEval("the previous tab selected", `return document.querySelectorAll('[role=tab]').length === 1 && document.querySelector('[role=tab][aria-selected=true]')?.textContent === "README.md"`)
		// Closing the final tab keeps the window open on the empty workspace.
		pressClose()
		app.waitEval("the empty workspace after the final tab", `return document.querySelectorAll('[role=tab]').length === 0`)
		time.Sleep(time.Second)
		if open, err := app.evalErr(`return document.querySelectorAll('[role=tab]').length === 0`); err != nil || open != true {
			t.Fatalf("closing the final tab closed the window: %v, %v", open, err)
		}
		pressClose()
		waitForExit(app)

		app = w.launch(w.project)
		app.waitEval("Welcome without closed documents restored", `const tabs = document.querySelectorAll('[role=tab]'); return tabs.length === 1 && tabs[0].textContent === "Welcome"`)
		app.eval(`document.querySelector(".buffer-tab-close").click(); return true`)
		app.waitEval("the empty workspace", `return document.querySelectorAll('[role=tab]').length === 0`)
		pressClose()
		waitForExit(app)
	})

	t.Run("Go menu keys and page keys move through history", func(t *testing.T) {
		w.t = t
		isolate("history")
		app := w.launch(w.project)
		defer app.stop()
		app.waitEval("Welcome", `return document.querySelector('[role=tab][aria-selected=true]')?.textContent === "Welcome"`)
		for index, path := range []string{"README.md", "main.go"} {
			app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=" + ` + strconv.Quote(path) + `; return true`)
			app.waitEval("the open document tabs", fmt.Sprintf(`return document.querySelectorAll('[role=tab]').length >= %d && document.querySelector('[role=tab][aria-selected=true]')?.textContent === %q`, index+1, path))
		}
		// Selecting tabs adds history entries within the page: main.go,
		// README.md, main.go.
		pick := func(path string) {
			t.Helper()
			app.eval(`[...document.querySelectorAll('[role=tab]')].find((tab) => tab.textContent === ` + strconv.Quote(path) + `).click(); return true`)
		}
		// selected waits for the tab, then checks that it stays: a move the
		// menu and the page both made would go on to the next entry.
		selected := func(what, path string) {
			t.Helper()
			script := fmt.Sprintf(`return document.querySelector('[role=tab][aria-selected=true]')?.textContent === %q`, path)
			app.waitEval(what, script)
			time.Sleep(500 * time.Millisecond)
			if still, err := app.evalErr(script); err != nil || still != true {
				t.Fatalf("%s: moved past %s (%v)", what, path, err)
			}
		}
		pick("README.md")
		selected("README.md selected", "README.md")
		pick("main.go")
		selected("main.go selected", "main.go")
		press := func(args ...string) {
			t.Helper()
			if output, err := exec.Command("xdotool", args...).CombinedOutput(); err != nil {
				t.Fatalf("xdotool: %v\n%s", err, output)
			}
		}
		press("key", "--clearmodifiers", "ctrl+alt+minus")
		selected("Back by the Go menu", "README.md")
		press("key", "--clearmodifiers", "alt+Left")
		selected("Back by Alt+Left", "main.go")
		app.waitEval("Back disabled at the first entry", `return document.querySelector('[aria-label="Go Back"]')?.getAttribute("aria-disabled") === "true"`)
		press("key", "--clearmodifiers", "ctrl+shift+minus")
		selected("Forward by the Go menu", "README.md")
		press("key", "--clearmodifiers", "alt+Right")
		selected("Forward by Alt+Right", "main.go")
		// WebKitGTK reports a mouse's side buttons as the primary button, so
		// the page cannot follow them on Linux (decision 0131).
	})

	t.Run("notices for a project on this computer", func(t *testing.T) {
		w.t = t
		useHandler(t, "notices")
		project := filepath.Join(base, "notices project")
		writeFixture(t, project)
		app := w.launch(project)
		defer app.stop()
		app.waitEval("the project's tree", treeShows("README.md"))
		w.exerciseNotices(app, project, "local", regexp.MustCompile(`^notices project · |^notices project$`), func() {
			draft, err := json.Marshal(map[string]any{"project": project, "title": "Notice tour", "steps": []map[string]any{{"title": "Start", "body": "Read this.", "file": map[string]any{"path": "README.md"}}}})
			if err != nil {
				t.Fatal(err)
			}
			got := app.eval(fmt.Sprintf(`const r = await fetch("/api/walkthroughs", {method: "POST", headers: {"Content-Type": "application/json"}, body: %s}); return r.ok`, strconv.Quote(string(draft))))
			if got != true {
				t.Fatalf("publishing a walkthrough answered %v", got)
			}
		})
	})

	// The whole remote flow (decision 0098): one machine runs --remote, this
	// computer runs the printed string, and the app shows it in a window of its
	// own. The two share nothing but that string.
	t.Run("zero connect opens a remote server in its own window", func(t *testing.T) {
		w.t = t
		useHandler(t, "connect")
		serverHome, serverRun := filepath.Join(base, "connect-server"), filepath.Join(base, "csrun")
		for _, dir := range []string{serverHome, serverRun} {
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		serverEnv := append(append([]string(nil), w.env...), "HOME="+serverHome, "XDG_DATA_HOME="+filepath.Join(serverHome, "data"), "XDG_CONFIG_HOME="+filepath.Join(serverHome, "config"),
			"XDG_CACHE_HOME="+filepath.Join(serverHome, "cache"), "XDG_RUNTIME_DIR="+serverRun)
		onServer := func(args ...string) (string, error) {
			command := exec.Command(binary, args...)
			command.Env = serverEnv
			output, err := command.CombinedOutput()
			return string(output), err
		}
		t.Cleanup(func() { _, _ = onServer("daemon", "stop") })
		served := filepath.Join(base, "connect project")
		writeFixture(t, served)
		printed, err := onServer(served, "--remote", "--host", "127.0.0.1", "--port", "0", "--remote-grace", "2s")
		if err != nil {
			t.Fatalf("zero --remote: %v\n%s", err, printed)
		}
		text := ""
		for line := range strings.Lines(printed) {
			if found, ok := strings.CutPrefix(strings.TrimSpace(line), "zero connect "); ok {
				text = found
			}
		}
		if text == "" {
			t.Fatalf("no connect string in %q", printed)
		}
		// The string names the project --remote started with (decision 0153).
		invite, err := connection.ParseInvite(text)
		if err != nil || invite.Project != served {
			t.Fatalf("connect string %q = %+v, %v; want project %s", text, invite, err, served)
		}
		secret := invite.Endpoint.Credential.Encode()

		app := w.launch()
		defer app.stop()
		app.waitEval("the local window", `return location.origin === "zero-app://local"`)
		app.eval(`localStorage.setItem("connect-marker", "local"); return true`)
		local := app.windowOn(proxyOrigin("local"))

		connect := func() string {
			t.Helper()
			command := exec.Command(binary, "connect", text)
			command.Env = w.env
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("zero connect: %v\n%s", err, output)
			}
			return string(output)
		}
		output := connect()
		match := connectionLink.FindStringSubmatch(output)
		if match == nil || !strings.Contains(output, "connected to ") || strings.Contains(output, secret) {
			t.Fatalf("zero connect printed %q", output)
		}
		id := match[1]
		remote := app.waitWindow(proxyOrigin(id))
		if remote == local {
			t.Fatal("the connection opened in the local window")
		}
		app.target = remote
		app.waitEval("the string's project in the window", `return new URLSearchParams(location.search).get("project") === `+strconv.Quote(served))
		app.waitEval("the remote project's tree", treeShows("README.md"))
		app.capture("remote-window.png")

		if got := app.eval(`return localStorage.getItem("connect-marker")`); got != nil {
			t.Errorf("the remote page reads the local page's storage: %v", got)
		}
		// Nothing of this machine: not on the bridge, and not by calling mygo.
		if got := app.eval(`const b = window.zeroDesktop; return [b.version, typeof b.closeWindow, typeof b.showContextMenu, typeof b.showAppMenu, typeof b.openFolder, typeof b.revealPath]`); fmt.Sprint(got) != "[2 function function function undefined undefined]" {
			t.Errorf("remote bridge = %v", got)
		}
		for _, method := range []string{`"Bridge.RevealPath", ` + strconv.Quote(w.project) + `, "README.md"`} {
			if got := app.eval(`try { await window.mygo.call(` + method + `); return "resolved" } catch { return "refused" }`); got != "refused" {
				t.Errorf("a remote page called %s: %v", method, got)
			}
		}
		// No secret reaches the page, the control API stays out of reach, and
		// neither the daemon nor another origin answers it.
		if got := app.eval(`return [document.cookie, (await fetch("/_zero/remote")).status, (await fetch("/_daemon/status")).status]`); fmt.Sprint(got) != "[ 403 403]" {
			t.Errorf("cookie and control answers = %v", got)
		}
		if got := app.eval(`try { await fetch("zero-app://local/api/projects"); return "read" } catch { return "blocked" }`); got != "blocked" {
			t.Errorf("a remote page reached the local daemon: %v", got)
		}
		if strings.Contains(fmt.Sprint(app.eval(`return document.documentElement.outerHTML`)), secret) {
			t.Error("the credential is in the page")
		}
		app.exerciseProblemReport("remote")

		// The server counts this window as a UI, though the page holds it open
		// through the app.
		clients := func() string {
			t.Helper()
			status, err := onServer("remote", "status", "--json")
			if err != nil {
				t.Fatalf("remote status: %v\n%s", err, status)
			}
			return status
		}
		deadline := time.Now().Add(pageTimeout)
		for !strings.Contains(clients(), `"clients":1`) {
			if time.Now().After(deadline) {
				t.Fatalf("the window never counted as a UI: %s", clients())
			}
			time.Sleep(200 * time.Millisecond)
		}
		// Past the grace, a window left open keeps the server.
		time.Sleep(3 * time.Second)
		if status := clients(); !strings.Contains(status, `"listening":true`) {
			t.Fatalf("the server closed under an open window: %s", status)
		}

		// Files changed on the server reach the window: first over the stream
		// already open, then after the server went away and came back, when the
		// page has to open a new one (the proxy answers errors while it is gone).
		writeServed := func(name string) {
			t.Helper()
			if err := os.WriteFile(filepath.Join(served, name), []byte("# "+name+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		writeServed("live-remote.md")
		app.waitEval("a file created on the server", treeShows("live-remote.md"))
		if output, err := onServer("daemon", "stop"); err != nil {
			t.Fatalf("daemon stop: %v\n%s", err, output)
		}
		app.waitEval("the window noticing the server left", `return document.querySelector('.status-live[data-mode="off"]') !== null`)
		// Seconds of errors, so the browser has given up on the stream.
		time.Sleep(3 * time.Second)
		if output, err := onServer(served, "--remote", "--host", "127.0.0.1", "--remote-grace", "2s"); err != nil {
			t.Fatalf("zero --remote again: %v\n%s", err, output)
		}
		app.waitEval("the window following the server again", `return document.querySelector('.status-live[data-mode="watching"]') !== null`)
		writeServed("live-remote-again.md")
		app.waitEval("a file created after the server came back", treeShows("live-remote-again.md"))

		// Notices work as they do on this computer, over the notifier's own
		// streams, which came back with the server too (decision 0099). Each names
		// its connection, so a server cannot pass off as this computer.
		w.exerciseNotices(app, served, id, regexp.MustCompile(`^[^·]+ · connect project · |^[^·]+ · connect project$`), func() {
			draft := filepath.Join(base, "notice-tour.json")
			content := fmt.Sprintf(`{"project":%q,"title":"Notice tour","steps":[{"title":"Start","body":"Read this.","file":{"path":"README.md"}}]}`, served)
			if err := os.WriteFile(draft, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if output, err := onServer("walkthrough", "publish", draft, "--no-open"); err != nil {
				t.Fatalf("walkthrough publish: %v\n%s", err, output)
			}
		})

		// Connecting again brings the connection's one window forward on the
		// string's project, as a local `zero <path>` does (decision 0153).
		app.eval(`history.replaceState(null, "", "/view?" + new URLSearchParams({ project: "elsewhere" }).toString()); return true`)
		connect()
		app.waitEval("the string's project after connecting again", `return new URLSearchParams(location.search).get("project") === `+strconv.Quote(served))
		if got := app.windowCount(); got != 2 {
			t.Errorf("%d windows after connecting again, want 2", got)
		}

		// The last UI closes: the server stops by itself, and the local window
		// is unaffected.
		// Closing destroys this eval's source page. WebKit may lose its async
		// result even though CloseWindow succeeded; the native window list and
		// server shutdown below acknowledge the close, not the page's return.
		_, closeErr := app.evalErr(`window.zeroDesktop.closeWindow(); return true`)
		w.report["remoteCloseEvaluationError"] = fmt.Sprint(closeErr)
		app.target = local
		closeBy := time.Now().Add(pageTimeout)
		for {
			windows := app.listWindows()
			if len(windows.Windows) == 1 && windows.Windows[0].ID == local {
				w.report["remoteCloseRemainingWindows"] = windows
				break
			}
			if time.Now().After(closeBy) {
				t.Fatalf("remote window %d did not close leaving local window %d: %+v; eval: %v", remote, local, windows, closeErr)
			}
			time.Sleep(100 * time.Millisecond)
		}
		app.waitEval("the local window still answering", `return location.origin === "zero-app://local"`)
		stopBy := time.Now().Add(pageTimeout)
		for {
			if _, err := onServer("daemon", "status"); err != nil {
				break
			}
			if time.Now().After(stopBy) {
				status, _ := onServer("remote", "status", "--json")
				t.Fatalf("the server outlived its last UI: %s", status)
			}
			time.Sleep(200 * time.Millisecond)
		}

		// A link to a connection this computer does not have opens nothing.
		unknown := exec.Command(w.bin, "zero://r-000000000000/")
		unknown.Env = w.env
		if output, err := unknown.CombinedOutput(); err != nil {
			t.Fatalf("an unknown connection's link: %v\n%s", err, output)
		}
		time.Sleep(time.Second)
		if got := app.windowCount(); got != 1 {
			t.Errorf("%d windows after an unknown connection's link", got)
		}
	})

	t.Run("a link during a slow start wins", func(t *testing.T) {
		w.t = t
		isolate("slow")
		if err := os.WriteFile(gateSlow, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		defer os.Remove(gateSlow)
		second := make(chan error, 1)
		go func() {
			time.Sleep(1500 * time.Millisecond)
			link := exec.Command(w.bin, "zero://local/view?project="+urlEscape(w.project)+"&path=main.go")
			link.Env = w.env
			second <- link.Run()
		}()
		app := w.launch(w.project)
		defer app.stop()
		if err := <-second; err != nil {
			t.Errorf("second instance: %v", err)
		}
		app.waitEval("the link's document", `return location.pathname === "/view" && location.search.includes("path=main.go")`)
	})

	t.Run("Try again recovers from a daemon that would not start", func(t *testing.T) {
		w.t = t
		isolate("gate")
		if err := os.WriteFile(gateClosed, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		app := w.launch()
		defer app.stop()
		app.waitEval("the failure page", `return document.body.innerText.includes("can't reach its daemon") && document.body.innerText.includes("gate closed")`)
		app.capture("try-again.png")
		if err := os.Remove(gateClosed); err != nil {
			t.Fatal(err)
		}
		app.eval(`document.querySelector("a").click(); return true`)
		app.waitEval("the app after Try again", `const text = document.body.innerText; return text.includes("Files") && !text.includes("can't reach its daemon")`)
	})
}

// TestWebViewResources measures a document session and a fresh single-document
// profile without repeating the correctness suite.
func TestWebViewResources(t *testing.T) {
	if os.Getenv("ZERO_DESKTOP_EXTENDED") != "1" {
		t.Skip("resource scenarios require ZERO_DESKTOP_EXTENDED=1")
	}
	w, base := newWorld(t)
	t.Run("memory after the session", func(t *testing.T) {
		w.t = t
		app := w.launch(w.project)
		defer app.stop()
		app.waitEval("the project's tree", treeShows("README.md"))
		w.report["userAgent"] = app.eval(`return navigator.userAgent`)
		w.report["origin"] = app.eval(`return location.origin`)
		w.exerciseDocuments(app)
		time.Sleep(10 * time.Second)
		w.writeMemory(app.cmd.Process.Pid, "rss-session.txt")
	})

	// A fresh profile on the same daemon: Explorer and one Markdown document
	// with its highlighted fence and diagram, nothing else this page loaded.
	t.Run("memory with one document", func(t *testing.T) {
		w.t = t
		home := filepath.Join(base, "fresh")
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
		w.env = append(w.env, "HOME="+home, "XDG_DATA_HOME="+filepath.Join(home, "data"), "XDG_CONFIG_HOME="+filepath.Join(home, "config"), "XDG_CACHE_HOME="+filepath.Join(home, "cache"))
		app := w.launch("zero://local/view?project=" + urlEscape(w.project) + "&path=README.md")
		defer app.stop()
		app.waitEval("the document's Preview button", `const preview = Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Preview"); preview?.click(); return preview !== undefined`)
		app.waitEval("a Mermaid diagram", `return document.querySelector(".mermaid-diagram svg.ondine") !== null`)
		w.report["memoryTabs"] = app.eval(`return document.querySelectorAll("[role=tab]").length`)
		time.Sleep(10 * time.Second)
		w.writeMemory(app.cmd.Process.Pid, "rss.txt")
		app.capture("one-document.png")
	})
}

// exerciseDocuments also supplies the representative resource workload.
func (w *world) exerciseDocuments(app *session) {
	app.t.Helper()
	// A second launch hands its link to the first instance.
	second := exec.Command(w.bin, "zero://local/view?project="+urlEscape(w.project)+"&path=main.go")
	second.Env = w.env
	if output, err := second.CombinedOutput(); err != nil {
		app.t.Errorf("second instance: %v\n%s", err, output)
	}
	app.waitEval("a highlighted keyword", `return Array.from(document.querySelectorAll(".hl-keyword")).some((span) => span.textContent.trim() === "package")`)
	app.capture("source.png")
	// A large source highlights in the worker, whose failure leaves plain text.
	app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=big.go"; return true`)
	app.waitEval("a large source highlighted in the worker", `return document.body.innerText.includes("Value0") && document.querySelector(".hl-keyword") !== null`)
	app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=README.md"; return true`)
	app.waitEval("the document's Preview button", `const preview = Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Preview"); preview?.click(); return preview !== undefined`)
	app.waitEval("a Mermaid diagram", `return document.querySelector(".mermaid-diagram svg.ondine") !== null`)
	app.waitEval("a Markdown image", `const image = document.querySelector("main img"); return image !== null && image.complete && image.naturalWidth === 4`)
	app.capture("diagram.png")
	app.eval(`location.href = "/view?project=" + encodeURIComponent(` + strconv.Quote(w.project) + `) + "&path=pic.png"; return true`)
	app.waitEval("the image viewer", `const image = document.querySelector("main img"); return image !== null && image.complete && image.naturalWidth === 4`)
	w.report["wasm"] = app.eval(`return performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /wasm|worker/.test(name))`)
}

func (s *session) exerciseProblemReport(connectionKind string) {
	s.t.Helper()
	// Help › Report a Problem… dispatches this event to the target page.
	s.eval(`window.dispatchEvent(new Event("zero:report-problem", { cancelable: true })); return true`)
	const preview = `document.querySelector('dialog[open] [aria-label="Problem report"]')`
	s.waitEval("the "+connectionKind+" problem report", fmt.Sprintf(`const report = %s?.textContent ?? "";
		return report.includes("## zero problem report") && report.includes(%q) && report.includes("### Server log")`,
		preview, "Client: desktop app, "+connectionKind+" connection"))
	if got := s.eval(`return ` + preview + `.textContent.includes("### Desktop app log")`); got != (connectionKind == "local") {
		s.t.Errorf("desktop app log in the %s problem report = %v", connectionKind, got)
	}
	s.eval(`document.querySelector('dialog[open] button[aria-label="Close problem report"]').click(); return true`)
	s.waitEval("the problem report closed", `return document.querySelector("dialog[open]") === null`)
}

// killWebProcess crashes the page's web process, as a page that breaks it does.
func (w *world) killWebProcess(t *testing.T, appPid int) {
	t.Helper()
	data, err := exec.Command("pgrep", "-P", strconv.Itoa(appPid), "WebKitWebProces").Output()
	if err != nil {
		t.Fatalf("finding the web process: %v", err)
	}
	// A closed window's web process may exit between pgrep and the kill.
	for _, field := range strings.Fields(string(data)) {
		pid, err := strconv.Atoi(field)
		if err != nil {
			t.Fatalf("pgrep answered %q", field)
		}
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
			t.Fatalf("kill %d: %v", pid, err)
		}
	}
}

// storageFiles lists, relative to home, where WebKit put localStorage.
func storageFiles(t *testing.T, home string) []string {
	t.Helper()
	var found []string
	err := filepath.WalkDir(home, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && strings.Contains(strings.ToLower(path), "localstorage") {
			relative, _ := filepath.Rel(home, path)
			found = append(found, relative)
		}
		return nil
	})
	if err != nil {
		t.Error(err)
	}
	return found
}

// treeShows is a script: the Explorer, inside a shadow root, has the row.
func treeShows(name string) string {
	return `const find = (root) => root.querySelector('[data-item-path=' + JSON.stringify(` + strconv.Quote(name) + `) + ']') !== null
		|| Array.from(root.querySelectorAll("*")).some((element) => element.shadowRoot !== null && find(element.shadowRoot));
	return find(document)`
}

func urlEscape(value string) string {
	var out strings.Builder
	for _, b := range []byte(value) {
		if b == '/' || b == '-' || b == '_' || b == '.' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') {
			out.WriteByte(b)
		} else {
			fmt.Fprintf(&out, "%%%02X", b)
		}
	}
	return out.String()
}

func (w *world) launch(args ...string) *session {
	w.t.Helper()
	cmd := exec.Command(w.bin, args...)
	cmd.Env = w.env
	log, err := os.OpenFile(filepath.Join(w.out, "app.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		w.t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		w.t.Fatal(err)
	}
	s := &session{t: w.t, cmd: cmd, socket: w.sock}
	w.t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = log.Close()
	})
	deadline := time.Now().Add(pageTimeout)
	for {
		conn, err := net.Dial("unix", w.sock)
		if err == nil {
			s.conn, s.reader = conn, bufio.NewReader(conn)
			break
		}
		if time.Now().After(deadline) {
			w.t.Fatalf("automation socket: %v", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	// The window appears once the daemon is ensured.
	for {
		var listing struct {
			Windows []struct {
				URL string `json:"url"`
			} `json:"windows"`
		}
		if err := s.call("windows", nil, &listing); err != nil {
			w.t.Fatal(err)
		}
		if len(listing.Windows) > 0 {
			break
		}
		if time.Now().After(deadline) {
			w.t.Fatal("the app opened no window")
		}
		time.Sleep(100 * time.Millisecond)
	}
	return s
}

func (s *session) stop() {
	s.t.Helper()
	_ = s.conn.Close()
	_ = s.cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- s.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		s.t.Error("the app did not quit on SIGTERM")
		_ = s.cmd.Process.Kill()
		<-done
	}
}

func (s *session) call(method string, params map[string]any, result any) error {
	s.nextID++
	request, err := json.Marshal(map[string]any{"id": s.nextID, "method": method, "params": params})
	if err != nil {
		return err
	}
	if err := s.conn.SetDeadline(time.Now().Add(callTimeout)); err != nil {
		return err
	}
	if _, err := s.conn.Write(append(request, '\n')); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	line, err := s.reader.ReadBytes('\n')
	if err != nil {
		// A navigation can drop a script in flight, which is then never
		// answered, and answers come in order: a new connection goes on.
		if conn, dialErr := net.Dial("unix", s.socket); dialErr == nil {
			_ = s.conn.Close()
			s.conn, s.reader = conn, bufio.NewReader(conn)
		}
		return fmt.Errorf("%s: %w", method, err)
	}
	var answer struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &answer); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	if answer.Error != nil {
		return fmt.Errorf("%s: %s: %s", method, answer.Error.Code, answer.Error.Message)
	}
	if result != nil {
		return json.Unmarshal(answer.Result, result)
	}
	return nil
}

// evalErr runs script as the body of an async function in the page.
func (s *session) evalErr(script string) (any, error) {
	var result struct {
		Value any `json:"value"`
	}
	params := map[string]any{"script": script}
	if s.target != 0 {
		params["window"] = s.target
	}
	err := s.call("eval", params, &result)
	return result.Value, err
}

func (s *session) eval(script string) any {
	s.t.Helper()
	value, err := s.evalErr(script)
	if err != nil {
		s.t.Errorf("eval %s: %v", script, err)
	}
	return value
}

// waitEval polls script until it returns true. Navigation drops an eval in
// flight, so errors are retried until the timeout.
func (s *session) waitEval(what, script string) {
	s.t.Helper()
	deadline := time.Now().Add(pageTimeout)
	var last any
	var lastErr error
	for time.Now().Before(deadline) {
		last, lastErr = s.evalErr(script)
		if lastErr == nil && last == true {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	body, _ := s.evalErr(`return [location.href, document.visibilityState, document.body.innerText.slice(0, 2000)]`)
	s.capture("failure-" + strings.ReplaceAll(what, " ", "-") + ".png")
	s.t.Fatalf("waiting for %s: last %v, %v; page: %v", what, last, lastErr, body)
}

func (s *session) capture(name string) {
	s.t.Helper()
	var result struct {
		PNG string `json:"png"`
	}
	if err := s.call("capture", nil, &result); err != nil {
		s.t.Errorf("capture %s: %v", name, err)
		return
	}
	data, err := base64.StdEncoding.DecodeString(result.PNG)
	if err != nil {
		s.t.Errorf("capture %s: %v", name, err)
		return
	}
	if err := os.WriteFile(filepath.Join(os.Getenv("ZERO_DESKTOP_E2E_OUT"), name), data, 0o644); err != nil {
		s.t.Errorf("capture %s: %v", name, err)
	}
}

// countSocketPeers counts open connections on the daemon's socket path: both
// the listener and accepted sockets name the path in /proc/net/unix.
func countSocketPeers(t *testing.T, socket string) int {
	t.Helper()
	data, err := os.ReadFile("/proc/net/unix")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for line := range strings.SplitSeq(string(data), "\n") {
		if strings.HasSuffix(line, " "+socket) {
			count++
		}
	}
	return count
}

// writeMemory records RSS and PSS of the app's process tree and, apart, of
// the daemon, into name in the output directory.
func (w *world) writeMemory(appPid int, name string) {
	children := map[int][]int{}
	names := map[int]string{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		w.t.Fatal(err)
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		text := string(data)
		open, closed := strings.IndexByte(text, '('), strings.LastIndexByte(text, ')')
		if open < 0 || closed < 0 {
			continue
		}
		names[pid] = text[open+1 : closed]
		fields := strings.Fields(text[closed+1:])
		if len(fields) > 1 {
			parent, _ := strconv.Atoi(fields[1])
			children[parent] = append(children[parent], pid)
		}
	}
	var report bytes.Buffer
	var totalRSS, totalPSS int
	var walk func(pid int)
	walk = func(pid int) {
		rss, pss := rollup(pid)
		totalRSS += rss
		totalPSS += pss
		fmt.Fprintf(&report, "app-tree %d %s rss_kib=%d pss_kib=%d\n", pid, names[pid], rss, pss)
		for _, child := range children[pid] {
			walk(child)
		}
	}
	walk(appPid)
	fmt.Fprintf(&report, "app-tree total rss_mib=%d pss_mib=%d\n", totalRSS/1024, totalPSS/1024)
	for pid, name := range names {
		if name == "zero" {
			rss, pss := rollup(pid)
			fmt.Fprintf(&report, "zero %d rss_mib=%d pss_mib=%d\n", pid, rss/1024, pss/1024)
		}
	}
	w.t.Log(report.String())
	if err := os.WriteFile(filepath.Join(w.out, name), report.Bytes(), 0o644); err != nil {
		w.t.Error(err)
	}
}

func rollup(pid int) (rss, pss int) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "smaps_rollup"))
	if err != nil {
		return 0, 0
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, _ := strconv.Atoi(fields[1])
		switch fields[0] {
		case "Rss:":
			rss = value
		case "Pss:":
			pss = value
		}
	}
	return rss, pss
}

func writeFixture(t *testing.T, root string) {
	t.Helper()
	files := map[string]string{
		"README.md": "# E2E fixture\n\nA paragraph.\n\n![pic](pic.png)\n\n```go\npackage main\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
		"main.go":   "package main\n\n// A comment.\nfunc main() {}\n",
	}
	var big strings.Builder
	big.WriteString("package main\n\n")
	for i := range 4000 {
		fmt.Fprintf(&big, "const Value%d = %d // Line %d of a file past the main thread's highlight limit.\n", i, i, i)
	}
	files["big.go"] = big.String()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "pic.png"), paddedPNG(t), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"add", "-A"}, {"-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "init"}} {
		git := exec.Command("git", args...)
		git.Dir = root
		if output, err := git.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}
}

// paddedPNG is a valid 4x4 PNG of more than a MiB: an ancillary chunk spans
// mygo's 256 KiB write chunks and shows truncation or corruption in a hash.
func paddedPNG(t *testing.T) []byte {
	t.Helper()
	chunk := func(kind string, data []byte) []byte {
		var out bytes.Buffer
		_ = binary.Write(&out, binary.BigEndian, uint32(len(data)))
		out.WriteString(kind)
		out.Write(data)
		_ = binary.Write(&out, binary.BigEndian, crc32.ChecksumIEEE(append([]byte(kind), data...)))
		return out.Bytes()
	}
	var png bytes.Buffer
	png.Write([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
	png.Write(chunk("IHDR", []byte{0, 0, 0, 4, 0, 0, 0, 4, 8, 0, 0, 0, 0}))
	padding := make([]byte, 1<<20+7)
	for i := range padding {
		padding[i] = byte(i * 31)
	}
	png.Write(chunk("teXt", append([]byte("e2e\x00"), padding...)))
	// Stored deflate of 4 rows: a filter byte and 4 gray pixels each.
	raw := []byte{0, 1, 2, 3, 4, 0, 5, 6, 7, 8, 0, 9, 10, 11, 12, 0, 13, 14, 15, 16}
	stored := append([]byte{0x78, 0x01, 0x01, byte(len(raw)), 0, ^byte(len(raw)), 0xff}, raw...)
	stored = binary.BigEndian.AppendUint32(stored, adler32(raw))
	png.Write(chunk("IDAT", stored))
	png.Write(chunk("IEND", nil))
	return png.Bytes()
}

func adler32(data []byte) uint32 {
	a, b := uint32(1), uint32(0)
	for _, d := range data {
		a = (a + uint32(d)) % 65521
		b = (b + a) % 65521
	}
	return b<<16 | a
}

// screenCapture is what screenCapture() hands the local window (decisions
// 0177, 0180).
type screenCapture struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	PNG     string `json:"png"`
	Page    struct {
		URL      string `json:"url"`
		Title    string `json:"title"`
		Viewport struct {
			Width             int     `json:"width"`
			Height            int     `json:"height"`
			DeviceScaleFactor float64 `json:"deviceScaleFactor"`
		} `json:"viewport"`
		Scroll struct{ X, Y int } `json:"scroll"`
	} `json:"page"`
	Hits  *screenHits `json:"hits"`
	Drift bool        `json:"drift"`
}

type screenRect struct{ X, Y, Width, Height int }

type screenHits struct {
	Step     int         `json:"step"`
	Columns  int         `json:"columns"`
	Rows     int         `json:"rows"`
	Grid     []int       `json:"grid"`
	Elements []screenHit `json:"elements"`
}

type screenHit struct {
	Parent     int         `json:"parent"`
	Tag        string      `json:"tag"`
	Selector   string      `json:"selector"`
	Role       string      `json:"role"`
	Name       string      `json:"name"`
	Box        *screenRect `json:"box"`
	Meaningful bool        `json:"meaningful"`
}

// bySelector is the element the page described by selector, or nil.
func (h *screenHits) bySelector(selector string) *screenHit {
	for index := range h.Elements {
		if h.Elements[index].Selector == selector {
			return &h.Elements[index]
		}
	}
	return nil
}

// at is the element the hit map shows at a CSS point: the topmost at its
// cell, or the nearest ancestor holding the point.
func (h *screenHits) at(x, y int) *screenHit {
	cell := h.Grid[min(y/h.Step, h.Rows-1)*h.Columns+min(x/h.Step, h.Columns-1)]
	for index := cell; index >= 0; index = h.Elements[index].Parent {
		box := h.Elements[index].Box
		if box != nil && x >= box.X && x < box.X+box.Width && y >= box.Y && y < box.Y+box.Height {
			return &h.Elements[index]
		}
	}
	return nil
}

// checkPixel reports the frame's color at a point that is not want, within
// the rounding a compositor allows.
func checkPixel(t *testing.T, frame image.Image, what string, x, y float64, want [3]uint8) {
	t.Helper()
	r, g, b, _ := frame.At(int(math.Round(x)), int(math.Round(y))).RGBA()
	got := [3]uint8{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8)}
	for index := range got {
		if diff := int(got[index]) - int(want[index]); diff > 8 || diff < -8 {
			t.Errorf("%s at frame %.0f,%.0f is rgb%v, want rgb%v: the screenshot and the hit map disagree", what, x, y, got, want)
			return
		}
	}
}
