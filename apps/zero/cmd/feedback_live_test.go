package cmd

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/internal/app"
	"github.com/flexdinesh/zero/internal/feedback"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/internal/watch"
	"github.com/flexdinesh/zero/internal/web"
	"github.com/flexdinesh/zero/pkg/contract"
)

// gradientPNG is a width×height PNG whose pixel x,y is red x, green y.
func gradientPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	picture := image.NewNRGBA(image.Rect(0, 0, width, height))
	for x := range width {
		for y := range height {
			picture.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

// visualDraft is a draft fixture for project with attachment and no ID.
func visualDraft(t *testing.T, name, project, attachment string) contract.FeedbackThreadDraft {
	t.Helper()
	var draft contract.FeedbackThreadDraft
	decoder := json.NewDecoder(bytes.NewReader(readVisualFixture(t, name)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&draft); err != nil || draft.Visual == nil {
		t.Fatalf("%s = %+v, %v", name, draft, err)
	}
	draft.Project, draft.ID, draft.Visual.Attachment = project, "", attachment
	return draft
}

// TestFeedbackShowReadsLiveStorage is the CLI's end-to-end check (decision
// 0178): the web app, over the daemon's local transport, stores a code
// thread, a page capture, and a pasted screenshot in one feedback; the CLI
// then reads and answers the same store with no server, and the web app
// sees its reply.
func TestFeedbackShowReadsLiveStorage(t *testing.T) {
	root, _ := publishRepo(t)
	opts := testFeedbackOptions(t, root)
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	server, err := web.New(web.Config{Roots: roots, Depth: 5, LiveUpdates: watch.NewHub(watch.DefaultOptions()), FeedbackDirectory: opts.feedbackDir, WalkthroughDirectory: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	handler := web.Local(server)
	send := func(method, target, contentType string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, bytes.NewReader(body))
		req.Host = "127.0.0.1:7971"
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	upload := func(data []byte) contract.FeedbackUpload {
		t.Helper()
		response := send(http.MethodPost, "/api/feedback-attachments?project="+url.QueryEscape(root), "image/png", data)
		var answered contract.FeedbackUpload
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &answered) != nil {
			t.Fatalf("POST /api/feedback-attachments = %d %s", response.Code, response.Body.String())
		}
		return answered
	}
	create := func(draft contract.FeedbackThreadDraft) contract.FeedbackThread {
		t.Helper()
		encoded, err := json.Marshal(draft)
		if err != nil {
			t.Fatal(err)
		}
		response := send(http.MethodPost, "/api/feedback-threads", "application/json", encoded)
		var thread contract.FeedbackThread
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &thread) != nil {
			t.Fatalf("POST /api/feedback-threads = %d %s", response.Code, response.Body.String())
		}
		return thread
	}

	shot, pasted := gradientPNG(t, 612, 288), gradientPNG(t, 1280, 720)
	create(contract.FeedbackThreadDraft{Project: root, Path: "doc.md", Side: contract.FeedbackSideNew, Lines: []int{2, 2}, Body: "Say what line two is for."})
	page := create(visualDraft(t, "draft-page.json", root, upload(shot).ID))
	paste := create(visualDraft(t, "draft-minimal.json", root, upload(pasted).ID))
	pageShot, pasteShot := page.Visual.Attachment.ID, paste.Visual.Attachment.ID

	// Markdown: the reviewer's words and every target fact, mixed.
	stdout, _, err := runFeedback(t, showFeedback, opts, "")
	if err != nil {
		t.Fatal(err)
	}
	id := strings.TrimPrefix(strings.SplitN(stdout, "\n", 2)[0], "# Feedback ")
	for _, want := range []string{
		" · 3 threads awaiting you\n",
		"## Thread 1 · open · doc.md:2\n```markdown\nline two\n```\n**user** · ",
		"Say what line two is for.\n",
		"## Thread 2 · open · screenshot · `http://localhost:5173/settings?tab=billing&session=REDACTED#plan`\n" +
			"Page: `Settings · Acme` · viewport 1440×900 CSS px at 2× · scrolled 0,1320\n" +
			"Localhost: this machine, where the project is; the URL opens as written\n" +
			"Region: image 96,96 420×96 of 612×288 · CSS 605,320 210×48 · document 605,1640\n" +
			"Element (page's hint, unverified): button `Save changes` · `main form > button[data-testid=\"save\"]`\n",
		"Screenshot: zero feedback attachment " + id + " " + pageShot + " [--crop -o region.png]\n\n**user** · ",
		"Save overlaps the card edge at 1440 px. Keep it inside the card padding.\n",
		"## Thread 3 · open · screenshot\nPage: none (pasted image)\nRegion: image 300,200 240×60 of 1280×720\n",
		"Screenshot: zero feedback attachment " + id + " " + pasteShot + " [--crop -o region.png]\n",
		"This empty state has no call to action.\n",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("show is missing %q:\n%s", want, stdout)
		}
	}
	if strings.Contains(stdout, opts.feedbackDir) {
		t.Errorf("show Markdown names a host path:\n%s", stdout)
	}

	// JSON: the code thread as before; each screenshot's real file.
	asJSON := opts
	asJSON.json = true
	stdout, _, err = runFeedback(t, showFeedback, asJSON, "")
	var shown contract.Feedback
	if err != nil || json.Unmarshal([]byte(stdout), &shown) != nil || len(shown.Threads) != 3 {
		t.Fatalf("show --json = %s, %v", stdout, err)
	}
	if code := shown.Threads[0]; code.Anchor == nil || code.Location == nil || code.Visual != nil {
		t.Errorf("code thread = %+v", code)
	}
	store := feedback.NewStore(opts.feedbackDir)
	for i, data := range map[int][]byte{1: shot, 2: pasted} {
		visual := shown.Threads[i].Visual
		if visual == nil || shown.Threads[i].Anchor != nil {
			t.Fatalf("thread %d = %+v", i+1, shown.Threads[i])
		}
		want := store.AttachmentFile(app.FeedbackRepository(root), id, visual.Attachment.ID)
		stored, err := os.ReadFile(visual.Attachment.Path)
		sum := sha256.Sum256(stored)
		if visual.Attachment.Path != want || err != nil || !bytes.Equal(stored, data) || hex.EncodeToString(sum[:]) != visual.Attachment.SHA256 || !visual.Available {
			t.Errorf("thread %d attachment = %+v, %v; want the upload at %s", i+1, visual.Attachment, err, want)
		}
	}

	// The printed command reads the screenshot from anywhere.
	dir := t.TempDir()
	t.Chdir(dir)
	cropped := opts
	cropped.getwd = func() (string, error) { return dir, nil }
	cropped.output, cropped.crop, cropped.cropSet = "region.png", defaultCropMargin, true
	if stdout, _, err := runFeedback(t, attachmentFeedback, cropped, "", id, pageShot); err != nil || stdout != "wrote region.png (468×144: region 96,96 420×96 plus 24 px margin)\n" {
		t.Errorf("attachment --crop = %q, %v", stdout, err)
	}

	// The reply reaches the web app; the thread no longer awaits the agent.
	reply := opts
	reply.message, reply.hasMessage, reply.resolve = "Save now sits inside the card padding.", true, true
	if stdout, _, err := runFeedback(t, replyFeedback, reply, "", id, "2"); err != nil || stdout != "replied to thread 2 (resolved)\n" {
		t.Fatalf("reply = %q, %v", stdout, err)
	}
	response := send(http.MethodGet, "/api/feedback?"+url.Values{"project": {root}, "id": {id}}.Encode(), "", nil)
	var served contract.Feedback
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &served) != nil || len(served.Threads) != 3 {
		t.Fatalf("GET /api/feedback = %d %s", response.Code, response.Body.String())
	}
	if thread := served.Threads[1]; thread.Status != contract.FeedbackStatusResolved || thread.Awaiting != contract.FeedbackAwaitingUser || thread.Messages[len(thread.Messages)-1].Author != contract.FeedbackAuthorAgent {
		t.Errorf("web app's thread 2 after the reply = %+v", thread)
	}
	if stdout, _, err := runFeedback(t, showFeedback, opts, ""); err != nil || !strings.Contains(stdout, " · 2 threads awaiting you\n") || strings.Contains(stdout, "## Thread 2 ") {
		t.Errorf("show after the reply = %s, %v", stdout, err)
	}

	// Evidence gone: the thread, its region, and its words stay.
	if err := os.Remove(shown.Threads[2].Visual.Attachment.Path); err != nil {
		t.Fatal(err)
	}
	all := opts
	all.all = true
	stdout, _, err = runFeedback(t, showFeedback, all, "")
	if err != nil || !strings.Contains(stdout, "## Thread 3 · open · screenshot (not stored)\nPage: none (pasted image)\nRegion: image 300,200 240×60 of 1280×720\n") ||
		!strings.Contains(stdout, "Screenshot: not stored (dropped for the storage budget, or its file is missing); the region and page facts above still apply\n\n**user** · ") {
		t.Errorf("show --all without the screenshot = %s, %v", stdout, err)
	}
	all.json = true
	stdout, _, err = runFeedback(t, showFeedback, all, "")
	var gone contract.Feedback
	if err != nil || json.Unmarshal([]byte(stdout), &gone) != nil || len(gone.Threads) != 3 || gone.Threads[2].Visual == nil || gone.Threads[2].Visual.Available || gone.Threads[2].Visual.Attachment.Path != "" {
		t.Errorf("show --all --json without the screenshot = %s, %v", stdout, err)
	}
	want := "screenshot " + pasteShot + " of " + id + " is not stored: zero dropped it for the storage budget, or its file is missing. The thread's region and page facts remain: zero feedback show " + id + " --all"
	if _, _, err := runFeedback(t, attachmentFeedback, opts, "", id, pasteShot); err == nil || err.Error() != want {
		t.Errorf("attachment without the screenshot = %v, want %q", err, want)
	}
}

// TestFeedbackElsewhereNamesWhereToRun: feedback this machine doesn't hold
// is on the machine that serves the project, so a miss says where to run
// the command.
func TestFeedbackElsewhereNamesWhereToRun(t *testing.T) {
	root, _ := publishRepo(t)
	opts := testFeedbackOptions(t, root)
	userThread(t, opts, root, []int{1, 1}, "Here.")
	where := "\n  Feedback is stored on the machine that serves the project. Served remotely: run this there. In a sandbox, run it inside:\n    docker exec <container> /tmp/.zero/zero feedback "

	if _, _, err := runFeedback(t, attachmentFeedback, opts, "", "fb-zzzzzz", "at-zzzzzzzzzz"); err == nil || err.Error() != "no feedback fb-zzzzzz in "+opts.feedbackDir+where+"attachment fb-zzzzzz at-zzzzzzzzzz -o - > shot.png" {
		t.Errorf("attachment of unknown feedback = %v", err)
	}
	if _, _, err := runFeedback(t, showFeedback, opts, "", "fb-zzzzzz"); err == nil || err.Error() != "no feedback fb-zzzzzz for this repository"+where+"show fb-zzzzzz" {
		t.Errorf("show of unknown feedback = %v", err)
	}
	reply := opts
	reply.message, reply.hasMessage = "Done.", true
	if _, _, err := runFeedback(t, replyFeedback, reply, "", "fb-zzzzzz", "1"); err == nil || err.Error() != "no feedback fb-zzzzzz for this repository"+where+`reply fb-zzzzzz 1 -m "<what you did>"` {
		t.Errorf("reply to unknown feedback = %v", err)
	}

	// Feedback this machine holds, for another repository, gets no hint.
	other, _ := publishRepo(t)
	elsewhere := opts
	elsewhere.project = other
	shown, _, err := runFeedback(t, listFeedback, opts, "")
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Fields(shown)[0]
	if _, _, err := runFeedback(t, showFeedback, elsewhere, "", id); err == nil || strings.Contains(err.Error(), "docker exec") {
		t.Errorf("show of another repository's feedback = %v", err)
	}
}

func TestCodeSpan(t *testing.T) {
	for text, want := range map[string]string{
		"Settings · Acme":        "`Settings · Acme`",
		"Docs `beta` · **Acme**": "``Docs `beta` · **Acme**``",
		"`edge`":                 "`` `edge` ``",
		"a ``b`` c":              "```a ``b`` c```",
	} {
		if got := codeSpan(text); got != want {
			t.Errorf("codeSpan(%q) = %q, want %q", text, got, want)
		}
	}
}
