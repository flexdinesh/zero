package app

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/internal/document"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/pkg/contract"
)

func visualFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "testdata", "feedback", "visual", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// encodePNG encodes a blank width×height PNG.
func encodePNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewGray(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// visualDraft decodes a draft fixture strictly for r's project, taking a
// fresh upload of width×height in place of its attachment and no ID.
func (r *feedbackRepo) visualDraft(name string, width, height int) contract.FeedbackThreadDraft {
	r.t.Helper()
	draft, err := DecodeFeedbackThreadDraft(bytes.NewReader(visualFixture(r.t, name)))
	if err != nil {
		r.t.Fatalf("decode %s: %v", name, err)
	}
	upload, err := r.feedback.UploadAttachment(r.root, encodePNG(r.t, width, height))
	if err != nil {
		r.t.Fatal(err)
	}
	draft.Project, draft.ID, draft.Visual.Attachment = r.root, "", upload.ID
	return draft
}

func TestFeedbackVisualThreadsFromTheDraftFixtures(t *testing.T) {
	r := newFeedbackRepo(t)
	ref, err := r.repo.Head()
	if err != nil {
		t.Fatal(err)
	}
	head := ref.Hash().String()
	var stored contract.Feedback
	if err := json.Unmarshal(visualFixture(t, "feedback.json"), &stored); err != nil {
		t.Fatal(err)
	}
	want := stored.Threads[1].Visual

	page := r.visualDraft("draft-page.json", 612, 288)
	thread, err := r.feedback.CreateThread(context.Background(), page)
	if err != nil {
		t.Fatal(err)
	}
	if thread.Anchor != nil || thread.Location != nil || thread.Visual == nil || thread.Visual.Head != head || !thread.Visual.Available || thread.Visual.Attachment.ID != page.Visual.Attachment {
		t.Fatalf("visual thread = %+v", thread)
	}
	got := *thread.Visual
	got.Attachment, got.Head = want.Attachment, want.Head
	if !reflect.DeepEqual(&got, want) {
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		t.Errorf("visual over a remote transport =\n%s\nwant feedback.json's thread 5\n%s", gotJSON, wantJSON)
	}

	local := r.visualDraft("draft-page.json", 612, 288)
	thread, err = r.feedback.CreateThread(WithTransport(context.Background(), TransportLocal), local)
	if err != nil || thread.Visual.Page.Localhost != contract.FeedbackLocalhostProject {
		t.Errorf("localhost over a local transport = %+v, %v", thread.Visual, err)
	}
	elsewhere := r.visualDraft("draft-page.json", 612, 288)
	elsewhere.Visual.Page.URL = "https://staging.example.com/settings"
	thread, err = r.feedback.CreateThread(WithTransport(context.Background(), TransportLocal), elsewhere)
	if err != nil || thread.Visual.Page.Localhost != "" {
		t.Errorf("localhost for a host that is not loopback = %+v, %v", thread.Visual, err)
	}

	minimal := r.visualDraft("draft-minimal.json", 1280, 720)
	thread, err = r.feedback.CreateThread(context.Background(), minimal)
	if err != nil || thread.Visual.Page != nil || thread.Visual.Element != nil || thread.Visual.Rect != (contract.FeedbackRect{X: 300, Y: 200, Width: 240, Height: 60}) || thread.Visual.Attachment.Width != 1280 {
		t.Fatalf("pasted visual thread = %+v, %v", thread.Visual, err)
	}

	// Reads carry visual threads beside code threads, and a removed
	// screenshot leaves its thread unavailable.
	r.thread(contract.FeedbackThreadDraft{Path: "main.go", Lines: []int{4, 4}, Body: "Code."})
	request := contract.FeedbackAttachmentRequest{Project: r.root, ID: r.get(contract.FeedbackRequest{}).ID, Attachment: minimal.Visual.Attachment}
	name, err := r.feedback.AttachmentPath(request)
	if err != nil || !strings.HasSuffix(name, filepath.Join(request.ID, request.Attachment+".png")) {
		t.Fatalf("AttachmentPath = %s, %v", name, err)
	}
	read, err := r.feedback.ReadAttachment(request)
	if err != nil || read.MediaType != "image/png" {
		t.Fatalf("ReadAttachment = %v", err)
	}
	if decoded, err := png.DecodeConfig(bytes.NewReader(read.Content)); err != nil || decoded.Width != 1280 {
		t.Errorf("ReadAttachment content = %+v, %v", decoded, err)
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	all := r.get(contract.FeedbackRequest{})
	if len(all.Threads) != 5 || all.Threads[3].Visual == nil || all.Threads[3].Visual.Available || all.Threads[4].Anchor == nil || all.Threads[4].Location == nil || !all.Threads[0].Visual.Available {
		t.Errorf("Get = %+v", all.Threads)
	}
	if _, _, err := r.feedback.OpenAttachment(request); codeOf(err) != contract.CodeFeedbackUnavailable || AsError(err).Kind != contract.KindNotFound {
		t.Errorf("OpenAttachment of a removed screenshot = %v", err)
	}

	// Replies keep the visual target; deleting the thread deletes its file.
	replied, err := r.feedback.PostMessage(context.Background(), contract.FeedbackMessageDraft{Project: r.root, ID: request.ID, Thread: 1, Body: "Fixed.", Status: contract.FeedbackStatusResolved, Author: contract.FeedbackAuthorAgent})
	if err != nil || replied.Visual == nil || replied.Location != nil {
		t.Errorf("reply to a visual thread = %+v, %v", replied, err)
	}
	first := contract.FeedbackAttachmentRequest{Project: r.root, ID: request.ID, Attachment: page.Visual.Attachment}
	firstName, err := r.feedback.AttachmentPath(first)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.feedback.DeleteThread(contract.FeedbackDeleteRequest{Project: r.root, ID: request.ID, Thread: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(firstName); !os.IsNotExist(err) {
		t.Errorf("screenshot of a deleted thread = %v", err)
	}
}

func TestFeedbackVisualRejections(t *testing.T) {
	r := newFeedbackRepo(t)
	ctx := context.Background()
	draft := r.visualDraft("draft-page.json", 612, 288)
	draft.Path = "main.go"
	draft.Visual.Rect.Height = 240
	draft.Visual.Element.Box.Height = 240
	draft.Visual.Page.Clip.Width = 600
	_, err := r.feedback.CreateThread(ctx, draft)
	want := []string{
		"path: doesn't apply with visual, which excludes path, side, lines, and compare",
		"visual.rect: 96,96 420×240 ends at y 336, past the image's height 288",
		"visual.page.clip: is 600×288, but the image is 612×288",
		"visual.element.box: 96,96 420×240 ends at y 336, past the image's height 288",
	}
	if got := problemLines(t, err); !reflect.DeepEqual(got, want) {
		t.Errorf("problems = %q, want %q", got, want)
	}

	unknown := r.visualDraft("draft-minimal.json", 1280, 720)
	unknown.Visual.Attachment = "at-zzzzzzzzzz"
	if got := problemLines(t, func() error { _, err := r.feedback.CreateThread(ctx, unknown); return err }()); !reflect.DeepEqual(got, []string{"visual.attachment: is not an upload of this repository, or it expired after 1 hour"}) {
		t.Errorf("unknown upload = %q", got)
	}

	if _, err := r.feedback.UploadAttachment(r.root, []byte("GIF89a")); codeOf(err) != contract.CodeInvalidFeedback || AsError(err).Kind != contract.KindInvalid || AsError(err).Message != "invalid image: not a PNG" {
		t.Errorf("upload of a GIF = %v", err)
	}
	if _, err := r.feedback.UploadAttachment(r.root, make([]byte, contract.MaxFeedbackAttachmentBytes+1)); codeOf(err) != contract.CodeInvalidFeedback || AsError(err).Kind != contract.KindTooLarge {
		t.Errorf("upload past 8 MiB = %v", err)
	}
	if _, err := r.feedback.UploadAttachment(filepath.Join(r.root, "gone"), encodePNG(t, 1, 1)); AsError(err).Kind != contract.KindNotFound || AsError(err).Message != ProjectUnavailableMessage {
		t.Errorf("upload to an unknown project = %v", err)
	}
	if _, err := r.feedback.AttachmentPath(contract.FeedbackAttachmentRequest{Project: r.root, ID: "fb-zzzzzz", Attachment: "at-zzzzzzzzzz"}); codeOf(err) != contract.CodeFeedbackUnavailable {
		t.Errorf("attachment of an unknown feedback = %v", err)
	}
}

// newFeedbackApp is the feedback of an application serving root, with a
// private store.
func newFeedbackApp(t *testing.T, root string) *Feedback {
	t.Helper()
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	application, err := New(Config{Roots: roots, Depth: 5, Types: document.Builtins(), WalkthroughDirectory: t.TempDir(), FeedbackDirectory: filepath.Join(t.TempDir(), "feedback")})
	if err != nil {
		t.Fatal(err)
	}
	return application.Feedback
}

func TestFeedbackVisualThreadWithoutGitHasNoHead(t *testing.T) {
	folder, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := &feedbackRepo{t: t, root: folder, feedback: newFeedbackApp(t, folder)}
	thread, err := r.feedback.CreateThread(context.Background(), r.visualDraft("draft-minimal.json", 1280, 720))
	if err != nil || thread.Visual.Head != "" {
		t.Errorf("visual thread in a folder = %+v, %v", thread.Visual, err)
	}
	content, size, err := r.feedback.OpenAttachment(contract.FeedbackAttachmentRequest{Project: folder, ID: r.get(contract.FeedbackRequest{}).ID, Attachment: thread.Visual.Attachment.ID})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = content.Close() }()
	if data, _ := io.ReadAll(content); int64(len(data)) != size || size != int64(thread.Visual.Attachment.Bytes) {
		t.Errorf("OpenAttachment = %d bytes of %d; want %d", len(data), size, thread.Visual.Attachment.Bytes)
	}
}
