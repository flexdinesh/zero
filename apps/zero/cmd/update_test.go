package cmd

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flexdinesh/zero/internal/selfupdate"
	"github.com/spf13/cobra"
)

type fakeUpdate struct {
	method     selfupdate.Method
	latest     string
	latestErr  error
	downloaded []string
	ran        [][]string
	runErr     error
	spawned    int
	env        map[string]string
	terminal   bool
	checkPath  string
	now        time.Time
}

func newFakeUpdate(t *testing.T) *fakeUpdate {
	return &fakeUpdate{
		method:    selfupdate.Method{Kind: selfupdate.KindScript, Desktop: true},
		latest:    "0.2.1",
		env:       map[string]string{},
		terminal:  true,
		checkPath: filepath.Join(t.TempDir(), "update-check.json"),
		now:       time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC),
	}
}

func (f *fakeUpdate) deps() updateDeps {
	return updateDeps{
		current: "0.2.0",
		detect:  func() selfupdate.Method { return f.method },
		latest:  func(context.Context) (string, error) { return f.latest, f.latestErr },
		download: func(_ context.Context, url, dst string) error {
			f.downloaded = append(f.downloaded, url)
			return os.WriteFile(dst, []byte("#!/bin/sh\n"), 0o600)
		},
		run: func(_ context.Context, script string, args []string, _ io.Reader, _, _ io.Writer) error {
			f.ran = append(f.ran, append([]string{filepath.Base(script)}, args...))
			return f.runErr
		},
		checkPath: func() (string, error) { return f.checkPath, nil },
		now:       func() time.Time { return f.now },
		getenv:    func(key string) string { return f.env[key] },
		terminal:  func(io.Writer) bool { return f.terminal },
		spawn:     func() error { f.spawned++; return nil },
	}
}

func runFakeUpdate(f *fakeUpdate, opts updateOptions) (string, error) {
	var stdout, stderr bytes.Buffer
	err := runUpdate(context.Background(), opts, strings.NewReader(""), &stdout, &stderr, f.deps())
	return stdout.String() + stderr.String(), err
}

func TestUpdateRunsTheReleaseInstallScript(t *testing.T) {
	f := newFakeUpdate(t)
	output, err := runFakeUpdate(f, updateOptions{})
	if err != nil {
		t.Fatalf("update: %v\n%s", err, output)
	}
	want := "https://raw.githubusercontent.com/flexdinesh/zero/v0.2.1/scripts/install.sh"
	if len(f.downloaded) != 1 || f.downloaded[0] != want {
		t.Fatalf("downloaded %v, want %s", f.downloaded, want)
	}
	if len(f.ran) != 1 || strings.Join(f.ran[0], " ") != "install.sh" {
		t.Fatalf("ran %v, want install.sh with no arguments", f.ran)
	}
	if got := selfupdate.ReadCheck(f.checkPath); got.Latest != "0.2.1" {
		t.Fatalf("cache = %+v", got)
	}
}

func TestUpdateCLIOnly(t *testing.T) {
	for name, test := range map[string]struct {
		desktop bool
		cliOnly bool
	}{
		"record without the app": {desktop: false},
		"--cli-only":             {desktop: true, cliOnly: true},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeUpdate(t)
			f.method.Desktop = test.desktop
			if _, err := runFakeUpdate(f, updateOptions{cliOnly: test.cliOnly}); err != nil {
				t.Fatal(err)
			}
			if len(f.ran) != 1 || strings.Join(f.ran[0], " ") != "install.sh --cli-only" {
				t.Fatalf("ran %v", f.ran)
			}
		})
	}
}

func TestUpdateUpToDateAndCheck(t *testing.T) {
	f := newFakeUpdate(t)
	f.latest = "0.2.0"
	output, err := runFakeUpdate(f, updateOptions{})
	if err != nil || !strings.Contains(output, "zero 0.2.0 is up to date") || len(f.downloaded) != 0 {
		t.Fatalf("up to date: %v %q %v", err, output, f.downloaded)
	}

	f = newFakeUpdate(t)
	output, err = runFakeUpdate(f, updateOptions{check: true, cliName: "zero-cli"})
	if err != nil || !strings.Contains(output, "zero 0.2.1 is available (current 0.2.0); run `zero-cli update`") || len(f.downloaded) != 0 {
		t.Fatalf("check: %v %q %v", err, output, f.downloaded)
	}
}

func TestUpdateReportsFailures(t *testing.T) {
	f := newFakeUpdate(t)
	f.latestErr = errors.New("offline")
	if _, err := runFakeUpdate(f, updateOptions{}); err == nil || len(f.downloaded) != 0 {
		t.Fatalf("latest failure: %v, downloaded %v", err, f.downloaded)
	}

	f = newFakeUpdate(t)
	f.runErr = errors.New("exit status 1")
	_, err := runFakeUpdate(f, updateOptions{})
	if err == nil || !strings.Contains(err.Error(), "quit it and run `zero update` again") || !strings.Contains(err.Error(), "zero update --cli-only") {
		t.Fatalf("install failure with the app: %v", err)
	}

	f = newFakeUpdate(t)
	f.method.Desktop = false
	f.runErr = errors.New("exit status 1")
	_, err = runFakeUpdate(f, updateOptions{})
	if err == nil || strings.Contains(err.Error(), "desktop app") {
		t.Fatalf("install failure without the app: %v", err)
	}
}

func TestUpdateInstructsOtherInstalls(t *testing.T) {
	tests := []struct {
		method selfupdate.Method
		want   string
	}{
		{selfupdate.Method{Kind: selfupdate.KindDev}, "install-dev.sh | sh -s -- --ref <branch-or-commit>"},
		{selfupdate.Method{Kind: selfupdate.KindBundled}, "bundled inside the desktop app"},
		{selfupdate.Method{Kind: selfupdate.KindManaged, Manager: "homebrew"}, "installed by homebrew; update it with homebrew"},
		{selfupdate.Method{Kind: selfupdate.KindGoInstall}, "go install, which zero does not support"},
		{selfupdate.Method{Kind: selfupdate.KindUnknown}, "not installed by install.sh"},
	}
	for _, test := range tests {
		t.Run(string(test.method.Kind), func(t *testing.T) {
			f := newFakeUpdate(t)
			f.method = test.method
			output, err := runFakeUpdate(f, updateOptions{})
			if !errors.Is(err, errNotUpdated) || !strings.Contains(output, test.want) || len(f.downloaded) != 0 || len(f.ran) != 0 {
				t.Fatalf("err %v, output %q, downloaded %v, ran %v", err, output, f.downloaded, f.ran)
			}
			if _, err := runFakeUpdate(f, updateOptions{check: true}); err != nil {
				t.Fatalf("--check: %v", err)
			}
		})
	}
}

func TestUpdateInstructionsUseTheInvokedName(t *testing.T) {
	f := newFakeUpdate(t)
	f.method = selfupdate.Method{Kind: selfupdate.KindUnknown}
	output, _ := runFakeUpdate(f, updateOptions{cliName: "zero-cli"})
	if !strings.Contains(output, "install.sh | sh -s -- --name zero-cli") {
		t.Fatalf("output %q", output)
	}
}

func TestUpdateRefreshWritesTheCache(t *testing.T) {
	f := newFakeUpdate(t)
	output, err := runFakeUpdate(f, updateOptions{refresh: true})
	if err != nil || output != "" {
		t.Fatalf("refresh: %v %q", err, output)
	}
	if got := selfupdate.ReadCheck(f.checkPath); got.Latest != "0.2.1" || !got.CheckedAt.Equal(f.now) {
		t.Fatalf("cache = %+v", got)
	}
	f.latestErr = errors.New("offline")
	if _, err := runFakeUpdate(f, updateOptions{refresh: true}); err != nil {
		t.Fatalf("refresh failure must stay silent: %v", err)
	}
}

// noticeTree is a root with an annotated and an unannotated subcommand.
func noticeTree() (root, shown, hidden, nested *cobra.Command) {
	root = withUpdateNotice(&cobra.Command{Use: "zero"})
	shown = withUpdateNotice(&cobra.Command{Use: "remote"})
	nested = &cobra.Command{Use: "status"}
	shown.AddCommand(nested)
	hidden = &cobra.Command{Use: "daemon"}
	hidden.AddCommand(&cobra.Command{Use: "run"})
	root.AddCommand(shown, hidden)
	return root, shown, hidden, nested
}

func noticeOutput(t *testing.T, f *fakeUpdate, command *cobra.Command) string {
	t.Helper()
	var stderr bytes.Buffer
	command.Root().SetErr(&stderr)
	updateNotice(command, f.deps())
	return stderr.String()
}

func TestUpdateNoticeFromTheCache(t *testing.T) {
	f := newFakeUpdate(t)
	if err := selfupdate.WriteCheck(f.checkPath, selfupdate.Check{CheckedAt: f.now.Add(-time.Hour), Latest: "0.2.1"}); err != nil {
		t.Fatal(err)
	}
	root, shown, hidden, nested := noticeTree()
	want := "zero 0.2.1 is available (current 0.2.0); run `zero update`\n"
	for _, command := range []*cobra.Command{root, shown, nested} {
		if got := noticeOutput(t, f, command); got != want {
			t.Fatalf("%s notice = %q, want %q", command.CommandPath(), got, want)
		}
	}
	for _, command := range []*cobra.Command{hidden, hidden.Commands()[0]} {
		if got := noticeOutput(t, f, command); got != "" {
			t.Fatalf("%s showed a notice: %q", command.CommandPath(), got)
		}
	}
	if f.spawned != 0 {
		t.Fatalf("fresh cache spawned %d refreshes", f.spawned)
	}
}

func TestUpdateNoticeSuppressed(t *testing.T) {
	cases := map[string]func(*fakeUpdate){
		"not a terminal":       func(f *fakeUpdate) { f.terminal = false },
		"CI":                   func(f *fakeUpdate) { f.env["CI"] = "true" },
		"ZERO_NO_UPDATE_CHECK": func(f *fakeUpdate) { f.env["ZERO_NO_UPDATE_CHECK"] = "1" },
		"dev install":          func(f *fakeUpdate) { f.method = selfupdate.Method{Kind: selfupdate.KindDev} },
		"bundled copy":         func(f *fakeUpdate) { f.method = selfupdate.Method{Kind: selfupdate.KindBundled} },
		"up to date":           func(f *fakeUpdate) { f.latest = "0.2.0" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFakeUpdate(t)
			change(f)
			if err := selfupdate.WriteCheck(f.checkPath, selfupdate.Check{CheckedAt: f.now.Add(-time.Hour), Latest: f.latest}); err != nil {
				t.Fatal(err)
			}
			root, _, _, _ := noticeTree()
			if got := noticeOutput(t, f, root); got != "" {
				t.Fatalf("notice = %q", got)
			}
		})
	}
}

func TestUpdateNoticeOtherMethods(t *testing.T) {
	tests := map[selfupdate.Kind]struct {
		method selfupdate.Method
		want   string
	}{
		selfupdate.KindManaged: {selfupdate.Method{Kind: selfupdate.KindManaged, Manager: "homebrew"}, "update it with homebrew"},
		selfupdate.KindUnknown: {selfupdate.Method{Kind: selfupdate.KindUnknown}, "run `zero update` for how to update"},
	}
	for kind, test := range tests {
		t.Run(string(kind), func(t *testing.T) {
			f := newFakeUpdate(t)
			f.method = test.method
			if err := selfupdate.WriteCheck(f.checkPath, selfupdate.Check{CheckedAt: f.now.Add(-time.Hour), Latest: "0.2.1"}); err != nil {
				t.Fatal(err)
			}
			root, _, _, _ := noticeTree()
			if got := noticeOutput(t, f, root); !strings.Contains(got, test.want) {
				t.Fatalf("notice = %q, want %q", got, test.want)
			}
		})
	}
}

func TestUpdateNoticeRefreshesAStaleCacheOncePerPeriod(t *testing.T) {
	f := newFakeUpdate(t)
	root, _, _, _ := noticeTree()
	if got := noticeOutput(t, f, root); got != "" {
		t.Fatalf("empty cache showed %q", got)
	}
	if f.spawned != 1 {
		t.Fatalf("spawned %d refreshes, want 1", f.spawned)
	}
	// The attempt is recorded, so a failing refresh is not retried at once.
	if got := noticeOutput(t, f, root); got != "" || f.spawned != 1 {
		t.Fatalf("second run: notice %q, spawned %d", got, f.spawned)
	}
	f.now = f.now.Add(selfupdate.CheckPeriod)
	noticeOutput(t, f, root)
	if f.spawned != 2 {
		t.Fatalf("after a period spawned %d, want 2", f.spawned)
	}
}

func TestRootCommandsShowingTheUpdateNotice(t *testing.T) {
	root := newRootCommandWith(nil, nil)
	want := map[string]bool{
		"zero": true, "browser": true, "connect": true, "attach": true, "remote": true, "walkthrough": true, "feedback": true,
		"serve-stdio": false, "connection": false, "daemon": false, "update": false,
	}
	if !showsUpdateNotice(root) {
		t.Fatal("bare zero does not show the notice")
	}
	for _, command := range root.Commands() {
		name := command.Name()
		expected, listed := want[name]
		if !listed {
			t.Fatalf("decide whether %q shows the update notice", name)
		}
		if got := showsUpdateNotice(command); got != expected {
			t.Errorf("%s shows notice = %v, want %v", name, got, expected)
		}
	}
}
