package app

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/internal/document"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/pkg/contract"
)

func newDiagnosticsApp(t *testing.T, server ServerInfo, home string) *App {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	application, err := New(Config{Roots: roots, Depth: 5, Types: document.Builtins(), WalkthroughDirectory: t.TempDir(), FeedbackDirectory: t.TempDir(), Server: server})
	if err != nil {
		t.Fatal(err)
	}
	application.Diagnostics.home = func() (string, error) { return home, nil }
	return application
}

// A foreground server keeps no log: the report says so and carries empty,
// never null, lines.
func TestDiagnosticsWithoutALog(t *testing.T) {
	report := newDiagnosticsApp(t, ServerInfo{}, "/home/u").Diagnostics.Report()
	if report.Mode != contract.DiagnosticsBrowser || report.LogsKept || report.LogFile != "" || report.Roots != 1 || report.Home != "/home/u" {
		t.Errorf("report = %+v", report)
	}
	if report.LogLines == nil || len(report.LogLines) != 0 || report.CrashLines == nil || len(report.CrashLines) != 0 {
		t.Errorf("lines = %#v, %#v; want empty slices", report.LogLines, report.CrashLines)
	}
	if report.Version == "" || report.OS == "" || report.Arch == "" {
		t.Errorf("build facts missing: %+v", report)
	}
}

// The daemon's report carries its newest log and crash lines, redacted, and
// asks for the install method and exposure only when reporting.
func TestDiagnosticsReadsTheDaemonLogRedacted(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "logs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	logFile, crashFile := filepath.Join(dir, "daemon.log"), filepath.Join(dir, "daemon-crash.log")
	var lines []string
	for i := range diagnosticsLines + 5 {
		lines = append(lines, "line "+strings.Repeat("x", i%3)+" root="+home+"/src")
	}
	if err := os.WriteFile(logFile, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(crashFile, []byte("panic: boom\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	asked := 0
	server := ServerInfo{
		Mode: contract.DiagnosticsDaemon, Protocol: 1, LogFile: logFile, CrashFile: crashFile,
		InstallMethod: func() string { asked++; return "script" },
		Exposure:      func() string { return contract.RemoteExposureTLS },
	}
	application := newDiagnosticsApp(t, server, home)
	if asked != 0 {
		t.Fatalf("install method detected %d times before a report", asked)
	}
	report := application.Diagnostics.Report()
	if report.Mode != contract.DiagnosticsDaemon || report.Protocol != 1 || !report.LogsKept || report.InstallMethod != "script" || report.Exposure != contract.RemoteExposureTLS {
		t.Errorf("report = %+v", report)
	}
	if report.LogFile != "~/logs/daemon.log" {
		t.Errorf("log file = %q, want it redacted", report.LogFile)
	}
	if len(report.LogLines) != diagnosticsLines {
		t.Fatalf("log lines = %d, want %d", len(report.LogLines), diagnosticsLines)
	}
	if last := report.LogLines[len(report.LogLines)-1]; last != strings.ReplaceAll(lines[len(lines)-1], home, "~") {
		t.Errorf("last line = %q, want the newest line redacted", last)
	}
	for _, line := range report.LogLines {
		if strings.Contains(line, home) {
			t.Fatalf("line %q keeps the home directory", line)
		}
	}
	if !reflect.DeepEqual(report.CrashLines, []string{"panic: boom"}) {
		t.Errorf("crash lines = %q", report.CrashLines)
	}
}
