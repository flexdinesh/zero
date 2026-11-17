package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/flexdinesh/zero/pkg/connection"
)

// The server keeps presence open until upstream cancellation. Downstream
// writes always succeed, so no webview write failure can end these requests.
func lifetimeTLS(t *testing.T) (*pinnedServer, <-chan context.Context) {
	t.Helper()
	started := make(chan context.Context, 16)
	server := startPinned(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- r.Context()
		if r.URL.Path != "/blocked" {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, ": zero\n\n")
			_ = http.NewResponseController(w).Flush()
		}
		<-r.Context().Done()
	}))
	return server, started
}

func lifetimeStarted(t *testing.T, started <-chan context.Context) context.Context {
	t.Helper()
	select {
	case ctx := <-started:
		return ctx
	case <-time.After(5 * time.Second):
		t.Fatal("TLS request did not reach the server")
		return nil
	}
}

func lifetimeEnded(t *testing.T, done <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s outlived its connection", name)
	}
}

func lifetimeEndpoint(t *testing.T, connections *Connections, host string) connection.Endpoint {
	t.Helper()
	endpoint, found, err := connections.Endpoint(host)
	if err != nil || !found {
		t.Fatalf("Endpoint = %v, %v", found, err)
	}
	return endpoint
}

// Like the notifier, this bypasses Proxy and uses the endpoint's transport.
func lifetimeBody(t *testing.T, endpoint connection.Endpoint, started <-chan context.Context) (io.ReadCloser, context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.BaseURL()+"/api/presence", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := endpoint.RoundTripper().RoundTrip(r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	upstream := lifetimeStarted(t, started)
	marker := make([]byte, len(": zero\n\n"))
	if _, err := io.ReadFull(response.Body, marker); err != nil || string(marker) != ": zero\n\n" {
		t.Fatalf("presence body = %q, %v", marker, err)
	}
	return response.Body, upstream, cancel
}

func TestSavedConnectionEndsActiveTLSPresence(t *testing.T) {
	for _, ending := range []string{"Drop", "Close", "replacement"} {
		t.Run(ending, func(t *testing.T) {
			server, started := lifetimeTLS(t)
			// Two saved hosts deliberately reach the same TLS service: each
			// still owns an independent connection instance and transport.
			other := server.saved
			other.ID = "r-000000000000"
			store := &fakeStore{}
			store.put(server.saved)
			store.put(other)
			connections := NewConnections(&fakeDaemon{}, store, "")
			p := New(connections)
			p.keepalive = time.Hour
			t.Cleanup(p.Close)

			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel) // Failure cleanup only; Drop must end the request.
			writer := &streamWriter{header: http.Header{}, cancel: cancel, chunks: make(chan string, 16)}
			done := make(chan struct{})
			go func() {
				defer close(done)
				p.ServeHTTP(writer, request(http.MethodGet, OriginOf(server.saved.ID)+"/api/presence", nil).WithContext(ctx))
			}()
			presence := lifetimeStarted(t, started)
			select {
			case chunk := <-writer.chunks:
				if chunk != ": zero\n\n" {
					t.Fatalf("presence chunk = %q", chunk)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("presence did not reach the writable downstream")
			}

			old := lifetimeEndpoint(t, connections, server.saved.ID)
			_, notifier, _ := lifetimeBody(t, old, started)
			_, unrelated, _ := lifetimeBody(t, lifetimeEndpoint(t, connections, other.ID), started)
			switch ending {
			case "Drop":
				connections.Drop(server.saved.ID)
			case "Close":
				connections.Close()
			case "replacement":
				changed := server.saved
				changed.Label = "updated connection"
				store.put(changed)
				_ = lifetimeEndpoint(t, connections, changed.ID)
			}
			lifetimeEnded(t, presence.Done(), "TLS presence")
			lifetimeEnded(t, notifier.Done(), "shared notifier request")
			lifetimeEnded(t, done, "proxy handler with a writable downstream")
			if ctx.Err() != nil {
				t.Fatal("downstream cancellation masked the connection lifetime")
			}
			if ending == "Close" {
				lifetimeEnded(t, unrelated.Done(), "other connection on Close")
				return
			}
			if unrelated.Err() != nil {
				t.Fatal("ending one connection canceled another")
			}
			fresh := lifetimeEndpoint(t, connections, server.saved.ID)
			if fresh == old {
				t.Fatal("reopening retained the ended instance")
			}
			_, reopened, _ := lifetimeBody(t, fresh, started)
			if reopened.Err() != nil {
				t.Fatal("the old lifetime canceled the reopened connection")
			}
			r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, old.BaseURL()+"/api/presence", nil)
			if err != nil {
				t.Fatal(err)
			}
			if response, err := old.RoundTripper().RoundTrip(r); err == nil {
				_ = response.Body.Close()
				t.Fatal("an ended instance accepted a new request")
			}
		})
	}
}

func TestSavedConnectionBodyRetainsParentCancellation(t *testing.T) {
	server, started := lifetimeTLS(t)
	store := &fakeStore{}
	store.put(server.saved)
	connections := NewConnections(&fakeDaemon{}, store, "")
	t.Cleanup(connections.Close)
	endpoint := lifetimeEndpoint(t, connections, server.saved.ID)
	body, upstream, cancel := lifetimeBody(t, endpoint, started)
	if upstream.Err() != nil {
		t.Fatal("returning headers canceled the response body")
	}
	cancel()
	lifetimeEnded(t, upstream.Done(), "parent-canceled response body")
	if _, err := body.Read(make([]byte, 1)); err == nil {
		t.Fatal("canceled response body remained readable")
	}

	body, upstream, _ = lifetimeBody(t, endpoint, started)
	if err := body.Close(); err != nil {
		t.Fatal(err)
	}
	lifetimeEnded(t, upstream.Done(), "closed response body")
	// Closing one body releases only that request, not the instance.
	_, next, _ := lifetimeBody(t, endpoint, started)
	if next.Err() != nil {
		t.Fatal("closing one body canceled the connection")
	}
}

func TestSavedConnectionCloseCancelsTLSBeforeHeaders(t *testing.T) {
	server, started := lifetimeTLS(t)
	store := &fakeStore{}
	store.put(server.saved)
	connections := NewConnections(&fakeDaemon{}, store, "")
	t.Cleanup(connections.Close)
	endpoint := lifetimeEndpoint(t, connections, server.saved.ID)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.BaseURL()+"/blocked", nil)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		response, err := endpoint.RoundTripper().RoundTrip(r)
		if response != nil {
			_ = response.Body.Close()
		}
		result <- err
	}()
	upstream := lifetimeStarted(t, started)
	connections.Close()
	lifetimeEnded(t, upstream.Done(), "request waiting for TLS headers")
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("closed request returned no error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RoundTrip did not return after Close")
	}
	if ctx.Err() != nil {
		t.Fatal("Close depended on caller cancellation")
	}
}

type lifetimeRoundTripper func(*http.Request) (*http.Response, error)

func (f lifetimeRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Observe the actual request context so network buffering cannot hide an
// early cancel, or a request context left registered after an error/Close.
func TestSavedConnectionReleasesRequestContext(t *testing.T) {
	server := startPinned(t, http.NotFoundHandler())
	for _, failed := range []bool{false, true} {
		name := "body Close"
		if failed {
			name = "transport error"
		}
		t.Run(name, func(t *testing.T) {
			remote, err := newRemote(server.saved, "")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(remote.Close)
			var captured context.Context
			remote.transport = lifetimeRoundTripper(func(r *http.Request) (*http.Response, error) {
				captured = r.Context()
				if failed {
					return nil, io.ErrUnexpectedEOF
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("body"))}, nil
			})
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			r, err := http.NewRequestWithContext(parent, http.MethodGet, remote.BaseURL(), nil)
			if err != nil {
				t.Fatal(err)
			}
			response, err := remote.RoundTripper().RoundTrip(r)
			if failed {
				if !errors.Is(err, io.ErrUnexpectedEOF) {
					t.Fatalf("transport error = %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if captured.Err() != nil {
					t.Fatal("returning headers canceled the request context")
				}
				if err := response.Body.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if !errors.Is(captured.Err(), context.Canceled) {
				t.Fatal("request context was not released")
			}
			if parent.Err() != nil {
				t.Fatal("releasing a request canceled its parent")
			}
		})
	}
}
