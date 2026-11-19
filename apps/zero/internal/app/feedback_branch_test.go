package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/flexdinesh/zero/internal/document"
	"github.com/flexdinesh/zero/internal/feedback"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/pkg/contract"
)

// One branch review holds code and screen comments: both join the branch's
// feedback, numbered in turn; the review's compare places the code threads
// and leaves the visual one unplaced; deleting either kind leaves the
// other's thread and screenshot alone.
func TestFeedbackCodeAndVisualThreadsInOneBranchReview(t *testing.T) {
	r := newFeedbackRepo(t)
	r.checkout("topic", true)
	r.write("main.go", "package main\n\nimport \"os\"\n\nfunc main() {\n\tgreet()\n\tos.Exit(0)\n}\n")
	r.commit("topic")
	branch := &contract.FeedbackCompare{Kind: contract.FeedbackCompareBranch, Base: "master"}

	first := r.thread(contract.FeedbackThreadDraft{Compare: branch, Path: "main.go", Lines: []int{7, 7}, Body: "Exit code?"})
	visual, err := r.feedback.CreateThread(context.Background(), r.visualDraft("draft-page.json", 612, 288))
	if err != nil {
		t.Fatal(err)
	}
	last := r.thread(contract.FeedbackThreadDraft{Compare: branch, Path: "main.go", Lines: []int{3, 3}, Body: "Why os?"})
	if first.Number != 1 || visual.Number != 2 || last.Number != 3 {
		t.Fatalf("threads = #%d, #%d, #%d; want 1, 2, 3", first.Number, visual.Number, last.Number)
	}

	review := r.get(contract.FeedbackRequest{Compare: branch})
	if review.Branch != "topic" || len(review.Threads) != 3 {
		t.Fatalf("branch review = %s on %s with %d threads", review.ID, review.Branch, len(review.Threads))
	}
	for _, thread := range []contract.FeedbackThread{review.Threads[0], review.Threads[2]} {
		if thread.Anchor == nil || thread.Visual != nil || thread.Location == nil || thread.Location.State != contract.FeedbackAnchored {
			t.Errorf("code thread #%d = anchor %v, visual %v, location %v", thread.Number, thread.Anchor, thread.Visual, thread.Location)
		}
	}
	if shot := review.Threads[1]; shot.Anchor != nil || shot.Location != nil || shot.Visual == nil || !shot.Visual.Available || shot.Visual.Head == "" {
		t.Errorf("visual thread = anchor %v, location %v, visual %+v", shot.Anchor, shot.Location, shot.Visual)
	}

	screenshot := contract.FeedbackAttachmentRequest{Project: r.root, ID: review.ID, Attachment: visual.Visual.Attachment.ID}
	name, err := r.feedback.AttachmentPath(screenshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.feedback.DeleteThread(contract.FeedbackDeleteRequest{Project: r.root, ID: review.ID, Thread: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(name); err != nil {
		t.Errorf("screenshot after deleting a code thread = %v, want kept", err)
	}
	if err := r.feedback.DeleteThread(contract.FeedbackDeleteRequest{Project: r.root, ID: review.ID, Thread: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(name); !os.IsNotExist(err) {
		t.Errorf("screenshot after deleting its thread = %v, want removed", err)
	}
	after := r.get(contract.FeedbackRequest{Compare: branch})
	if len(after.Threads) != 1 || after.Threads[0].Number != 3 || after.Threads[0].Location == nil || after.Threads[0].Location.State != contract.FeedbackAnchored {
		t.Errorf("after deletions = %+v", after.Threads)
	}
}

// A feedback a zero before 0176 wrote reads as code threads with locations.
func TestFeedbackFromBefore0176ReadsAsCodeThreads(t *testing.T) {
	r := newFeedbackRepo(t)
	directory := filepath.Join(t.TempDir(), "feedback")
	roots, err := projects.NewRootSet([]string{r.root})
	if err != nil {
		t.Fatal(err)
	}
	application, err := New(Config{Roots: roots, Depth: 5, Types: document.Builtins(), WalkthroughDirectory: t.TempDir(), FeedbackDirectory: directory})
	if err != nil {
		t.Fatal(err)
	}

	var stored map[string]any
	if err := json.Unmarshal(visualFixture(t, filepath.Join("..", "code-only.json")), &stored); err != nil {
		t.Fatal(err)
	}
	repository := FeedbackRepository(r.root)
	stored["repository"], stored["branch"], stored["project"] = repository, "master", r.root
	data, err := json.Marshal(stored)
	if err != nil {
		t.Fatal(err)
	}
	id, ok := stored["id"].(string)
	if !ok {
		t.Fatal("code-only.json has no id")
	}
	// The repository's directory holds <id>/ for attachments and <id>.json.
	repositoryDirectory := filepath.Dir(filepath.Dir(feedback.NewStore(directory).AttachmentFile(repository, id, "at-aaaaaaaaaa")))
	if err := os.MkdirAll(repositoryDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repositoryDirectory, id+".json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	read, err := application.Feedback.Get(context.Background(), contract.FeedbackRequest{Project: r.root, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	if read.ID != id || len(read.Threads) != 2 || read.Threads[0].Number != 1 || read.Threads[0].Status != contract.FeedbackStatusResolved || len(read.Threads[0].Messages) != 3 || read.Threads[1].Number != 3 {
		t.Fatalf("old feedback = %+v", read)
	}
	for _, thread := range read.Threads {
		if thread.Anchor == nil || thread.Location == nil || thread.Visual != nil {
			t.Errorf("old thread #%d = anchor %v, location %v, visual %v", thread.Number, thread.Anchor, thread.Location, thread.Visual)
		}
	}
}
