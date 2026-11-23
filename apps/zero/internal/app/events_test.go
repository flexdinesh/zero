package app

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flexdinesh/zero/internal/document"
	"github.com/flexdinesh/zero/internal/files"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/internal/watch"
	"github.com/flexdinesh/zero/pkg/contract"
)

// followedApp is an App over one project with a real watch hub, counting
// its scans and signalling each one done.
type followedApp struct {
	app     *App
	root    string
	scans   atomic.Int32
	scanned chan struct{}
}

func newFollowedApp(t *testing.T) *followedApp {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "notes.md"), []byte("notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	options := watch.DefaultOptions()
	options.Debounce = 30 * time.Millisecond
	options.MaxWait = 200 * time.Millisecond
	hub := watch.NewHub(options)
	t.Cleanup(hub.Close)
	application, err := New(Config{Roots: roots, Depth: 5, Types: document.Builtins(), Watches: hub,
		WalkthroughDirectory: t.TempDir(), FeedbackDirectory: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	f := &followedApp{app: application, root: root, scanned: make(chan struct{}, 8)}
	application.Documents.scans.scan = func(root string) (*files.Index, error) {
		index, err := files.Scan(root, 5, func(string) bool { return true })
		f.scans.Add(1)
		f.scanned <- struct{}{}
		return index, err
	}
	return f
}

// firstStatus subscribes at lease and takes the first status.
func (f *followedApp) firstStatus(t *testing.T, lease string) (*Subscription, contract.StatusEvent) {
	t.Helper()
	subscription, err := f.app.Events.Subscribe(contract.EventsRequest{Project: f.root, Lease: lease})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(subscription.Close)
	select {
	case <-subscription.Ready():
	case <-time.After(5 * time.Second):
		t.Fatal("no first status")
	}
	events := subscription.Next()
	if len(events) == 0 || events[0].Status == nil {
		t.Fatalf("first events = %+v, want a status", events)
	}
	return subscription, *events[0].Status
}

func TestOpenSubscriptionScansOnceAndKeepsTheIndex(t *testing.T) {
	f := newFollowedApp(t)
	_, status := f.firstStatus(t, "open")
	if status.Mode == string(watch.ModeOff) {
		t.Fatalf("first status = %+v, want the tree followed", status)
	}
	select {
	case <-f.scanned:
	case <-time.After(5 * time.Second):
		t.Fatal("the first status started no scan")
	}
	tree, err := f.app.Documents.Tree(contract.TreeRequest{Project: f.root})
	if err != nil || tree.FileCount != 1 {
		t.Fatalf("Tree = %+v, %v; want its one file", tree, err)
	}
	page, err := f.app.Documents.Page(contract.PageRequest{Project: f.root, Path: "notes.md"})
	if err != nil || page.Source != "notes\n" {
		t.Fatalf("Page = %+v, %v; want notes.md", page, err)
	}
	if got := f.scans.Load(); got != 1 {
		t.Fatalf("scans = %d, want the subscription's one scan reused", got)
	}
}

func TestWatchedSubscriptionScansNothing(t *testing.T) {
	f := newFollowedApp(t)
	f.firstStatus(t, "watched")
	select {
	case <-f.scanned:
		t.Fatal("a watched subscription scanned the project")
	case <-time.After(200 * time.Millisecond):
	}
}
