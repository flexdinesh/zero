package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/flexdinesh/zero/internal/document"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/pkg/contract"
)

// addRemote adds a remote to a repository's shared config.
func addRemote(t *testing.T, root, name, url string) {
	t.Helper()
	config, err := os.OpenFile(filepath.Join(root, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = config.Close() }()
	if _, err := config.WriteString("[remote \"" + name + "\"]\n\turl = " + url + "\n"); err != nil {
		t.Fatal(err)
	}
}

// feedbackAt serves root with the same feedback store as r.
func feedbackAt(t *testing.T, r *feedbackRepo, root string) *Feedback {
	t.Helper()
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	application, err := New(Config{Roots: roots, Depth: 5, Types: document.Builtins(), WalkthroughDirectory: t.TempDir(), FeedbackDirectory: r.directory})
	if err != nil {
		t.Fatal(err)
	}
	return application.Feedback
}

// A repository that moves keeps its feedback through its identity
// (decision 0188).
func TestFeedbackFollowsAMovedRepositoryByIdentity(t *testing.T) {
	r := newFeedbackRepo(t)
	addRemote(t, r.root, "origin", "git@github.com:me/zero.git")
	thread := r.thread(contract.FeedbackThreadDraft{Path: "main.go", Lines: []int{2, 3}, Body: "Rename greet."})
	before := r.get(contract.FeedbackRequest{})

	moved := filepath.Join(filepath.Dir(r.root), filepath.Base(r.root)+"-moved")
	if err := os.Rename(r.root, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(moved) })
	reviews := feedbackAt(t, r, moved)
	ctx := context.Background()
	for _, request := range []contract.FeedbackRequest{{Project: moved}, {Project: moved, ID: before.ID}} {
		got, err := reviews.Get(ctx, request)
		if err != nil || got.ID != before.ID || len(got.Threads) != 1 || got.Threads[0].Number != thread.Number {
			t.Fatalf("Get(%+v) after the move = %+v, %v; want feedback %s", request, got, err, before.ID)
		}
	}
	list, err := reviews.List(contract.FeedbackListRequest{Project: moved})
	if err != nil || len(list) != 1 || list[0].ID != before.ID {
		t.Fatalf("List after the move = %+v, %v", list, err)
	}

	// New threads join the same feedback instead of starting another.
	added, err := reviews.CreateThread(ctx, contract.FeedbackThreadDraft{Project: moved, Path: "old.txt", Lines: []int{1, 1}, Body: "Drop this."})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := reviews.Get(ctx, contract.FeedbackRequest{Project: moved}); err != nil || got.ID != before.ID || len(got.Threads) != 2 || added.Number != 2 {
		t.Errorf("after a new thread = %+v, %v", got, err)
	}
}

// Feedback stays keyed by its path: adding an upstream remote, which changes
// the identity, orphans nothing.
func TestFeedbackKeepsItsPathKeyWhenTheIdentityChanges(t *testing.T) {
	r := newFeedbackRepo(t)
	addRemote(t, r.root, "origin", "git@github.com:me/zero.git")
	r.thread(contract.FeedbackThreadDraft{Path: "main.go", Lines: []int{1, 1}, Body: "First."})
	before := r.get(contract.FeedbackRequest{})
	addRemote(t, r.root, "upstream", "https://github.com/flexdinesh/zero.git")
	if got := r.get(contract.FeedbackRequest{}); got.ID != before.ID || len(got.Threads) != 1 {
		t.Errorf("after adding upstream = %+v, want feedback %s", got, before.ID)
	}
}

// A moved repository without an identity has nothing to follow.
func TestFeedbackWithoutIdentityStaysWithItsPath(t *testing.T) {
	r := newFeedbackRepo(t)
	r.thread(contract.FeedbackThreadDraft{Path: "main.go", Lines: []int{1, 1}, Body: "First."})
	moved := filepath.Join(filepath.Dir(r.root), filepath.Base(r.root)+"-moved")
	if err := os.Rename(r.root, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(moved) })
	// The branch reads as having no feedback yet.
	if got, err := feedbackAt(t, r, moved).Get(context.Background(), contract.FeedbackRequest{Project: moved}); err != nil || got.ID != "" || len(got.Threads) != 0 {
		t.Errorf("Get after the move = %+v, %v; want no feedback", got, err)
	}
}
