package web

import (
	"bytes"
	"net/http"
	"strings"
	"time"
)

// failureBodyLimit bounds how much of a failed response's body is logged.
const failureBodyLimit = 512

// logged records every request that fails with a server error, with its
// method, path, status, and body, and every request at debug level (decision
// 0151). The query is left out: it names files.
func (a *App) logged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		if recorder.status >= http.StatusInternalServerError {
			a.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "status", recorder.status,
				"error", strings.TrimSpace(recorder.body.String()))
			return
		}
		a.log.Debug("request", "method", r.Method, "path", r.URL.Path, "status", recorder.status, "duration", time.Since(start).Round(time.Millisecond))
	})
}

// statusRecorder remembers a response's status and the start of a failed
// response's body. It keeps flushing and http.ResponseController working
// for event streams.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	body        bytes.Buffer
}

func (s *statusRecorder) WriteHeader(status int) {
	if !s.wroteHeader {
		s.status, s.wroteHeader = status, true
	}
	s.ResponseWriter.WriteHeader(status)
}

func (s *statusRecorder) Write(p []byte) (int, error) {
	s.wroteHeader = true
	if s.status >= http.StatusInternalServerError && s.body.Len() < failureBodyLimit {
		s.body.Write(p[:min(len(p), failureBodyLimit-s.body.Len())])
	}
	return s.ResponseWriter.Write(p)
}

// FlushError flushes the underlying writer, reporting a failed write so
// event streams notice a gone client.
func (s *statusRecorder) FlushError() error {
	return http.NewResponseController(s.ResponseWriter).Flush()
}

func (s *statusRecorder) Flush() { _ = s.FlushError() }

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
