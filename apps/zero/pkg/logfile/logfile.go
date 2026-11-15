// Package logfile keeps zero's persistent logs (decision 0151): where they
// live, a size-rotated file, crash output, reading the newest lines back, and
// redacting them for a problem report. The daemon and the desktop app share
// it; it knows no server or UI.
package logfile

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
)

const (
	// MaxBytes is the size a log file grows to before it rotates. One older
	// file is kept, so a log takes at most twice this.
	MaxBytes = 5 << 20
	// tailBytes bounds what Tail reads from each file.
	tailBytes = 64 << 10
)

// Dir is where a user's logs live: $XDG_STATE_HOME/zero/logs on Linux, else
// ~/.local/state/zero/logs; ~/Library/Logs/zero on macOS. A relative
// XDG_STATE_HOME is ignored, as the XDG spec asks.
func Dir(goos string, getenv func(string) string, home string) (string, error) {
	if goos == "darwin" {
		if home == "" {
			return "", errors.New("locate logs: no home directory")
		}
		return filepath.Join(home, "Library", "Logs", "zero"), nil
	}
	if state := getenv("XDG_STATE_HOME"); state != "" && filepath.IsAbs(state) {
		return filepath.Join(state, "zero", "logs"), nil
	}
	if home == "" {
		return "", errors.New("locate logs: no home directory")
	}
	return filepath.Join(home, ".local", "state", "zero", "logs"), nil
}

// DefaultDir is this user's Dir.
func DefaultDir(goos string) (string, error) {
	home, _ := os.UserHomeDir()
	return Dir(goos, os.Getenv, home)
}

// Path is the current log file named name in dir.
func Path(dir, name string) string { return filepath.Join(dir, name+".log") }

// CrashPath is the crash output file named name in dir.
func CrashPath(dir, name string) string { return filepath.Join(dir, name+"-crash.log") }

// File is a log file that rotates at MaxBytes: <name>.log becomes
// <name>.log.1, replacing the older one. It is safe for concurrent use.
type File struct {
	path string
	max  int64

	mu   sync.Mutex
	file *os.File
	size int64
}

// Open opens <name>.log in dir for appending, creating dir (0700) and the
// file (0600).
func Open(dir, name string) (*File, error) {
	return open(Path(dir, name), MaxBytes)
}

func open(path string, max int64) (*File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f := &File{path: path, max: max}
	if err := f.reopen(); err != nil {
		return nil, err
	}
	return f, nil
}

func (f *File) reopen() error {
	file, err := os.OpenFile(f.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	f.file, f.size = file, info.Size()
	return nil
}

// Write appends p, first rotating when p would take the file past its limit.
func (f *File) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.file == nil {
		return 0, os.ErrClosed
	}
	if f.size > 0 && f.size+int64(len(p)) > f.max {
		if err := f.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := f.file.Write(p)
	f.size += int64(n)
	return n, err
}

func (f *File) rotate() error {
	if err := f.file.Close(); err != nil {
		return err
	}
	f.file = nil
	if err := os.Rename(f.path, f.path+".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return f.reopen()
}

// Path is the current file's path.
func (f *File) Path() string { return f.path }

// Close closes the file; later writes fail.
func (f *File) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.file == nil {
		return nil
	}
	err := f.file.Close()
	f.file = nil
	return err
}

// CaptureCrashes has the Go runtime also write a fatal panic or error to
// <name>-crash.log in dir, rotated as File rotates when it opens. The file
// stays open for the process's life.
func CaptureCrashes(dir, name string) error {
	path := CrashPath(dir, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if info, err := os.Stat(path); err == nil && info.Size() > MaxBytes {
		if err := os.Rename(path, path+".1"); err != nil {
			return err
		}
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer file.Close() // SetCrashOutput keeps its own descriptor.
	return debug.SetCrashOutput(file, debug.CrashOptions{})
}

// Tail returns up to n of the newest lines of path, reading the rotated
// <path>.1 first when path holds fewer. Each file contributes at most its
// last 64 KiB; a missing file contributes nothing.
func Tail(path string, n int) ([]string, error) {
	if n <= 0 {
		return nil, nil
	}
	current, err := lastLines(path)
	if err != nil {
		return nil, err
	}
	if len(current) < n {
		older, err := lastLines(path + ".1")
		if err != nil {
			return nil, err
		}
		current = append(older, current...)
	}
	if len(current) > n {
		current = current[len(current)-n:]
	}
	return current, nil
}

// lastLines reads the last tailBytes of path as lines, dropping a first line
// the read cut short.
func lastLines(path string) ([]string, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	offset := max(info.Size()-tailBytes, 0)
	data, err := io.ReadAll(io.NewSectionReader(file, offset, info.Size()-offset))
	if err != nil {
		return nil, err
	}
	if offset > 0 {
		if cut := bytes.IndexByte(data, '\n'); cut >= 0 {
			data = data[cut+1:]
		} else {
			data = nil
		}
	}
	text := strings.TrimRight(string(data), "\n")
	if text == "" {
		return nil, nil
	}
	return strings.Split(text, "\n"), nil
}

var (
	// credentialText is a connection string's credential: base64url of a
	// 16-byte fingerprint and a 16-byte token, after the address's slash.
	credentialText = regexp.MustCompile(`/[A-Za-z0-9_-]{43}\b`)
	// tokenText is a token named as one: a bearer header or a token= or
	// token: value.
	tokenText = regexp.MustCompile(`(?i)(bearer\s+|token["']?\s*[=:]\s*["']?)[A-Za-z0-9_.~+/-]{8,}=*`)
)

// Redact replaces home with ~ where it starts a path, and connection
// credentials and tokens with placeholders, so a report can be shared. It
// knows only these patterns; the user reviews what it leaves.
func Redact(text, home string) string {
	text = credentialText.ReplaceAllString(text, "/<credential>")
	text = tokenText.ReplaceAllString(text, "${1}<token>")
	home = strings.TrimRight(home, `/\`)
	if home == "" || home == "/" {
		return text
	}
	var out strings.Builder
	for {
		i := strings.Index(text, home)
		if i < 0 {
			out.WriteString(text)
			return out.String()
		}
		end := i + len(home)
		boundary := end == len(text) || strings.ContainsRune(`/\ "':,;)]}`+"\n\t", rune(text[end]))
		out.WriteString(text[:i])
		if boundary {
			out.WriteString("~")
		} else {
			out.WriteString(home)
		}
		text = text[end:]
	}
}

// RedactLines redacts each line.
func RedactLines(lines []string, home string) []string {
	if lines == nil {
		return nil
	}
	result := make([]string, len(lines))
	for i, line := range lines {
		result[i] = Redact(line, home)
	}
	return result
}

// ParseLevel reads ZERO_LOG: debug, info, warn, or error, without case.
// Empty means info; anything else is an error.
func ParseLevel(text string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "", "info":
		return slog.LevelInfo, nil
	case "debug":
		return slog.LevelDebug, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	}
	return slog.LevelInfo, fmt.Errorf("ZERO_LOG=%q is not debug, info, warn, or error", text)
}
