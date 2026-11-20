package main

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"github.com/egoist/mygo"

	"github.com/flexdinesh/zero/apps/desktop/internal/bridge"
	"github.com/flexdinesh/zero/apps/desktop/internal/proxy"
	"github.com/flexdinesh/zero/pkg/logfile"
)

// logName names the app's log files: desktop.log and desktop-crash.log.
const logName = "desktop"

// reportLines is how many of the newest log lines a problem report carries.
const reportLines = 200

// logDir is the user's log directory (decision 0152), or logs/ beside an
// isolated development daemon's socket (ZERO_DESKTOP_SOCKET), so dev runs
// keep their own logs.
func logDir(goos string, getenv func(string) string, home string) (string, error) {
	if socket := getenv("ZERO_DESKTOP_SOCKET"); socket != "" {
		return filepath.Join(filepath.Dir(socket), "logs"), nil
	}
	return logfile.Dir(goos, getenv, home)
}

// openLog has the standard logger also write to the rotating desktop.log,
// and crash output go to desktop-crash.log, in the log directory. It answers
// that directory, or "" when no log is kept; the app runs either way.
func openLog() string {
	home, _ := os.UserHomeDir()
	dir, err := logDir(runtime.GOOS, os.Getenv, home)
	if err != nil {
		log.Printf("zero-app: cannot keep a log: %v", err)
		return ""
	}
	file, err := logfile.Open(dir, logName)
	if err != nil {
		log.Printf("zero-app: cannot keep a log: %v", err)
		return ""
	}
	// The file stays open for the app's life.
	log.SetOutput(io.MultiWriter(os.Stderr, file))
	if err := logfile.CaptureCrashes(dir, logName); err != nil {
		log.Printf("zero-app: cannot keep crash output: %v", err)
	}
	log.Printf("zero-app %s started", versionLine())
	return dir
}

// diagnostics is the app's part of a problem report, redacted.
func (h *host) diagnostics() bridge.Diagnostics {
	var lines, crash []string
	if h.logDir != "" {
		lines, _ = logfile.Tail(logfile.Path(h.logDir, logName), reportLines)
		crash, _ = logfile.Tail(logfile.CrashPath(h.logDir, logName), reportLines)
	}
	home, _ := os.UserHomeDir()
	return bridge.NewDiagnostics(version, commit, h.logDir, lines, crash, home)
}

// helpMenu reports a problem through the window's page and opens the log
// folder (decision 0152).
func (h *host) helpMenu() *mygo.MenuItem {
	return &mygo.MenuItem{Role: mygo.RoleHelp, Submenu: []*mygo.MenuItem{
		{Label: "Report a Problem…", Click: func(_ *mygo.MenuItem, window *mygo.Window) { go h.reportProblem(window) }},
		{Label: "Open Logs Folder", Disabled: h.logDir == "", Click: func(*mygo.MenuItem, *mygo.Window) { go h.openLogs() }},
	}}
}

// reportProblem asks the window's page to open its problem report; with no
// window open, the local one opens first.
func (h *host) reportProblem(window *mygo.Window) {
	if window == nil {
		window = h.frontWindow()
	}
	if window == nil {
		h.load(proxy.Origin + "/")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.page(window).EvalContext(ctx, `return window.dispatchEvent(new Event("zero:report-problem", { cancelable: true }))`)
}

// openLogs shows the log folder in the file manager.
func (h *host) openLogs() {
	if err := mygo.Shell.OpenPath(h.logDir); err != nil {
		h.report("Could not open the logs folder", strconv.Quote(h.logDir)+": "+err.Error())
	}
}
