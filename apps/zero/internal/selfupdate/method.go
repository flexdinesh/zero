// Package selfupdate finds out how zero was installed and what the latest
// release is, for `zero update` and its notice (decision 0147). It updates
// nothing itself: install.sh owns installation.
package selfupdate

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Kind is how the running zero was installed.
type Kind string

const (
	// KindScript: install.sh's ownership record names this exact binary.
	KindScript Kind = "script"
	// KindBundled: the copy inside the installed desktop app.
	KindBundled Kind = "bundled"
	// KindDev: not a release build (install-dev.sh, go run, local builds).
	KindDev Kind = "dev"
	// KindManaged: a package manager stamped version.InstallMethod.
	KindManaged Kind = "managed"
	// KindGoInstall: built by go install, which zero does not support.
	KindGoInstall Kind = "goinstall"
	// KindUnknown: none of the above.
	KindUnknown Kind = "unknown"
)

// Method is the detected install method.
type Method struct {
	Kind Kind
	// Manager is the stamp of a KindManaged install.
	Manager string
	// Desktop: a KindScript record also owns the desktop app.
	Desktop bool
}

// Environment is what Detect inspects.
type Environment struct {
	// Version is the resolved version (version.Number).
	Version string
	// InstallMethod is version.InstallMethod.
	InstallMethod string
	// GoInstall: no version was stamped, but build info carries a module
	// version.
	GoInstall bool
	// Executable is the running binary, symlinks resolved.
	Executable string
	// Home is the user's home directory.
	Home string
	// ConfigDir is zero's configuration directory (ConfigDir).
	ConfigDir string
}

// Detect reports how the running zero was installed. A malformed or
// unreadable ownership record means KindUnknown.
func Detect(env Environment) Method {
	switch {
	case env.InstallMethod != "":
		return Method{Kind: KindManaged, Manager: env.InstallMethod}
	case env.GoInstall:
		return Method{Kind: KindGoInstall}
	}
	if _, ok := ParseRelease(env.Version); !ok {
		return Method{Kind: KindDev}
	}
	if env.Executable == "" || env.Home == "" || env.ConfigDir == "" {
		return Method{Kind: KindUnknown}
	}
	record, ok := readRecord(filepath.Join(env.ConfigDir, "install.tsv"), env.Home)
	if !ok {
		return Method{Kind: KindUnknown}
	}
	if cli, found := record.rows["cli"]; found && samePath(cli.path, env.Executable) {
		if digest, err := fingerprint(env.Executable); err == nil && digest == cli.digest {
			_, desktop := record.rows["app"]
			return Method{Kind: KindScript, Desktop: desktop}
		}
		return Method{Kind: KindUnknown}
	}
	if app, found := record.rows["app"]; found {
		if resolved, err := filepath.EvalSymlinks(app.path); err == nil &&
			strings.HasPrefix(env.Executable, resolved+string(filepath.Separator)) {
			return Method{Kind: KindBundled}
		}
	}
	return Method{Kind: KindUnknown}
}

// ConfigDir is the directory install.sh keeps its ownership record in:
// ~/Library/Application Support/zero on macOS, else $XDG_CONFIG_HOME/zero
// when absolute, else ~/.config/zero.
func ConfigDir(goos string, getenv func(string) string, home string) string {
	if goos == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "zero")
	}
	base := getenv("XDG_CONFIG_HOME")
	if !strings.HasPrefix(base, "/") {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "zero")
}

type recordRow struct {
	path   string
	digest string
}

type record struct {
	rows map[string]recordRow
}

// readRecord parses install.tsv as data, with the install scripts' rules:
// header zero-install-v1, a name row, then unique role<TAB>path<TAB>digest
// rows. The CLI row must be the recorded name in ~/.local/bin or ~/bin.
func readRecord(path, home string) (record, bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return record{}, false
	}
	file, err := os.Open(path)
	if err != nil {
		return record{}, false
	}
	defer file.Close()
	scanner := bufio.NewScanner(io.LimitReader(file, 64<<10))
	if !scanner.Scan() || scanner.Text() != "zero-install-v1" {
		return record{}, false
	}
	if !scanner.Scan() {
		return record{}, false
	}
	kind, name, ok := strings.Cut(scanner.Text(), "\t")
	if !ok || kind != "name" || !validName(name) {
		return record{}, false
	}
	parsed := record{rows: map[string]recordRow{}}
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) != 3 || fields[2] == "" || strings.Trim(fields[2], "abcdef0123456789:ldx") != "" {
			return record{}, false
		}
		role, rowPath, digest := fields[0], fields[1], fields[2]
		if _, seen := parsed.rows[role]; seen {
			return record{}, false
		}
		switch role {
		case "cli":
			if rowPath != filepath.Join(home, ".local", "bin", name) && rowPath != filepath.Join(home, "bin", name) {
				return record{}, false
			}
		case "link", "app", "entry", "icon":
			if !filepath.IsAbs(rowPath) {
				return record{}, false
			}
		default:
			return record{}, false
		}
		parsed.rows[role] = recordRow{path: rowPath, digest: digest}
	}
	if scanner.Err() != nil {
		return record{}, false
	}
	return parsed, true
}

// validName mirrors the scripts' valid_name: a simple executable basename.
func validName(name string) bool {
	if name == "" || name == "zero-desktop" {
		return false
	}
	for i, r := range name {
		word := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if i == 0 && !word {
			return false
		}
		if !word && r != '.' && r != '+' && r != '-' {
			return false
		}
	}
	return true
}

func samePath(recorded, executable string) bool {
	resolved, err := filepath.EvalSymlinks(recorded)
	return err == nil && resolved == executable
}

// fingerprint is the install scripts' fingerprint of a regular file:
// f:<sha256 of its bytes>:<1 when executable, else 0>.
func fingerprint(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	executable := "0"
	if info.Mode().Perm()&0o111 != 0 {
		executable = "1"
	}
	return "f:" + hex.EncodeToString(hash.Sum(nil)) + ":" + executable, nil
}
