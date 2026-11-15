package logfile

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDir(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	tests := []struct {
		name, goos, home string
		env              map[string]string
		want             string
	}{
		{"linux state home", "linux", "/home/u", map[string]string{"XDG_STATE_HOME": "/state"}, "/state/zero/logs"},
		{"linux relative state home ignored", "linux", "/home/u", map[string]string{"XDG_STATE_HOME": "state"}, "/home/u/.local/state/zero/logs"},
		{"linux default", "linux", "/home/u", nil, "/home/u/.local/state/zero/logs"},
		{"macOS ignores XDG", "darwin", "/Users/u", map[string]string{"XDG_STATE_HOME": "/state"}, "/Users/u/Library/Logs/zero"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Dir(test.goos, env(test.env), test.home)
			if err != nil || got != test.want {
				t.Fatalf("Dir = %q, %v; want %q", got, err, test.want)
			}
		})
	}
	if _, err := Dir("linux", env(nil), ""); err == nil {
		t.Error("Dir with no home and no XDG_STATE_HOME succeeded")
	}
	if _, err := Dir("darwin", env(nil), ""); err == nil {
		t.Error("Dir on macOS with no home succeeded")
	}
}

func TestFileRotatesAtItsLimitKeepingOneOlderFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "logs")
	path := Path(dir, "daemon")
	f, err := open(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, line := range []string{"first\n", "second\n", "third\n"} {
		if _, err := f.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	assertFile(t, path, "third\n")
	assertFile(t, path+".1", "second\n")
	info, err := os.Stat(dir)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Errorf("log directory mode = %v, %v; want 0700", info.Mode().Perm(), err)
	}
	info, err = os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("log file mode = %v, %v; want 0600", info.Mode().Perm(), err)
	}
}

func TestFileAppendsAcrossOpens(t *testing.T) {
	dir := t.TempDir()
	for _, line := range []string{"one\n", "two\n"} {
		f, err := Open(dir, "desktop")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
	}
	assertFile(t, Path(dir, "desktop"), "one\ntwo\n")
}

func TestFileRotatesWhenReopenedNearItsLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zero.log")
	if err := os.WriteFile(path, []byte("12345678\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := open(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write([]byte("next\n")); err != nil {
		t.Fatal(err)
	}
	assertFile(t, path, "next\n")
	assertFile(t, path+".1", "12345678\n")
}

func TestTailReadsTheRotatedFileWhenTheCurrentIsShort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zero.log")
	write(t, path+".1", "a\nb\nc\n")
	write(t, path, "d\ne\n")
	got, err := Tail(path, 3)
	if err != nil || strings.Join(got, ",") != "c,d,e" {
		t.Fatalf("Tail = %q, %v; want c,d,e", got, err)
	}
	got, err = Tail(path, 2)
	if err != nil || strings.Join(got, ",") != "d,e" {
		t.Fatalf("Tail 2 = %q, %v; want d,e", got, err)
	}
}

func TestTailOfMissingFilesIsEmpty(t *testing.T) {
	got, err := Tail(filepath.Join(t.TempDir(), "none.log"), 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("Tail = %q, %v; want none", got, err)
	}
}

func TestTailReadsOnlyTheEndOfALargeFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zero.log")
	var text strings.Builder
	for i := range 20000 {
		fmt.Fprintf(&text, "line %05d\n", i)
	}
	write(t, path, text.String())
	got, err := Tail(path, 1_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || len(got) > tailBytes/len("line 00000\n")+1 {
		t.Fatalf("Tail returned %d lines; want at most what 64 KiB holds", len(got))
	}
	if got[len(got)-1] != "line 19999" || !strings.HasPrefix(got[0], "line ") || len(got[0]) != len("line 00000") {
		t.Errorf("Tail = first %q, last %q; want whole lines ending at the last", got[0], got[len(got)-1])
	}
}

func TestRedact(t *testing.T) {
	credential := strings.Repeat("A", 43)
	tests := []struct{ in, want string }{
		{"open /home/dee/src/app", "open ~/src/app"},
		{"root /home/dee", "root ~"},
		{`path="/home/dee"`, `path="~"`},
		{"other /home/deeper/x", "other /home/deeper/x"},
		{"connect 10.0.0.2:4433/" + credential + " now", "connect 10.0.0.2:4433/<credential> now"},
		{"Authorization: Bearer abcdefghijklmnop", "Authorization: Bearer <token>"},
		{"token=abcdefghijklmnop&x=1", "token=<token>&x=1"},
		{"no secrets here", "no secrets here"},
	}
	for _, test := range tests {
		if got := Redact(test.in, "/home/dee/"); got != test.want {
			t.Errorf("Redact(%q) = %q; want %q", test.in, got, test.want)
		}
	}
	if got := Redact("/x", "/"); got != "/x" {
		t.Errorf("Redact with home / = %q; want unchanged", got)
	}
}

func TestParseLevel(t *testing.T) {
	for text, want := range map[string]slog.Level{"": slog.LevelInfo, "info": slog.LevelInfo, "DEBUG": slog.LevelDebug, "warn": slog.LevelWarn, "error": slog.LevelError} {
		if got, err := ParseLevel(text); err != nil || got != want {
			t.Errorf("ParseLevel(%q) = %v, %v; want %v", text, got, err, want)
		}
	}
	if _, err := ParseLevel("loud"); err == nil {
		t.Error("ParseLevel(loud) succeeded")
	}
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertFile(t *testing.T, path, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil || string(data) != want {
		t.Errorf("%s = %q, %v; want %q", filepath.Base(path), data, err, want)
	}
}
