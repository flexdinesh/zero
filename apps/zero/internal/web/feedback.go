package web

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"

	"github.com/flexdinesh/zero/internal/app"
	"github.com/flexdinesh/zero/pkg/contract"
)

// Review feedback (decision 0120) is read and written by the browser and by
// agents through app.Feedback. Writes take the walkthrough guards: JSON
// only, at most 1 MiB, and no foreign Origin. Screenshot uploads (decision
// 0176) take a PNG body of at most 8 MiB instead.

// compareQueryNames are the query parameters a compare takes, as
// /api/compare-stats reads them.
var compareQueryNames = []string{"base", "head", "uncommitted", "commit", "from", "to"}

func (a *App) serveFeedback(w http.ResponseWriter, r *http.Request, query url.Values) {
	request := contract.FeedbackRequest{Project: query.Get("project"), ID: query.Get("id")}
	if query.Has("compare") {
		request.Compare = &contract.FeedbackCompare{
			Kind: contract.FeedbackCompareKind(query.Get("compare")),
			Base: query.Get("base"), Head: query.Get("head"), Uncommitted: query.Has("uncommitted"),
			Commit: query.Get("commit"), From: query.Get("from"), To: query.Get("to"),
		}
	}
	if problem := feedbackQueryProblem(query); problem != "" {
		if _, err := a.app.Projects.Resolve(request.Project); err != nil {
			writeError(w, err)
			return
		}
		writeQueryError(w, problem)
		return
	}
	stored, err := a.app.Feedback.Get(r.Context(), request)
	writeResult(w, stored, err)
}

// feedbackQueryProblem rejects compare parameters without a compare and an
// uncommitted other than 1.
func feedbackQueryProblem(query url.Values) string {
	if !query.Has("compare") {
		for _, name := range compareQueryNames {
			if query.Has(name) {
				return "Name the compare that " + name + " belongs to: compare=working, branch, commit, or range."
			}
		}
		return ""
	}
	if query.Has("uncommitted") && query.Get("uncommitted") != "1" {
		return "Uncommitted must be 1."
	}
	return ""
}

// writeFeedbackGuards refuses a feedback write from another site or not in
// JSON; it reports whether it did.
func writeFeedbackGuards(w http.ResponseWriter, r *http.Request) bool {
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "Feedback can't be changed from another site.", Code: contract.CodeForeignOrigin})
		return true
	}
	if r.Method != http.MethodPost {
		return false
	}
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, errorResponse{Error: "Send feedback as Content-Type: application/json.", Code: contract.CodeUnsupportedMediaType})
		return true
	}
	return false
}

// writeDraftError answers a draft that could not be decoded: 413 past the
// body limit, else 400; both with code invalidFeedback.
func writeDraftError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeJSON(w, http.StatusRequestEntityTooLarge, errorResponse{Error: fmt.Sprintf("A feedback request is at most %d bytes.", app.MaxFeedbackBytes), Code: contract.CodeInvalidFeedback})
		return
	}
	writeJSON(w, http.StatusBadRequest, errorResponse{Error: err.Error(), Code: contract.CodeInvalidFeedback})
}

func (a *App) serveCreateFeedbackThread(w http.ResponseWriter, r *http.Request) {
	if writeFeedbackGuards(w, r) {
		return
	}
	draft, err := app.DecodeFeedbackThreadDraft(http.MaxBytesReader(w, r.Body, app.MaxFeedbackBytes))
	if err != nil {
		writeDraftError(w, err)
		return
	}
	thread, err := a.app.Feedback.CreateThread(r.Context(), draft)
	writeResult(w, thread, err)
}

func (a *App) servePostFeedbackMessage(w http.ResponseWriter, r *http.Request) {
	if writeFeedbackGuards(w, r) {
		return
	}
	draft, err := app.DecodeFeedbackMessageDraft(http.MaxBytesReader(w, r.Body, app.MaxFeedbackBytes))
	if err != nil {
		writeDraftError(w, err)
		return
	}
	thread, err := a.app.Feedback.PostMessage(r.Context(), draft)
	writeResult(w, thread, err)
}

// serveDeleteFeedback removes one thread (thread set) or a whole feedback.
func (a *App) serveDeleteFeedback(w http.ResponseWriter, r *http.Request, thread bool) {
	if writeFeedbackGuards(w, r) {
		return
	}
	query := r.URL.Query()
	request := contract.FeedbackDeleteRequest{Project: query.Get("project"), ID: query.Get("id")}
	var err error
	if thread {
		// A missing or malformed number is thread 0, which the app rejects.
		request.Thread, _ = strconv.Atoi(query.Get("thread"))
		err = a.app.Feedback.DeleteThread(request)
	} else {
		err = a.app.Feedback.Delete(request)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Local marks every request next serves as arriving on a transport that
// shares the project's host (app.TransportLocal): wrap only the daemon's
// Unix socket and `zero browser`'s loopback listener with it. Every other
// listener stays remote, so a visual target's loopback URL names the
// reviewer's machine (decision 0176).
func Local(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(app.WithTransport(r.Context(), app.TransportLocal)))
	})
}

// serveUploadFeedbackAttachment stages a screenshot: POST
// /api/feedback-attachments?project=, a PNG body of at most 8 MiB, from no
// foreign Origin. It answers 201 with the upload.
func (a *App) serveUploadFeedbackAttachment(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "Feedback can't be changed from another site.", Code: contract.CodeForeignOrigin})
		return
	}
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "image/png" {
		writeJSON(w, http.StatusUnsupportedMediaType, errorResponse{Error: "Send a screenshot as Content-Type: image/png.", Code: contract.CodeUnsupportedMediaType})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, contract.MaxFeedbackAttachmentBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errorResponse{Error: app.AttachmentTooLargeMessage, Code: contract.CodeInvalidFeedback})
			return
		}
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "Couldn't read the screenshot: " + err.Error(), Code: contract.CodeInvalidFeedback})
		return
	}
	upload, err := a.app.Feedback.UploadAttachment(r.URL.Query().Get("project"), data)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, upload)
}

// serveFeedbackAttachment answers a screenshot's PNG, sandboxed as
// /api/image answers a commit's image. An attachment never changes, so it
// is cached privately.
func (a *App) serveFeedbackAttachment(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	content, size, err := a.app.Feedback.OpenAttachment(contract.FeedbackAttachmentRequest{Project: query.Get("project"), ID: query.Get("id"), Attachment: query.Get("attachment")})
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		writeError(w, err)
		return
	}
	defer func() { _ = content.Close() }()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	_, _ = io.Copy(w, content)
}
