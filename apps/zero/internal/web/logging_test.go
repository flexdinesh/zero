package web

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/pkg/contract"
)

func loggingApp(level slog.Level) (*App, *bytes.Buffer) {
	var buffer bytes.Buffer
	return &App{log: slog.New(slog.NewTextHandler(&buffer, &slog.HandlerOptions{Level: level}))}, &buffer
}

// A server error is logged with its route and the start of its body; the
// query, which names files, is not.
func TestServerErrorsAreLoggedWithoutTheQuery(t *testing.T) {
	app, log := loggingApp(slog.LevelInfo)
	failing := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusInternalServerError, contract.ErrorResponse{Error: "could not read the index: " + strings.Repeat("x", 2*failureBodyLimit)})
	})
	response := httptest.NewRecorder()
	app.logged(failing).ServeHTTP(response, localRequest(http.MethodGet, "/api/page?project=/secret&path=a.go"))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", response.Code)
	}
	var body contract.ErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("the client's body changed: %v", err)
	}
	text := log.String()
	for _, want := range []string{"level=ERROR", `msg="request failed"`, "method=GET", "path=/api/page", "status=500", "could not read the index"} {
		if !strings.Contains(text, want) {
			t.Errorf("log %q lacks %q", text, want)
		}
	}
	if strings.Contains(text, "secret") || strings.Contains(text, "a.go") {
		t.Errorf("log %q keeps the query", text)
	}
	if len(text) > 2*failureBodyLimit {
		t.Errorf("log line is %d bytes; want the body bounded", len(text))
	}
}

// Other requests are logged only at debug level.
func TestRequestsAreLoggedAtDebugOnly(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	app, log := loggingApp(slog.LevelInfo)
	app.logged(ok).ServeHTTP(httptest.NewRecorder(), localRequest(http.MethodGet, "/api/projects"))
	if log.Len() != 0 {
		t.Errorf("info log = %q, want nothing", log.String())
	}
	app, log = loggingApp(slog.LevelDebug)
	app.logged(ok).ServeHTTP(httptest.NewRecorder(), localRequest(http.MethodGet, "/api/projects"))
	if !strings.Contains(log.String(), "path=/api/projects status=404") {
		t.Errorf("debug log = %q", log.String())
	}
}

// Event streams still flush through the log.
func TestLoggedRequestsStillFlush(t *testing.T) {
	app, _ := loggingApp(slog.LevelInfo)
	streaming := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("data: x\n\n"))
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("Flush = %v", err)
		}
	})
	response := httptest.NewRecorder()
	app.logged(streaming).ServeHTTP(response, localRequest(http.MethodGet, "/api/events"))
	if !response.Flushed {
		t.Error("the stream was not flushed")
	}
}

func TestAppServesDiagnostics(t *testing.T) {
	app := newTestApp(t, t.TempDir())
	response := request(t, app, "/api/diagnostics")
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("diagnostics = %d %v", response.Code, response.Header())
	}
	var report contract.Diagnostics
	decoder := json.NewDecoder(response.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&report); err != nil {
		t.Fatal(err)
	}
	if report.Mode != contract.DiagnosticsBrowser || report.Roots != 1 || report.LogsKept {
		t.Fatalf("report = %+v", report)
	}
}
