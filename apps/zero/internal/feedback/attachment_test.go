package feedback

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// stageVisual stages a PNG of width×height for repository and returns a
// thread taking it.
func stageVisual(t *testing.T, service *Service, repository string, width, height int) NewThread {
	t.Helper()
	upload, err := service.Stage(repository, testPNG(t, width, height))
	if err != nil {
		t.Fatal(err)
	}
	image, live, found := service.Staged(repository, upload.ID)
	if !found || !live || image != upload.Attachment {
		t.Fatalf("Staged(%s) = %+v, %v, %v; want %+v", upload.ID, image, live, found, upload.Attachment)
	}
	return NewThread{Visual: &Visual{Attachment: image, Rect: Rect{Width: 1, Height: 1}}, Author: AuthorUser, Body: "look"}
}

func TestStageAndAdoptAnAttachment(t *testing.T) {
	service, directory := testService(t)
	data := withChunks(testPNG(t, 6, 3), pngChunk("tEXt", []byte("Comment\x00secret")))
	upload, err := service.Stage("r", data)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^at-[a-z2-7]{10}$`).MatchString(upload.ID) || upload.Width != 6 || upload.Height != 3 || upload.MediaType != MediaTypePNG {
		t.Errorf("upload = %+v", upload)
	}
	staged := service.store.stagingFile("r", upload.ID)
	stored, err := os.ReadFile(staged)
	if err != nil || strings.Contains(string(stored), "secret") || int64(len(stored)) != upload.Bytes {
		t.Fatalf("staged file = %d bytes, %v; want %d without metadata", len(stored), err, upload.Bytes)
	}
	if sum := sha256.Sum256(stored); hex.EncodeToString(sum[:]) != upload.SHA256 {
		t.Errorf("upload sha256 = %s, want the stored file's", upload.SHA256)
	}
	info, _ := os.Stat(staged)
	if want := info.ModTime().Add(StagedLifetime); !upload.ExpiresAt.Equal(want) || info.Mode().Perm() != 0o600 {
		t.Errorf("expiresAt = %v, mode %v; want %v, 0600", upload.ExpiresAt, info.Mode().Perm(), want)
	}

	image, _, _ := service.Staged("r", upload.ID)
	feedback, thread, err := service.AddThread(Target{Repository: "r", Branch: "b", Project: "/p"}, NewThread{Visual: &Visual{Attachment: image, Rect: Rect{Width: 6, Height: 3}}, Author: AuthorUser, Body: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if thread.Visual == nil || thread.Anchor != nil || thread.Visual.Attachment != image {
		t.Errorf("visual thread = %+v", thread)
	}
	if _, err := os.Lstat(staged); !os.IsNotExist(err) {
		t.Errorf("staged file after adoption = %v, want moved", err)
	}
	file := filepath.Join(directory, filepath.Base(service.store.repositoryDirectory("r")), feedback.ID, upload.ID+".png")
	if got := service.store.AttachmentFile("r", feedback.ID, upload.ID); got != file || !service.HasAttachment("r", feedback.ID, upload.ID) {
		t.Errorf("AttachmentFile = %s, want %s, there", got, file)
	}
	if name, metadata, err := service.AttachmentFile(feedback, upload.ID); err != nil || name != file || metadata != image {
		t.Errorf("Service.AttachmentFile = %s, %+v, %v", name, metadata, err)
	}

	// An upload taken once is no longer staged.
	if _, _, err := service.AddThread(Target{Repository: "r", ID: feedback.ID, Project: "/p"}, NewThread{Visual: &Visual{Attachment: image}, Author: AuthorUser, Body: "again"}); err == nil || err.Error() != "invalid feedback: visual.attachment: "+staleUpload {
		t.Errorf("adopting an upload twice = %v", err)
	}

	// Deleting the thread deletes its attachment.
	if _, err := service.DeleteThread("r", feedback.ID, thread.Number); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(file); !os.IsNotExist(err) {
		t.Errorf("attachment after its thread was deleted = %v", err)
	}
}

func TestDeletingFeedbackRemovesItsAttachments(t *testing.T) {
	service, _ := testService(t)
	service.store.limit = 1
	created, _, err := service.AddThread(Target{Repository: "r", Branch: "one", Project: "/p"}, stageVisual(t, service, "r", 2, 2))
	if err != nil {
		t.Fatal(err)
	}
	directory := service.store.attachmentDirectory("r", created.ID)
	if _, err := os.Stat(directory); err != nil {
		t.Fatal(err)
	}
	// A second branch's feedback evicts the first past the limit of 1.
	if _, _, err := service.AddThread(Target{Repository: "r", Branch: "two", Project: "/p"}, NewThread{Anchor: lineAnchor("a", 1, 1), Author: AuthorUser, Body: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Errorf("evicted feedback's attachments = %v, want removed", err)
	}
	second, _, err := service.AddThread(Target{Repository: "r", Branch: "two", Project: "/p"}, stageVisual(t, service, "r", 2, 2))
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Delete("r", second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(service.store.attachmentDirectory("r", second.ID)); !os.IsNotExist(err) {
		t.Errorf("deleted feedback's attachments = %v, want removed", err)
	}
}

func TestStagingBoundsAndSweep(t *testing.T) {
	service, _ := testService(t)
	var first string
	for i := range MaxStaged + 1 {
		upload, err := service.Stage("r", testPNG(t, 1, 1))
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = upload.ID
		}
	}
	staged, err := service.store.staged("r")
	if err != nil || len(staged) != MaxStaged {
		t.Fatalf("staged = %d, %v; want %d", len(staged), err, MaxStaged)
	}
	if _, _, found := service.Staged("r", first); found {
		t.Error("the oldest upload survived past the staging bound")
	}

	// A crash leftover beside a feedback and an expired upload go with the
	// next upload.
	created, _, err := service.AddThread(Target{Repository: "r", Branch: "b", Project: "/p"}, NewThread{Anchor: lineAnchor("a", 1, 1), Author: AuthorUser, Body: "x"})
	if err != nil {
		t.Fatal(err)
	}
	orphan := service.store.AttachmentFile("r", created.ID, "at-aaaaaaaaaa")
	gone := service.store.AttachmentFile("r", "fb-zzzzzz", "at-bbbbbbbbbb")
	for _, name := range []string{orphan, gone} {
		if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, testPNG(t, 1, 1), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := staged[0]
	if err := os.Chtimes(old.file, time.Now().Add(-2*time.Hour), service.now().Add(-StagedLifetime)); err != nil {
		t.Fatal(err)
	}
	if _, live, found := service.Staged("r", strings.TrimSuffix(filepath.Base(old.file), ".png")); !found || live {
		t.Errorf("expired upload = live %v, found %v; want found, not live", live, found)
	}
	if _, err := service.Stage("r", testPNG(t, 1, 1)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{orphan, gone, old.file, filepath.Dir(gone)} {
		if _, err := os.Lstat(name); !os.IsNotExist(err) {
			t.Errorf("%s after a sweep = %v, want removed", name, err)
		}
	}
}

func TestAttachmentBudgetDropsClosedScreenshotsFirst(t *testing.T) {
	service, _ := testService(t)
	target := Target{Repository: "r", Branch: "b", Project: "/p"}
	created, first, err := service.AddThread(target, stageVisual(t, service, "r", 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	target.ID = created.ID
	for range MaxAttachmentsPerFeedback - 1 {
		if _, _, err := service.AddThread(target, stageVisual(t, service, "r", 1, 1)); err != nil {
			t.Fatal(err)
		}
	}
	_, _, err = service.AddThread(target, stageVisual(t, service, "r", 1, 1))
	if !errors.Is(err, ErrFull) || !strings.Contains(err.Error(), "feedback "+created.ID+" holds 64 screenshots, the most it may; resolve or delete threads with screenshots, then try again") {
		t.Fatalf("screenshot 65 with every thread open = %v", err)
	}
	// Thread 2 closes before thread 1, so it is the least recently updated.
	for _, number := range []int{2, 1} {
		if _, _, err := service.AddMessage("r", created.ID, "/p", NewMessage{Thread: number, Author: AuthorAgent, Body: "done", Status: StatusResolved}); err != nil {
			t.Fatal(err)
		}
	}
	stored, _, err := service.AddThread(target, stageVisual(t, service, "r", 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	if !service.HasAttachment("r", created.ID, first.Visual.Attachment.ID) || service.HasAttachment("r", created.ID, stored.Threads[1].Visual.Attachment.ID) {
		t.Error("the budget dropped another screenshot than the least recently updated closed thread's")
	}
	if len(stored.Threads) != MaxAttachmentsPerFeedback+1 {
		t.Errorf("threads = %d; a dropped screenshot keeps its thread", len(stored.Threads))
	}
}

func TestAttachmentByteBudgets(t *testing.T) {
	service, _ := testService(t)
	grow := func(id string, thread Thread, size int64) {
		t.Helper()
		if err := os.Truncate(service.store.AttachmentFile("r", id, thread.Visual.Attachment.ID), size); err != nil {
			t.Fatal(err)
		}
	}
	mine, closed, err := service.AddThread(Target{Repository: "r", Branch: "mine", Project: "/p"}, stageVisual(t, service, "r", 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	_, open, err := service.AddThread(Target{Repository: "r", ID: mine.ID, Project: "/p"}, stageVisual(t, service, "r", 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AddMessage("r", mine.ID, "/p", NewMessage{Thread: closed.Number, Author: AuthorAgent, Body: "done", Status: StatusWontfix}); err != nil {
		t.Fatal(err)
	}
	// Sparse files stand in for large screenshots.
	grow(mine.ID, closed, 200<<20)
	grow(mine.ID, open, 56<<20)
	if _, _, err := service.AddThread(Target{Repository: "r", ID: mine.ID, Project: "/p"}, stageVisual(t, service, "r", 1, 1)); err != nil {
		t.Fatal(err)
	}
	if service.HasAttachment("r", mine.ID, closed.Visual.Attachment.ID) || !service.HasAttachment("r", mine.ID, open.Visual.Attachment.ID) {
		t.Error("past 256 MiB per feedback, the won't-fix screenshot should go and the open one stay")
	}

	other, big, err := service.AddThread(Target{Repository: "r", Branch: "other", Project: "/p"}, stageVisual(t, service, "r", 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	grow(other.ID, big, MaxAttachmentBytesPerRepository-(56<<20))
	_, _, err = service.AddThread(Target{Repository: "r", ID: mine.ID, Project: "/p"}, stageVisual(t, service, "r", 1, 1))
	if !errors.Is(err, ErrFull) || !strings.Contains(err.Error(), "this repository's screenshots would pass 1 GiB; resolve or delete threads with screenshots, or delete old feedback, then try again") {
		t.Fatalf("past 1 GiB with only open screenshots = %v", err)
	}
	if !service.HasAttachment("r", other.ID, big.Visual.Attachment.ID) {
		t.Error("an open thread's screenshot was dropped")
	}
	if _, _, err := service.AddMessage("r", other.ID, "/p", NewMessage{Thread: big.Number, Author: AuthorUser, Body: "ok", Status: StatusResolved}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AddThread(Target{Repository: "r", ID: mine.ID, Project: "/p"}, stageVisual(t, service, "r", 1, 1)); err != nil {
		t.Fatalf("past 1 GiB with another feedback's resolved screenshot = %v", err)
	}
	if service.HasAttachment("r", other.ID, big.Visual.Attachment.ID) {
		t.Error("another feedback's resolved screenshot should go past the repository budget")
	}
}
