package daemon

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/internal/app"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/pkg/contract"
)

func TestRootsRemoveStopsServingAndSaves(t *testing.T) {
	parent := t.TempDir()
	work, personal := canonicalDir(t, parent, "work"), canonicalDir(t, parent, "personal")
	file := filepath.Join(t.TempDir(), "roots.json")
	set, err := projects.NewRootSet([]string{work, personal})
	if err != nil {
		t.Fatal(err)
	}
	overlapping := filepath.Join(work, "inner")
	roots := NewRoots(set, []string{overlapping}, file)

	left, err := roots.Remove(work)
	if err != nil || !reflect.DeepEqual(left, []string{personal}) {
		t.Fatalf("Remove(work) = %v, %v; want [personal]", left, err)
	}
	if saved, err := LoadRoots(file); err != nil || !reflect.DeepEqual(saved, []string{personal, overlapping}) {
		t.Fatalf("saved = %v, %v; want personal then the skipped root", saved, err)
	}
	// A skipped root stops being kept too.
	if _, err := roots.Remove(overlapping); err != nil {
		t.Fatalf("Remove(skipped) = %v", err)
	}
	if listed := roots.List(); !reflect.DeepEqual(listed, contract.DaemonRoots{Roots: []string{personal}, Skipped: []string{}}) {
		t.Fatalf("List() = %+v", listed)
	}
	var failure *app.Error
	if _, err := roots.Remove(work); !errors.As(err, &failure) || failure.Kind != contract.KindNotFound || failure.Code != contract.CodeNotServed {
		t.Fatalf("Remove(work) twice = %v; want not found %s", err, contract.CodeNotServed)
	}
}

func TestRootsOpenRefusesFoldersZeroCannotRead(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads every directory")
	}
	parent := t.TempDir()
	locked := canonicalDir(t, parent, "locked")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
	file := filepath.Join(t.TempDir(), "roots.json")
	roots := NewRoots(&projects.RootSet{}, nil, file)

	_, err := roots.Open(locked)
	var failure *app.Error
	if !errors.As(err, &failure) || failure.Kind != contract.KindForbidden || failure.Code != contract.CodeFolderUnreadable || !strings.Contains(failure.Message, locked) {
		t.Fatalf("Open(locked) = %v; want forbidden %s naming the folder", err, contract.CodeFolderUnreadable)
	}
	if served := roots.Set().List(); len(served) != 0 {
		t.Fatalf("roots = %v; want nothing served", served)
	}
	if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("roots file stat = %v; want nothing saved", err)
	}
}

// fakeHome makes a fresh folder the user's home, a broad folder (decision
// 0194), so tests never touch the real one.
func fakeHome(t *testing.T) string {
	t.Helper()
	home := canonicalDir(t, t.TempDir(), "home")
	t.Setenv("HOME", home)
	return home
}

func TestLoadedRootsDropsASavedBroadRoot(t *testing.T) {
	home := fakeHome(t)
	work := canonicalDir(t, t.TempDir(), "work")
	file := filepath.Join(t.TempDir(), "roots.json")
	if err := SaveRoots(file, []string{home, work}); err != nil {
		t.Fatal(err)
	}
	var logs strings.Builder
	roots, err := LoadedRoots(file, slog.New(slog.NewTextHandler(&logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if served := roots.Set().List(); !reflect.DeepEqual(served, []string{work}) {
		t.Fatalf("served = %v; want only work", served)
	}
	if !strings.Contains(logs.String(), `msg="no longer serving broad root" root=`+home) {
		t.Fatalf("log = %q; want the broad root's drop", logs.String())
	}
	if saved, err := LoadRoots(file); err != nil || !reflect.DeepEqual(saved, []string{work}) {
		t.Fatalf("saved = %v, %v; want the broad root dropped", saved, err)
	}
}

func TestRootsOpenServesABroadRootWithoutSavingIt(t *testing.T) {
	home := fakeHome(t)
	inner := canonicalDir(t, home, "code")
	other := canonicalDir(t, t.TempDir(), "other")
	file := filepath.Join(t.TempDir(), "roots.json")
	set, err := projects.NewRootSet([]string{inner, other})
	if err != nil {
		t.Fatal(err)
	}
	roots := NewRoots(set, nil, file)

	opened, err := roots.Open(home)
	if err != nil || opened.Root != home || !opened.Added || !reflect.DeepEqual(opened.Replaced, []string{inner}) {
		t.Fatalf("Open(home) = %+v, %v; want home added, replacing code", opened, err)
	}
	if served := roots.Set().List(); !reflect.DeepEqual(served, []string{home, other}) {
		t.Fatalf("served = %v; want home in code's place", served)
	}
	// The replaced root stays saved, so a restart serves it again.
	if saved, err := LoadRoots(file); err != nil || !reflect.DeepEqual(saved, []string{other, inner}) {
		t.Fatalf("saved = %v, %v; want other and the replaced code, not home", saved, err)
	}
	restarted, err := LoadedRoots(file, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	if served := restarted.Set().List(); !reflect.DeepEqual(served, []string{other, inner}) {
		t.Fatalf("served after restart = %v; want other and code", served)
	}

	// Stopping the broad root saves nothing new.
	if left, err := roots.Remove(home); err != nil || !reflect.DeepEqual(left, []string{other}) {
		t.Fatalf("Remove(home) = %v, %v; want [other]", left, err)
	}
	if saved, err := LoadRoots(file); err != nil || !reflect.DeepEqual(saved, []string{other, inner}) {
		t.Fatalf("saved after Remove = %v, %v; want unchanged", saved, err)
	}
}

func TestRootsOpenSavesAFolderThatIsNotBroad(t *testing.T) {
	fakeHome(t)
	parent := canonicalDir(t, t.TempDir(), "parent")
	inner := canonicalDir(t, parent, "inner")
	file := filepath.Join(t.TempDir(), "roots.json")
	set, err := projects.NewRootSet([]string{inner})
	if err != nil {
		t.Fatal(err)
	}
	roots := NewRoots(set, nil, file)
	if _, err := roots.Open(parent); err != nil {
		t.Fatal(err)
	}
	if saved, err := LoadRoots(file); err != nil || !reflect.DeepEqual(saved, []string{parent}) {
		t.Fatalf("saved = %v, %v; want parent in place of inner", saved, err)
	}
}
