package feedback

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A thread whose JSON write failed after its upload moved in leaves the
// feedback as it was and the screenshot unreferenced: the next write sweeps
// it, and the client's retry with a fresh upload makes the thread.
func TestFailedThreadWriteLeavesAnOrphanForTheSweep(t *testing.T) {
	service, _ := testService(t)
	created, _, err := service.AddThread(Target{Repository: "r", Branch: "b", Project: "/p"}, NewThread{Anchor: lineAnchor("a", 1, 1), Author: AuthorUser, Body: "code"})
	if err != nil {
		t.Fatal(err)
	}
	interrupted := stageVisual(t, service, "r", 4, 4)
	// What adopt leaves when the JSON write after it fails: the upload moved
	// into the feedback's directory, the JSON unchanged.
	orphan := service.store.AttachmentFile("r", created.ID, interrupted.Visual.Attachment.ID)
	if err := os.MkdirAll(filepath.Dir(orphan), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(service.store.stagingFile("r", interrupted.Visual.Attachment.ID), orphan); err != nil {
		t.Fatal(err)
	}

	read, err := service.Get("r", created.ID)
	if err != nil || len(read.Threads) != 1 || read.NextThread != 2 {
		t.Fatalf("feedback after a failed write = %d threads, next %d, %v; want unchanged", len(read.Threads), read.NextThread, err)
	}
	if _, _, err := service.AttachmentFile(read, interrupted.Visual.Attachment.ID); err == nil {
		t.Error("the orphan is served though no thread names it")
	}

	// Retrying the same upload ID fails: it is no longer staged.
	if _, _, err := service.AddThread(Target{Repository: "r", ID: created.ID, Project: "/p"}, interrupted); err == nil || err.Error() != "invalid feedback: visual.attachment: "+staleUpload {
		t.Errorf("retry with the moved upload = %v", err)
	}
	// That write swept the orphan first.
	if _, err := os.Lstat(orphan); !os.IsNotExist(err) {
		t.Errorf("orphan after the next write = %v, want swept", err)
	}

	retry := stageVisual(t, service, "r", 4, 4)
	stored, thread, err := service.AddThread(Target{Repository: "r", ID: created.ID, Project: "/p"}, retry)
	if err != nil {
		t.Fatal(err)
	}
	if thread.Number != 2 || len(stored.Threads) != 2 || !service.HasAttachment("r", created.ID, retry.Visual.Attachment.ID) {
		t.Errorf("retried thread = #%d of %d, attachment held %v", thread.Number, len(stored.Threads), service.HasAttachment("r", created.ID, retry.Visual.Attachment.ID))
	}
}

// An upload interrupted before its rename leaves a temporary file in
// staging; the sweep removes it once it is a staged lifetime old and keeps a
// younger one, which may still be being written (decision 0179).
func TestSweepRemovesInterruptedUploads(t *testing.T) {
	service, _ := testService(t)
	if _, err := service.Stage("r", testPNG(t, 1, 1)); err != nil {
		t.Fatal(err)
	}
	staging := filepath.Dir(service.store.stagingFile("r", "at-aaaaaaaaaa"))
	now := service.now()
	stale := filepath.Join(staging, stagingTemporary+"111")
	fresh := filepath.Join(staging, stagingTemporary+"222")
	other := filepath.Join(staging, "notes.txt")
	for name, modified := range map[string]time.Time{stale: now.Add(-StagedLifetime - time.Minute), fresh: now, other: now.Add(-48 * time.Hour)} {
		if err := os.WriteFile(name, []byte("partial"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(name, modified, modified); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := service.Stage("r", testPNG(t, 1, 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(stale); !os.IsNotExist(err) {
		t.Errorf("stale temporary file = %v, want swept", err)
	}
	for _, name := range []string{fresh, other} {
		if _, err := os.Lstat(name); err != nil {
			t.Errorf("%s = %v, want kept", filepath.Base(name), err)
		}
	}
}
