package selfupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// install lays out what install.sh leaves: the CLI in ~/.local/bin, the app
// directory with its bundled zero, and install.tsv recording both.
type install struct {
	home, config, cli, bundled, app string
}

func newInstall(t *testing.T) install {
	t.Helper()
	home := t.TempDir()
	in := install{
		home:   home,
		config: filepath.Join(home, ".config", "zero"),
		cli:    filepath.Join(home, ".local", "bin", "zero"),
		app:    filepath.Join(home, ".local", "share", "zero-app", "app"),
	}
	in.bundled = filepath.Join(in.app, "bin", "zero")
	for _, path := range []string{in.cli, in.bundled} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("zero binary "+path), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return in
}

func scriptDigest(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return "f:" + hex.EncodeToString(sum[:]) + ":1"
}

func (in install) writeRecord(t *testing.T, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(in.config, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(in.config, "install.tsv"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (in install) env(executable string) Environment {
	return Environment{Version: "0.2.0", Executable: executable, Home: in.home, ConfigDir: in.config}
}

func TestDetect(t *testing.T) {
	in := newInstall(t)
	cliRow := "cli\t" + in.cli + "\t" + scriptDigest(t, in.cli)
	appRow := "app\t" + in.app + "\td:" + strings.Repeat("a", 64)

	tests := []struct {
		name       string
		record     []string
		env        Environment
		want       Method
		skipRecord bool
	}{
		{name: "full install", record: []string{"zero-install-v1", "name\tzero", appRow, cliRow}, env: in.env(in.cli), want: Method{Kind: KindScript, Desktop: true}},
		{name: "cli-only install", record: []string{"zero-install-v1", "name\tzero", cliRow}, env: in.env(in.cli), want: Method{Kind: KindScript}},
		{name: "bundled copy", record: []string{"zero-install-v1", "name\tzero", appRow, cliRow}, env: in.env(in.bundled), want: Method{Kind: KindBundled}},
		{name: "modified binary", record: []string{"zero-install-v1", "name\tzero", "cli\t" + in.cli + "\tf:" + strings.Repeat("0", 64) + ":1"}, env: in.env(in.cli), want: Method{Kind: KindUnknown}},
		{name: "no record", skipRecord: true, env: in.env(in.cli), want: Method{Kind: KindUnknown}},
		{name: "managed stamp wins", record: []string{"zero-install-v1", "name\tzero", cliRow}, env: Environment{Version: "0.2.0", InstallMethod: "homebrew", Executable: in.cli, Home: in.home, ConfigDir: in.config}, want: Method{Kind: KindManaged, Manager: "homebrew"}},
		{name: "go install", skipRecord: true, env: Environment{Version: "0.2.0", GoInstall: true}, want: Method{Kind: KindGoInstall}},
		{name: "dev build with a record", record: []string{"zero-install-v1", "name\tzero", cliRow}, env: Environment{Version: "0.0.0-dev.main", Executable: in.cli, Home: in.home, ConfigDir: in.config}, want: Method{Kind: KindDev}},
		{name: "unstamped build", skipRecord: true, env: Environment{Version: "dev"}, want: Method{Kind: KindDev}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_ = os.RemoveAll(in.config)
			if !test.skipRecord {
				in.writeRecord(t, test.record...)
			}
			if got := Detect(test.env); got != test.want {
				t.Fatalf("Detect() = %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestDetectRejectsMalformedRecords(t *testing.T) {
	in := newInstall(t)
	cliRow := "cli\t" + in.cli + "\t" + scriptDigest(t, in.cli)
	records := map[string][]string{
		"wrong header":     {"zero-install-v2", "name\tzero", cliRow},
		"missing name":     {"zero-install-v1", cliRow},
		"invalid name":     {"zero-install-v1", "name\t../zero", cliRow},
		"app name":         {"zero-install-v1", "name\tzero-app", cliRow},
		"old app name":     {"zero-install-v1", "name\tzero-desktop", cliRow},
		"extra field":      {"zero-install-v1", "name\tzero", cliRow + "\textra"},
		"duplicate role":   {"zero-install-v1", "name\tzero", cliRow, cliRow},
		"unknown role":     {"zero-install-v1", "name\tzero", "tool\t/x\tf:00:1", cliRow},
		"cli elsewhere":    {"zero-install-v1", "name\tzero", "cli\t/usr/local/bin/zero\t" + scriptDigest(t, in.cli)},
		"cli other name":   {"zero-install-v1", "name\tzero-cli", cliRow},
		"invalid digest":   {"zero-install-v1", "name\tzero", "cli\t" + in.cli + "\t$(rm -rf)"},
		"relative app row": {"zero-install-v1", "name\tzero", "app\tapp\td:00", cliRow},
	}
	for name, record := range records {
		t.Run(name, func(t *testing.T) {
			in.writeRecord(t, record...)
			if got := Detect(in.env(in.cli)); got.Kind != KindUnknown {
				t.Fatalf("Detect() = %+v, want unknown", got)
			}
		})
	}
}

func TestDetectFollowsSymlinkedBinDirectory(t *testing.T) {
	in := newInstall(t)
	real := filepath.Join(in.home, "real-bin")
	if err := os.Rename(filepath.Dir(in.cli), real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Dir(in.cli)); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(real, "zero")
	in.writeRecord(t, "zero-install-v1", "name\tzero", "cli\t"+in.cli+"\t"+scriptDigest(t, executable))
	if got := Detect(in.env(executable)); got.Kind != KindScript {
		t.Fatalf("Detect() = %+v, want script", got)
	}
}

func TestDetectRejectsSymlinkRecord(t *testing.T) {
	in := newInstall(t)
	in.writeRecord(t, "zero-install-v1", "name\tzero", "cli\t"+in.cli+"\t"+scriptDigest(t, in.cli))
	record := filepath.Join(in.config, "install.tsv")
	if err := os.Rename(record, record+".real"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(record+".real", record); err != nil {
		t.Fatal(err)
	}
	if got := Detect(in.env(in.cli)); got.Kind != KindUnknown {
		t.Fatalf("Detect() = %+v, want unknown", got)
	}
}

func TestFingerprintMatchesInstallScripts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zero")
	if err := os.WriteFile(path, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	// printf abc | sha256sum
	const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got, err := fingerprint(path); err != nil || got != "f:"+abc+":0" {
		t.Fatalf("fingerprint() = %q, %v", got, err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := fingerprint(path); err != nil || got != "f:"+abc+":1" {
		t.Fatalf("fingerprint() = %q, %v", got, err)
	}
}

func TestConfigDir(t *testing.T) {
	env := func(value string) func(string) string { return func(string) string { return value } }
	tests := []struct {
		goos, xdg, want string
	}{
		{"darwin", "/xdg", "/home/u/Library/Application Support/zero"},
		{"linux", "/xdg", "/xdg/zero"},
		{"linux", "relative", "/home/u/.config/zero"},
		{"linux", "", "/home/u/.config/zero"},
	}
	for _, test := range tests {
		if got := ConfigDir(test.goos, env(test.xdg), "/home/u"); got != test.want {
			t.Errorf("ConfigDir(%s, %q) = %q, want %q", test.goos, test.xdg, got, test.want)
		}
	}
}
