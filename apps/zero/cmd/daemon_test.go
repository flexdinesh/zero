//go:build darwin || linux

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/flexdinesh/zero/internal/daemon"
	"github.com/flexdinesh/zero/pkg/logfile"
)

func executeDaemon(t *testing.T, args ...string) (string, daemonOptions, error) {
	t.Helper()
	var got daemonOptions
	var called string
	record := func(name string) daemonAction {
		return func(_ context.Context, opts daemonOptions, _, _ io.Writer) error {
			called, got = name, opts
			return nil
		}
	}
	command := newDaemonCommandWith(daemonActions{run: record("run"), ensure: record("ensure"), stop: record("stop"), status: record("status")})
	command.SetArgs(args)
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	err := command.Execute()
	return called, got, err
}

func TestDaemonCommandParsesFlags(t *testing.T) {
	runtimeDir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", runtimeDir)
	defaultSocket, err := daemon.DefaultSocket()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		args []string
		want string
		opts daemonOptions
	}{
		{[]string{"run"}, "run", daemonOptions{socket: defaultSocket, depth: 5, scanDepth: 10, idleExit: 30 * time.Minute}},
		{[]string{"ensure", "--json", "--socket", "/tmp/sf/d.sock", "--depth", "3", "--scan-depth", "4", "--idle-exit", "0"}, "ensure", daemonOptions{socket: "/tmp/sf/d.sock", depth: 3, scanDepth: 4, json: true}},
		{[]string{"--socket", "/tmp/sf/d.sock", "stop"}, "stop", daemonOptions{socket: "/tmp/sf/d.sock"}},
		{[]string{"status", "--json"}, "status", daemonOptions{socket: defaultSocket, json: true}},
		{[]string{"run", "--roots-file", "/tmp/sf/roots.json"}, "run", daemonOptions{socket: defaultSocket, depth: 5, scanDepth: 10, idleExit: 30 * time.Minute, rootsFile: "/tmp/sf/roots.json"}},
	}
	for _, test := range tests {
		called, opts, err := executeDaemon(t, test.args...)
		if err != nil || called != test.want || opts != test.opts {
			t.Errorf("daemon %v = %s %+v, %v; want %s %+v", test.args, called, opts, err, test.want, test.opts)
		}
	}
	if !strings.HasPrefix(defaultSocket, runtimeDir) {
		t.Errorf("default socket %s is not under XDG_RUNTIME_DIR", defaultSocket)
	}
}

func TestDaemonCommandValidatesFlags(t *testing.T) {
	for _, args := range [][]string{
		{"run", "--depth", "-1"},
		{"ensure", "--scan-depth", "-1"},
		{"run", "--idle-exit", "-1s"},
		{"stop", "--depth", "3"},
		{"status", "--idle-exit", "1m"},
		{"stop", "--json"},
		{"status", "--roots-file", "/tmp/sf/roots.json"},
		{"run", "extra"},
	} {
		if called, _, err := executeDaemon(t, args...); err == nil || called != "" {
			t.Errorf("daemon %v ran %q, error %v; want rejected", args, called, err)
		}
	}
}

func TestRootCommandRoutesDaemonSubcommand(t *testing.T) {
	var output bytes.Buffer
	command := newRootCommand(func(context.Context, options, io.Reader, io.Writer, io.Writer) error {
		t.Fatal("browser runner called for daemon")
		return nil
	})
	command.SetOut(&output)
	command.SetArgs([]string{"daemon", "status", "--help"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "zero daemon status [flags]") {
		t.Fatalf("help = %q", output.String())
	}
}

type cliResult struct {
	stdout, stderr string
	err            error
}

// zero runs the test binary as zero (see TestMain).
func zero(t *testing.T, env []string, args ...string) cliResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], args...)
	command.Env = append(os.Environ(), env...)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	return cliResult{stdout: stdout.String(), stderr: stderr.String(), err: err}
}

// processGone reports whether pid has exited; a zombie awaiting its reaper
// has exited.
func processGone(pid int) bool {
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return true
	}
	stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return false
	}
	fields := strings.Fields(string(stat[bytes.LastIndexByte(stat, ')')+1:]))
	return len(fields) > 0 && fields[0] == "Z"
}

func TestDaemonCommandsDetachEnsureStopAndStatus(t *testing.T) {
	dir, err := os.MkdirTemp("", "sf")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "daemon.sock")
	env := []string{"ZERO_CMD_TEST_EXEC=1", "XDG_CONFIG_HOME=" + t.TempDir(), "XDG_CACHE_HOME=" + t.TempDir()}
	t.Cleanup(func() { zero(t, env, "daemon", "stop", "--socket", socket) })

	type ensured struct {
		daemon.Status
		Started *bool `json:"started"`
	}
	decode := func(result cliResult) ensured {
		t.Helper()
		if result.err != nil {
			t.Fatalf("zero: %v\nstdout %s\nstderr %s", result.err, result.stdout, result.stderr)
		}
		var value ensured
		if err := json.Unmarshal([]byte(result.stdout), &value); err != nil {
			t.Fatalf("output %q: %v", result.stdout, err)
		}
		return value
	}

	first := decode(zero(t, env, "daemon", "ensure", "--json", "--socket", socket, "--idle-exit", "2m"))
	if first.Started == nil || !*first.Started || first.Protocol != daemon.ProtocolVersion || first.PID == os.Getpid() || first.IdleExit != "2m0s" {
		t.Fatalf("first ensure = %+v", first)
	}
	second := decode(zero(t, env, "daemon", "ensure", "--json", "--socket", socket))
	if second.Started == nil || *second.Started || second.PID != first.PID {
		t.Fatalf("second ensure = %+v, want started false and pid %d", second, first.PID)
	}
	status := decode(zero(t, env, "daemon", "status", "--json", "--socket", socket))
	if status.Started != nil || status.PID != first.PID || status.Socket != socket {
		t.Fatalf("status = %+v", status)
	}
	if human := zero(t, env, "daemon", "status", "--socket", socket); human.err != nil || !strings.Contains(human.stdout, "(protocol 1) at "+socket+", pid ") {
		t.Fatalf("status = %+v", human)
	}

	if stopped := zero(t, env, "daemon", "stop", "--socket", socket); stopped.err != nil || stopped.stdout != "stopped\n" {
		t.Fatalf("stop = %+v", stopped)
	}
	if again := zero(t, env, "daemon", "stop", "--socket", socket); again.err != nil || again.stdout != "not running\n" {
		t.Fatalf("second stop = %+v", again)
	}
	if missing := zero(t, env, "daemon", "status", "--socket", socket); missing.err == nil || !strings.Contains(missing.stderr, "zero daemon is not running at "+socket) {
		t.Fatalf("status after stop = %+v", missing)
	}
	deadline := time.Now().Add(10 * time.Second)
	for !processGone(first.PID) {
		if time.Now().After(deadline) {
			t.Fatalf("daemon process %d still running after stop", first.PID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDaemonEnsureForwardsRootsFile(t *testing.T) {
	dir, err := os.MkdirTemp("", "sf")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "daemon.sock")
	env := []string{"ZERO_CMD_TEST_EXEC=1", "XDG_CONFIG_HOME=" + t.TempDir(), "XDG_CACHE_HOME=" + t.TempDir()}
	t.Cleanup(func() { zero(t, env, "daemon", "stop", "--socket", socket) })
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// A relative path is forwarded absolute: the started daemon runs in /.
	rootsFile := filepath.Join(t.TempDir(), "roots.json")
	if err := daemon.SaveRoots(rootsFile, []string{root}); err != nil {
		t.Fatal(err)
	}
	t.Chdir(filepath.Dir(rootsFile))

	result := zero(t, env, "daemon", "ensure", "--json", "--socket", socket, "--roots-file", filepath.Base(rootsFile))
	var status daemon.Status
	if result.err != nil || json.Unmarshal([]byte(result.stdout), &status) != nil {
		t.Fatalf("ensure = %+v", result)
	}
	if len(status.Roots) != 1 || status.Roots[0] != root {
		t.Fatalf("roots = %v, want %s from --roots-file", status.Roots, root)
	}
}

func TestDaemonRunArgsForwardOnlyNonDefaults(t *testing.T) {
	const socket = "/run/user/1000/zero/daemon.sock"
	defaults := daemonOptions{socket: socket, depth: defaultDepth, scanDepth: defaultScanDepth, idleExit: daemon.DefaultIdleExit}
	for _, test := range []struct {
		name          string
		opts          daemonOptions
		defaultSocket string
		want          string
	}{
		{"defaults", defaults, socket, "daemon run"},
		{"unknown default socket", defaults, "", "daemon run --socket " + socket},
		{"other socket", daemonOptions{socket: "/tmp/d.sock", depth: defaultDepth, scanDepth: defaultScanDepth, idleExit: daemon.DefaultIdleExit}, socket, "daemon run --socket /tmp/d.sock"},
		{"every flag", daemonOptions{socket: socket, depth: 2, scanDepth: 3, idleExit: 0, rootsFile: "/tmp/roots.json"}, socket,
			"daemon run --depth 2 --scan-depth 3 --idle-exit 0s --roots-file /tmp/roots.json"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := strings.Join(daemonRunArgs(test.opts, test.defaultSocket), " "); got != test.want {
				t.Fatalf("daemonRunArgs = %q, want %q", got, test.want)
			}
		})
	}
}

// The default socket's daemon logs in the user's log directory; a daemon on
// another socket logs beside it, so isolated daemons keep their own logs.
func TestDaemonLogDirectory(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	defaultSocket, err := daemon.DefaultSocket()
	if err != nil {
		t.Fatal(err)
	}
	want, err := logfile.DefaultDir(goruntime.GOOS)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := daemonLogDir(defaultSocket); err != nil || got != want {
		t.Errorf("default socket logs in %q, %v; want %q", got, err, want)
	}
	if got, err := daemonLogDir("/tmp/dev/daemon.sock"); err != nil || got != "/tmp/dev/logs" {
		t.Errorf("other socket logs in %q, %v; want /tmp/dev/logs", got, err)
	}
}

// openDaemonLog writes the daemon's lines to stderr and daemon.log.
func TestOpenDaemonLogWritesBoth(t *testing.T) {
	t.Setenv("ZERO_LOG", "")
	socket := filepath.Join(t.TempDir(), "daemon.sock")
	var stderr bytes.Buffer
	logs := openDaemonLog(socket, &stderr)
	logs.logger.Info("hello from the daemon")
	logs.close()
	want := filepath.Join(filepath.Dir(socket), "logs", "daemon.log")
	if logs.file != want {
		t.Fatalf("log file = %q, want %q", logs.file, want)
	}
	data, err := os.ReadFile(logs.file)
	if err != nil || !strings.Contains(string(data), `msg="hello from the daemon"`) || !strings.Contains(stderr.String(), "hello from the daemon") {
		t.Errorf("file = %q, %v; stderr = %q", data, err, stderr.String())
	}
}
