package selfupdate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// CheckPeriod is how often the update notice looks for a new release.
const CheckPeriod = 24 * time.Hour

// Check is the update notice's cache: when a release was last looked for,
// and the latest version the last successful look found.
type Check struct {
	CheckedAt time.Time `json:"checkedAt"`
	Latest    string    `json:"latest,omitempty"`
}

// Stale reports whether the cache is due another look at now.
func (c Check) Stale(now time.Time) bool {
	return c.CheckedAt.IsZero() || now.Sub(c.CheckedAt) >= CheckPeriod || c.CheckedAt.After(now)
}

// DefaultCheckPath is os.UserCacheDir()/zero/update-check.json.
func DefaultCheckPath() (string, error) {
	directory, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "zero", "update-check.json"), nil
}

// ReadCheck reads the cache; a missing or malformed file is an empty Check.
func ReadCheck(path string) Check {
	data, err := os.ReadFile(path)
	if err != nil {
		return Check{}
	}
	var check Check
	if json.Unmarshal(data, &check) != nil {
		return Check{}
	}
	if _, ok := ParseRelease(check.Latest); !ok {
		check.Latest = ""
	}
	return check
}

// WriteCheck replaces the cache atomically.
func WriteCheck(path string, check Check) error {
	data, err := json.Marshal(check)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	stage, err := os.CreateTemp(filepath.Dir(path), ".update-check-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(stage.Name()) }()
	if _, err := stage.Write(data); err != nil {
		_ = stage.Close()
		return err
	}
	if err := stage.Close(); err != nil {
		return err
	}
	return os.Rename(stage.Name(), path)
}

// MarkAttempt records a look starting at now, keeping the last result, so
// a failing network is tried once per CheckPeriod.
func MarkAttempt(path string, now time.Time) error {
	check := ReadCheck(path)
	check.CheckedAt = now
	return WriteCheck(path, check)
}
