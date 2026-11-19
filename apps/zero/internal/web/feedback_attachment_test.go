package web

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flexdinesh/zero/internal/watch"
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

func blankPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewGray(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// uploadRequest posts a screenshot body through handler.
func uploadRequest(t *testing.T, handler http.Handler, project string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/feedback-attachments?project="+url.QueryEscape(project), bytes.NewReader(body))
	req.Host = "127.0.0.1:7971"
	req.Header.Set("Content-Type", "image/png")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

// pageDraft is draft-page.json for project with attachment and no ID.
func pageDraft(t *testing.T, project, attachment string) string {
	t.Helper()
	var draft map[string]any
	if err := json.Unmarshal(visualFixture(t, "draft-page.json"), &draft); err != nil {
		t.Fatal(err)
	}
	delete(draft, "id")
	draft["project"] = project
	visual, ok := draft["visual"].(map[string]any)
	if !ok {
		t.Fatal("draft-page.json has no visual")
	}
	visual["attachment"] = attachment
	encoded, err := json.Marshal(draft)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestFeedbackAttachmentEndpoints(t *testing.T) {
	root := t.TempDir()
	app := feedbackApp(t, root)
	project := app.roots.List()[0]

	response := uploadRequest(t, app, project, blankPNG(t, 612, 288), map[string]string{"Origin": "http://127.0.0.1:7971"})
	if response.Code != http.StatusCreated {
		t.Fatalf("POST attachment = %d %s", response.Code, response.Body.String())
	}
	upload := decodeBody[contract.FeedbackUpload](t, response)
	if !strings.HasPrefix(upload.ID, "at-") || upload.MediaType != "image/png" || upload.Width != 612 || upload.Height != 288 || len(upload.SHA256) != 64 {
		t.Errorf("upload = %+v", upload)
	}
	if expires, err := time.Parse(time.RFC3339, upload.ExpiresAt); err != nil || time.Until(expires) < 59*time.Minute || time.Until(expires) > time.Hour {
		t.Errorf("expiresAt = %q, %v; want an hour from now", upload.ExpiresAt, err)
	}

	// Over the daemon's socket the reviewer shares the project's host.
	draft := pageDraft(t, project, upload.ID)
	req := httptest.NewRequest(http.MethodPost, "/api/feedback-threads", strings.NewReader(draft))
	req.Host = "127.0.0.1:7971"
	req.Header.Set("Content-Type", "application/json")
	created := httptest.NewRecorder()
	Local(app).ServeHTTP(created, req)
	if created.Code != http.StatusOK {
		t.Fatalf("POST visual thread = %d %s", created.Code, created.Body.String())
	}
	thread := decodeBody[contract.FeedbackThread](t, created)
	if thread.Visual == nil || thread.Visual.Page.Localhost != contract.FeedbackLocalhostProject || thread.Visual.Page.URL != "http://localhost:5173/settings?tab=billing&session=REDACTED#plan" || thread.Visual.Attachment.Path != "" {
		t.Fatalf("visual thread = %s", created.Body.String())
	}
	second := decodeBody[contract.FeedbackUpload](t, uploadRequest(t, app, project, blankPNG(t, 612, 288), nil))
	remote := decodeBody[contract.FeedbackThread](t, feedbackRequest(t, app, http.MethodPost, "/api/feedback-threads", pageDraft(t, project, second.ID), nil))
	if remote.Visual == nil || remote.Visual.Page.Localhost != contract.FeedbackLocalhostViewer {
		t.Errorf("visual thread over a listener not marked local = %+v", remote.Visual)
	}

	stored := decodeBody[contract.Feedback](t, feedbackRequest(t, app, http.MethodGet, "/api/feedback?project="+url.QueryEscape(project), "", nil))
	target := "/api/feedback-attachment?" + url.Values{"project": {project}, "id": {stored.ID}, "attachment": {upload.ID}}.Encode()
	served := feedbackRequest(t, app, http.MethodGet, target, "", nil)
	sum := sha256.Sum256(served.Body.Bytes())
	if served.Code != http.StatusOK || served.Header().Get("Content-Type") != "image/png" || served.Header().Get("X-Content-Type-Options") != "nosniff" ||
		!strings.HasPrefix(served.Header().Get("Content-Security-Policy"), "sandbox;") || hex.EncodeToString(sum[:]) != upload.SHA256 {
		t.Errorf("GET attachment = %d %v", served.Code, served.Header())
	}
	if response := feedbackRequest(t, app, http.MethodDelete, "/api/feedback-threads?"+url.Values{"project": {project}, "id": {stored.ID}, "thread": {"1"}}.Encode(), "", nil); response.Code != http.StatusNoContent {
		t.Fatalf("DELETE thread = %d", response.Code)
	}
	gone := feedbackRequest(t, app, http.MethodGet, target, "", nil)
	if body := decodeError(t, gone); gone.Code != http.StatusNotFound || body.Code != contract.CodeFeedbackUnavailable || gone.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Errorf("GET a deleted thread's attachment = %d %+v", gone.Code, body)
	}

	for _, test := range []struct {
		name    string
		body    []byte
		headers map[string]string
		status  int
		code    string
		message string
	}{
		{"foreign origin", blankPNG(t, 1, 1), map[string]string{"Origin": "https://evil.example"}, http.StatusForbidden, contract.CodeForeignOrigin, "another site"},
		{"not a PNG type", blankPNG(t, 1, 1), map[string]string{"Content-Type": "image/jpeg"}, http.StatusUnsupportedMediaType, contract.CodeUnsupportedMediaType, "image/png"},
		{"past 8 MiB", make([]byte, contract.MaxFeedbackAttachmentBytes+1), nil, http.StatusRequestEntityTooLarge, contract.CodeInvalidFeedback, "A screenshot is at most 8 MiB."},
		{"bad image", []byte("\x89PNG\r\n\x1a\nbroken"), nil, http.StatusBadRequest, contract.CodeInvalidFeedback, "invalid image: the PNG ends inside a chunk"},
		{"past 16 MP", blankPNG(t, 4097, 4097), nil, http.StatusBadRequest, contract.CodeInvalidFeedback, "its area must be at most 16 MP"},
		{"past 8192 px", blankPNG(t, 8193, 1), nil, http.StatusBadRequest, contract.CodeInvalidFeedback, "each side must be at most 8192 px"},
	} {
		response := uploadRequest(t, app, project, test.body, test.headers)
		body := decodeError(t, response)
		if response.Code != test.status || body.Code != test.code || !strings.Contains(body.Error, test.message) {
			t.Errorf("%s = %d %+v; want %d %q containing %q", test.name, response.Code, body, test.status, test.code, test.message)
		}
	}
}

// TestFeedbackVisualProblemsFixture answers problems.json for its draft: a
// path beside visual, an expired upload of 612×288, and a rectangle, clip,
// and element box that do not fit it.
func TestFeedbackVisualProblemsFixture(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(t.TempDir(), "feedback")
	app, err := New(Config{Roots: testRoots(t, root), Depth: 5, LiveUpdates: watch.NewHub(watch.DefaultOptions()), FeedbackDirectory: directory})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	project := app.roots.List()[0]
	upload := decodeBody[contract.FeedbackUpload](t, uploadRequest(t, app, project, blankPNG(t, 612, 288), nil))
	key := sha256.Sum256([]byte(project))
	staged := filepath.Join(directory, hex.EncodeToString(key[:]), "staging", upload.ID+".png")
	past := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(staged, past, past); err != nil {
		t.Fatal(err)
	}

	var draft map[string]any
	if err := json.Unmarshal([]byte(pageDraft(t, project, upload.ID)), &draft); err != nil {
		t.Fatal(err)
	}
	draft["path"] = "code/main.go"
	visual, _ := draft["visual"].(map[string]any)
	rect, _ := visual["rect"].(map[string]any)
	rect["height"] = 240
	page, _ := visual["page"].(map[string]any)
	clip, _ := page["clip"].(map[string]any)
	clip["width"] = 600
	element, _ := visual["element"].(map[string]any)
	box, _ := element["box"].(map[string]any)
	box["height"] = 240
	encoded, err := json.Marshal(draft)
	if err != nil {
		t.Fatal(err)
	}
	response := feedbackRequest(t, app, http.MethodPost, "/api/feedback-threads", string(encoded), nil)
	var want, got contract.ErrorResponse
	if err := json.Unmarshal(visualFixture(t, "problems.json"), &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusBadRequest || got != want {
		t.Errorf("rejected visual draft = %d %+v\nwant problems.json %+v", response.Code, got, want)
	}
}

func TestFeedbackUploadFixtureMatchesTheContract(t *testing.T) {
	data := visualFixture(t, "upload.json")
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var upload contract.FeedbackUpload
	if err := decoder.Decode(&upload); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.MarshalIndent(upload, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, bytes.TrimSpace(data)) {
		t.Errorf("upload.json through FeedbackUpload =\n%s\nwant\n%s", encoded, data)
	}
}
