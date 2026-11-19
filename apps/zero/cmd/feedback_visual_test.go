package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/internal/app"
	"github.com/flexdinesh/zero/internal/document"
	"github.com/flexdinesh/zero/internal/feedback"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/pkg/contract"
)

func readVisualFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "feedback", "visual", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestFeedbackMarkdownMatchesTheVisualFixture(t *testing.T) {
	var stored contract.Feedback
	if err := json.Unmarshal(readVisualFixture(t, "feedback.json"), &stored); err != nil {
		t.Fatal(err)
	}
	want := readVisualFixture(t, "show.md")
	if got := feedbackMarkdown("", stored, stored.Threads, true); got != string(want) {
		t.Errorf("feedbackMarkdown(visual feedback.json, --all) =\n%s\nwant testdata/feedback/visual/show.md =\n%s", got, want)
	}
}

func TestFeedbackCLIFixtureFillsTheAttachmentPath(t *testing.T) {
	var stored contract.Feedback
	if err := json.Unmarshal(readVisualFixture(t, "feedback.json"), &stored); err != nil {
		t.Fatal(err)
	}
	data := readVisualFixture(t, "feedback-cli.json")
	var cli contract.FeedbackThread
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cli); err != nil {
		t.Fatal(err)
	}
	store := feedback.NewStore("/home/user/.local/state/zero/feedback")
	want := stored.Threads[1]
	visual := *want.Visual
	visual.Attachment.Path = store.AttachmentFile("/home/user/markdown/.git", stored.ID, visual.Attachment.ID)
	want.Visual = &visual
	if !reflect.DeepEqual(cli, want) {
		t.Errorf("feedback-cli.json = %+v\nwant feedback.json's thread 5 with its store path %s", cli.Visual, visual.Attachment.Path)
	}
}

// visualThread starts a visual thread as the page does, through the
// application layer over opts's store: a 612×288 screenshot with the
// rectangle 96,96 420×96.
func visualThread(t *testing.T, opts feedbackOptions, root string) (contract.FeedbackThread, []byte) {
	t.Helper()
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	application, err := app.New(app.Config{Roots: roots, Depth: 5, Types: document.Builtins(), FeedbackDirectory: opts.feedbackDir, WalkthroughDirectory: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	picture := image.NewNRGBA(image.Rect(0, 0, 612, 288))
	for x := range 612 {
		for y := range 288 {
			picture.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	upload, err := application.Feedback.UploadAttachment(root, encoded.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	thread, err := application.Feedback.CreateThread(context.Background(), contract.FeedbackThreadDraft{Project: root, Body: "Save overlaps the card.", Visual: &contract.FeedbackVisualDraft{
		Attachment: upload.ID, Rect: contract.FeedbackRect{X: 96, Y: 96, Width: 420, Height: 96},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return thread, encoded.Bytes()
}

func TestFeedbackAttachmentCommand(t *testing.T) {
	root, _ := publishRepo(t)
	opts := testFeedbackOptions(t, root)
	thread, data := visualThread(t, opts, root)
	attachment := thread.Visual.Attachment.ID

	asJSON := opts
	asJSON.json, asJSON.all = true, true
	stdout, _, err := runFeedback(t, showFeedback, asJSON, "")
	var shown contract.Feedback
	if err != nil || json.Unmarshal([]byte(stdout), &shown) != nil || len(shown.Threads) != 1 || shown.Threads[0].Visual == nil {
		t.Fatalf("show --json = %s, %v", stdout, err)
	}
	file := feedback.NewStore(opts.feedbackDir).AttachmentFile(app.FeedbackRepository(root), shown.ID, attachment)
	if got := shown.Threads[0].Visual.Attachment.Path; got != file {
		t.Errorf("show --json attachment path = %q, want %q", got, file)
	}
	stdout, _, err = runFeedback(t, showFeedback, opts, "")
	if err != nil || !strings.Contains(stdout, "Screenshot: zero feedback attachment "+shown.ID+" "+attachment+" [--crop -o region.png]\n") || strings.Contains(stdout, file) {
		t.Errorf("show = %s, %v", stdout, err)
	}

	// From anywhere, the feedback ID alone finds the store's file.
	elsewhere := opts
	elsewhere.getwd = func() (string, error) { return t.TempDir(), nil }
	if stdout, _, err := runFeedback(t, attachmentFeedback, elsewhere, "", shown.ID, attachment); err != nil || stdout != file+"\n" {
		t.Errorf("attachment = %q, %v; want %s", stdout, err, file)
	}
	elsewhere.json = true
	stdout, _, err = runFeedback(t, attachmentFeedback, elsewhere, "", shown.ID, attachment)
	var described contract.FeedbackAttachment
	if err != nil || json.Unmarshal([]byte(stdout), &described) != nil || described.Path != file || described.Width != 612 {
		t.Errorf("attachment --json = %s, %v", stdout, err)
	}

	dir := t.TempDir()
	t.Chdir(dir)
	copied := opts
	copied.output = "shot.png"
	if stdout, _, err := runFeedback(t, attachmentFeedback, copied, "", shown.ID, attachment); err != nil || stdout != "wrote shot.png (612×288)\n" {
		t.Errorf("attachment -o = %q, %v", stdout, err)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "shot.png")); err != nil || !bytes.Equal(got, data) {
		t.Errorf("copied screenshot = %d bytes, %v; want the upload", len(got), err)
	}
	piped := opts
	piped.output = "-"
	if stdout, _, err := runFeedback(t, attachmentFeedback, piped, "", shown.ID, attachment); err != nil || stdout != string(data) {
		t.Errorf("attachment -o - = %d bytes, %v", len(stdout), err)
	}

	cropped := opts
	cropped.output, cropped.crop, cropped.cropSet = "region.png", defaultCropMargin, true
	if stdout, _, err := runFeedback(t, attachmentFeedback, cropped, "", shown.ID, attachment); err != nil || stdout != "wrote region.png (468×144: region 96,96 420×96 plus 24 px margin)\n" {
		t.Errorf("attachment --crop = %q, %v", stdout, err)
	}
	region, err := os.ReadFile(filepath.Join(dir, "region.png"))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := png.Decode(bytes.NewReader(region))
	if err != nil || decoded.Bounds().Dx() != 468 || decoded.Bounds().Dy() != 144 {
		t.Fatalf("crop = %v, %v", decoded.Bounds(), err)
	}
	// The crop starts at the image's 72,72: the rectangle less the margin.
	if r, g, _, _ := decoded.At(0, 0).RGBA(); r>>8 != 72 || g>>8 != 72 {
		t.Errorf("crop's first pixel = %d,%d; want the image's 72,72", r>>8, g>>8)
	}

	for name, test := range map[string]struct {
		opts feedbackOptions
		args []string
		want string
	}{
		"crop without -o":    {feedbackOptions{feedbackDir: opts.feedbackDir, cropSet: true, crop: 24}, []string{shown.ID, attachment}, "--crop needs -o <file|->"},
		"bad attachment":     {opts, []string{shown.ID, "shot"}, `attachment must be at- and ten lowercase letters or digits, such as at-7hq2mx4kpa, not "shot"`},
		"unknown feedback":   {opts, []string{"fb-zzzzzz", attachment}, "no feedback fb-zzzzzz in " + opts.feedbackDir + "\n  Feedback is stored on the machine that serves the project. Served remotely: run this there. In a sandbox, run it inside:\n    docker exec <container> /tmp/.zero/zero feedback attachment fb-zzzzzz " + attachment + " -o - > shot.png"},
		"not its screenshot": {opts, []string{shown.ID, "at-zzzzzzzzzz"}, "feedback " + shown.ID + " has no screenshot at-zzzzzzzzzz"},
	} {
		if _, _, err := runFeedback(t, attachmentFeedback, test.opts, "", test.args...); err == nil || err.Error() != test.want {
			t.Errorf("%s = %v, want %q", name, err, test.want)
		}
	}

	if err := os.WriteFile(file, append(append([]byte{}, data...), 0), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runFeedback(t, attachmentFeedback, opts, "", shown.ID, attachment); err == nil || !strings.HasPrefix(err.Error(), file+" doesn't match its thread: its sha256 is ") || !strings.HasSuffix(err.Error(), ", but the thread recorded "+thread.Visual.Attachment.SHA256) {
		t.Errorf("attachment with changed bytes = %v", err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runFeedback(t, attachmentFeedback, opts, "", shown.ID, attachment); err == nil || err.Error() != "screenshot "+attachment+" of "+shown.ID+" is not stored: zero dropped it for the storage budget, or its file is missing. The thread's region and page facts remain: zero feedback show "+shown.ID+" --all" {
		t.Errorf("attachment of a removed screenshot = %v", err)
	}
}
