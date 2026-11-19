package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/flexdinesh/zero/internal/feedback"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/pkg/client"
	"github.com/flexdinesh/zero/pkg/contract"
)

// A screenshot outlives the browser and the server that took it (decision
// 0176): once the server has stopped, a new one serves the same bytes, and
// the store alone, as the CLI reads it, finds them.
func TestFeedbackScreenshotOutlivesTheServerThatTookIt(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	rt, root := newRuntime(t)

	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewGray(image.Rect(0, 0, 64, 32))); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	address, done := serveLocal(t, rt, ctx)
	browser := client.NewTCP(address)
	upload, err := browser.UploadFeedbackAttachment(ctx, root, encoded.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	thread, err := browser.CreateFeedbackThread(ctx, contract.FeedbackThreadDraft{Project: root, Body: "The badge clips.", Visual: &contract.FeedbackVisualDraft{Attachment: upload.ID, Rect: contract.FeedbackRect{X: 8, Y: 4, Width: 16, Height: 8}}})
	if err != nil {
		t.Fatal(err)
	}
	read, err := browser.Feedback(ctx, contract.FeedbackRequest{Project: root})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := wait(t, done, 2*time.Second); err != nil {
		t.Fatalf("Serve() = %v, want nil", err)
	}
	if thread.Visual == nil || thread.Visual.Attachment.SHA256 != upload.SHA256 {
		t.Fatalf("visual thread = %+v", thread)
	}

	// A new server over the same state serves it.
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	again, err := New(Config{Roots: roots, Depth: 5, ScanDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	address, done = serveLocal(t, again, ctx)
	reopened := client.NewTCP(address)
	shot, err := reopened.FeedbackAttachment(ctx, contract.FeedbackAttachmentRequest{Project: root, ID: read.ID, Attachment: upload.ID})
	if err != nil {
		t.Fatal(err)
	}
	if sum := sha256.Sum256(shot.Content); shot.MediaType != "image/png" || hex.EncodeToString(sum[:]) != upload.SHA256 {
		t.Errorf("screenshot from a new server = %s, sha256 %x; want image/png, %s", shot.MediaType, sum, upload.SHA256)
	}
	listed, err := reopened.Feedback(ctx, contract.FeedbackRequest{Project: root})
	if err != nil || len(listed.Threads) != 1 || listed.Threads[0].Visual == nil || !listed.Threads[0].Visual.Available {
		t.Errorf("feedback from a new server = %+v, %v", listed, err)
	}
	cancel()
	if err := wait(t, done, 2*time.Second); err != nil {
		t.Fatalf("Serve() = %v, want nil", err)
	}

	// With no server at all, the feedback ID finds the file, as
	// `zero feedback attachment` does.
	store := feedback.NewService(feedback.NewStore(filepath.Join(state, "zero", "feedback")))
	located, err := store.Locate(read.ID)
	if err != nil {
		t.Fatal(err)
	}
	name, metadata, err := store.AttachmentFile(located, upload.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != upload.SHA256 || metadata.SHA256 != upload.SHA256 {
		t.Errorf("screenshot from the store = sha256 %x, recorded %s; want %s", sum, metadata.SHA256, upload.SHA256)
	}
}

// serveLocal serves rt's loopback handler on a fresh 127.0.0.1 port.
func serveLocal(t *testing.T, rt *Runtime, ctx context.Context) (string, <-chan error) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- rt.Serve(ctx, listener, rt.LocalHandler()) }()
	return "http://" + listener.Addr().String(), done
}
