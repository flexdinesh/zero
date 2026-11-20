// Package experimental decides whether the app shows features still being
// built (decision 0184): a development build always does, ZERO_EXPERIMENTAL
// in the app's environment says so either way, and otherwise the user's
// choice in Settings does, remembered here. It knows no mygo.
package experimental

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Env is the variable that turns experimental features on ("1") or off
// ("0"), over everything else.
const Env = "ZERO_EXPERIMENTAL"

// Sources say what decided a State. Off and Build and Env leave the user
// nothing to choose; Setting is their own choice.
const (
	SourceOff     = "off"
	SourceBuild   = "build"
	SourceEnv     = "env"
	SourceSetting = "setting"
)

// State is whether experimental features show, and what decided it: "" when
// nothing did and they are off.
type State struct {
	Enabled bool   `json:"enabled"`
	Source  string `json:"source"`
}

// Resolve decides the state from the build's stamp ("1" for development
// builds), the environment's value, and the stored choice. The environment's
// "0" wins over a stamped build, so a build that misbehaves can be run
// without its experiments.
func Resolve(stamp, env string, stored bool) State {
	switch {
	case env == "0":
		return State{Source: SourceOff}
	case stamp == "1":
		return State{Enabled: true, Source: SourceBuild}
	case env == "1":
		return State{Enabled: true, Source: SourceEnv}
	case stored:
		return State{Enabled: true, Source: SourceSetting}
	}
	return State{}
}

// Store remembers the user's choice in one JSON file (0600). A missing or
// unreadable file is off; an empty path keeps the choice in memory.
type Store struct {
	path    string
	mu      sync.Mutex
	enabled bool
}

type saved struct {
	Enabled bool `json:"enabled"`
}

// Open reads the store at path.
func Open(path string) *Store {
	s := &Store{path: path}
	if path == "" {
		return s
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var value saved
	if json.Unmarshal(data, &value) == nil {
		s.enabled = value.Enabled
	}
	return s
}

// Enabled is the stored choice.
func (s *Store) Enabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enabled
}

// Set remembers the choice.
func (s *Store) Set(enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.enabled == enabled {
		return nil
	}
	s.enabled = enabled
	if s.path == "" {
		return nil
	}
	data, err := json.Marshal(saved{Enabled: enabled})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(s.path), ".experimental-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), s.path)
}
