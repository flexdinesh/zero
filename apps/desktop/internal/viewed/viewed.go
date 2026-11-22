// Package viewed keeps review Viewed marks by repository identity for every
// window of the app (decision 0188): a file path and the blob it was marked
// at, so the marks of one repository follow it between local and remote
// windows. Pages are untrusted: only well-formed identities, paths, and
// blobs are kept, within the web app's bounds. It knows no mygo.
package viewed

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
)

// Bounds match the web app's (review-viewed.ts): the most recently set
// identities and files are kept.
const (
	MaxIdentities = 50
	MaxFiles      = 2000
	// MaxIdentity and MaxPath bound one identity and one file path.
	MaxIdentity = 512
	MaxPath     = 4096
)

var (
	blobPattern     = regexp.MustCompile(`^[0-9a-f]{40}$`)
	identityPattern = regexp.MustCompile(`^[a-z0-9._:\[\]-]+(/[^/\s]+)+$`)
)

// IsIdentity reports a repository identity as the server writes one:
// lowercase "host/path".
func IsIdentity(identity string) bool {
	return len(identity) <= MaxIdentity && identityPattern.MatchString(identity) && identity == strings.ToLower(identity)
}

// IsPath reports a project-relative file path a mark may name.
func IsPath(path string) bool {
	return path != "" && len(path) <= MaxPath && !strings.ContainsRune(path, 0) && !strings.HasPrefix(path, "/") && path != "__proto__"
}

// IsBlob reports a git blob hash.
func IsBlob(blob string) bool { return blobPattern.MatchString(blob) }

// entry is one identity's marks, in the order they were set.
type entry struct {
	Identity string      `json:"identity"`
	Files    [][2]string `json:"files"`
}

// Store holds marks in one JSON file (0600), most recently set identity
// last. A missing or unreadable file is an empty store; an empty path keeps
// marks in memory.
type Store struct {
	path    string
	mu      sync.Mutex
	entries []entry
}

// Open reads the store at path, dropping what is not valid.
func Open(path string) *Store {
	s := &Store{path: path}
	if path == "" {
		return s
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var saved []entry
	if json.Unmarshal(data, &saved) != nil {
		return s
	}
	seen := map[string]bool{}
	for _, e := range saved {
		if !IsIdentity(e.Identity) || seen[e.Identity] {
			continue
		}
		seen[e.Identity] = true
		s.entries = append(s.entries, entry{Identity: e.Identity, Files: valid(e.Files)})
	}
	if len(s.entries) > MaxIdentities {
		s.entries = s.entries[len(s.entries)-MaxIdentities:]
	}
	return s
}

// valid keeps well-formed files, the last of each path, the most recent
// MaxFiles.
func valid(files [][2]string) [][2]string {
	seen := map[string]bool{}
	kept := make([][2]string, 0, min(len(files), MaxFiles))
	for i := len(files) - 1; i >= 0 && len(kept) < MaxFiles; i-- {
		file := files[i]
		if !IsPath(file[0]) || !IsBlob(file[1]) || seen[file[0]] {
			continue
		}
		seen[file[0]] = true
		kept = append(kept, file)
	}
	slices.Reverse(kept)
	return kept
}

// Get returns identity's marks, path to blob; empty when it has none.
func (s *Store) Get(identity string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	marks := map[string]string{}
	for _, e := range s.entries {
		if e.Identity == identity {
			for _, file := range e.Files {
				marks[file[0]] = file[1]
			}
		}
	}
	return marks
}

// Set replaces identity's marks with files (path, blob pairs in the order
// they were marked) and makes it the most recent identity. Invalid files are
// dropped; no files forget the identity.
func (s *Store) Set(identity string, files [][2]string) error {
	if !IsIdentity(identity) {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := make([]entry, 0, len(s.entries)+1)
	for _, e := range s.entries {
		if e.Identity != identity {
			kept = append(kept, e)
		}
	}
	if files = valid(files); len(files) > 0 {
		kept = append(kept, entry{Identity: identity, Files: files})
	}
	if len(kept) > MaxIdentities {
		kept = kept[len(kept)-MaxIdentities:]
	}
	s.entries = kept
	return s.save()
}

// save writes the marks atomically. Callers hold mu.
func (s *Store) save() error {
	if s.path == "" {
		return nil
	}
	data, err := json.Marshal(s.entries)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(s.path), ".viewed-*.json")
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
