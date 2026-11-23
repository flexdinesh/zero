package daemon

import (
	"errors"
	"io/fs"
	"log/slog"
	"path/filepath"
	"slices"
	"sync"

	"github.com/flexdinesh/zero/internal/app"
	"github.com/flexdinesh/zero/internal/files"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/pkg/contract"
)

// Roots owns the daemon's served roots and their file (decisions 0061,
// 0146): adds, opens, and removals serialize under mu and save. A save
// writes the served roots plus the roots skipped at load, so a root that
// overlapped another is not forgotten. A broad root (projects.Broad) is
// served for the daemon's lifetime but never saved, and the roots it
// replaced stay saved (decision 0194). It implements app.RootControl.
type Roots struct {
	mu      sync.Mutex
	set     *projects.RootSet
	skipped []string
	// held are saved roots a broad root replaced: not served, but kept in
	// every save so a restart serves them again.
	held []string
	file string
}

// NewRoots returns the roots of set, keeping skipped in every save to file.
func NewRoots(set *projects.RootSet, skipped []string, file string) *Roots {
	return &Roots{set: set, skipped: skipped, file: file}
}

// LoadedRoots reads the saved roots from file. A saved root that no longer
// exists, or is broad (decision 0194), stops being served: it is dropped
// and the file saved without it (decision 0146). Other roots that fail to
// load, such as overlapping ones, are skipped and kept. Each is logged.
func LoadedRoots(file string, log *slog.Logger) (*Roots, error) {
	saved, err := LoadRoots(file)
	if err != nil {
		return nil, err
	}
	set := &projects.RootSet{}
	var skipped []string
	dropped := false
	for _, root := range saved {
		if projects.Broad(root) {
			log.Info("no longer serving broad root", "root", root)
			dropped = true
			continue
		}
		_, _, err := set.Add(root)
		switch {
		case err == nil:
		case errors.Is(err, fs.ErrNotExist):
			log.Info("no longer serving missing root", "root", root)
			dropped = true
		default:
			log.Warn("skipping root", "root", root, "error", err)
			skipped = append(skipped, root)
		}
	}
	roots := NewRoots(set, skipped, file)
	if dropped {
		if err := roots.save(); err != nil {
			log.Warn("could not save roots", "error", err)
		}
	}
	return roots, nil
}

// Set is the served root set.
func (r *Roots) Set() *projects.RootSet { return r.set }

// List returns the served roots and the saved roots skipped at start.
func (r *Roots) List() contract.DaemonRoots {
	r.mu.Lock()
	defer r.mu.Unlock()
	return contract.DaemonRoots{Roots: nonNil(r.set.List()), Skipped: nonNil(slices.Clone(r.skipped))}
}

// Add serves path as a new root, refusing overlaps, and saves.
func (r *Roots) Add(path string) (string, bool, error) {
	if !filepath.IsAbs(path) {
		return "", false, &app.Error{Kind: contract.KindInvalid, Code: contract.CodeInvalidRoot, Message: "Root path must be absolute."}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	root, added, err := r.set.Add(path)
	if err != nil {
		return "", false, &app.Error{Kind: contract.KindInvalid, Code: contract.CodeInvalidRoot, Message: err.Error()}
	}
	if !added {
		return root, false, nil
	}
	r.skipped = slices.DeleteFunc(r.skipped, func(skipped string) bool { return skipped == root })
	if err := r.save(); err != nil {
		return root, true, notSaved(err)
	}
	return root, true, nil
}

// Open serves path, an absolute directory zero can read: within a served
// root nothing changes; otherwise it becomes a root, replacing the roots
// inside it, and is saved. A broad root is not saved, and the roots it
// replaced stay saved (decision 0194). A folder zero cannot read is refused
// with app.FolderError's explanation and nothing changes (decision 0146).
func (r *Roots) Open(path string) (contract.OpenedRoot, error) {
	if !filepath.IsAbs(path) {
		return contract.OpenedRoot{}, &app.Error{Kind: contract.KindInvalid, Code: contract.CodeInvalidRoot, Message: "Path must be absolute."}
	}
	if err := app.CheckFolder(path); err != nil {
		return contract.OpenedRoot{}, err
	}
	r.mu.Lock()
	root, added, replaced, err := r.set.Cover(path)
	if err != nil {
		r.mu.Unlock()
		return contract.OpenedRoot{}, &app.Error{Kind: contract.KindInvalid, Code: contract.CodeInvalidRoot, Message: err.Error()}
	}
	if added {
		if projects.Broad(root) {
			r.held = append(r.held, slices.DeleteFunc(slices.Clone(replaced), projects.Broad)...)
		} else {
			within := func(saved string) bool { return files.Within(root, saved) }
			r.skipped = slices.DeleteFunc(r.skipped, within)
			r.held = slices.DeleteFunc(r.held, within)
		}
		if err := r.save(); err != nil {
			r.mu.Unlock()
			return contract.OpenedRoot{}, notSaved(err)
		}
	}
	roots := r.set.List()
	r.mu.Unlock()
	project, err := projects.ProjectFor(roots, filepath.Clean(path))
	if err != nil {
		return contract.OpenedRoot{}, &app.Error{Kind: contract.KindNotFound, Code: contract.CodeProjectUnavailable, Message: "No project shows " + path + ": " + err.Error()}
	}
	return contract.OpenedRoot{Root: root, Added: added, Replaced: nonNil(replaced), Project: project}, nil
}

// Remove stops serving root, a served root or one skipped at start, saves,
// and returns the roots still served (decision 0146).
func (r *Roots) Remove(root string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	removed := r.set.Remove(root)
	if !removed {
		if index := slices.Index(r.skipped, root); index >= 0 {
			r.skipped = slices.Delete(r.skipped, index, index+1)
			removed = true
		}
	}
	if !removed {
		return nil, &app.Error{Kind: contract.KindNotFound, Code: contract.CodeNotServed, Message: "zero doesn't serve " + root + "."}
	}
	if err := r.save(); err != nil {
		return nil, &app.Error{Kind: contract.KindInternal, Code: contract.CodeRootsNotSaved, Message: "zero stopped serving the folder until the daemon stops, but could not save that: " + err.Error()}
	}
	return nonNil(r.set.List()), nil
}

// save writes the served roots but broad ones, the held roots, and the
// skipped roots; callers hold mu or own r.
func (r *Roots) save() error {
	saved := slices.DeleteFunc(r.set.List(), projects.Broad)
	saved = append(saved, r.held...)
	return SaveRoots(r.file, append(saved, r.skipped...))
}

func notSaved(err error) *app.Error {
	return &app.Error{Kind: contract.KindInternal, Code: contract.CodeRootsNotSaved, Message: "The root is served until the daemon stops but was not saved: " + err.Error()}
}
