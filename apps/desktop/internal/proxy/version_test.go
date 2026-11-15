package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flexdinesh/zero/pkg/contract"
)

// describing is a server whose /_zero/remote answers info (or fails while
// broken), and whose pages answer "page".
func describing(t *testing.T, info contract.RemoteInfo, broken *atomic.Bool, asked *atomic.Int32) *pinnedServer {
	t.Helper()
	return startPinned(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == contract.RemoteInfoPath {
			asked.Add(1)
			if broken != nil && broken.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_ = json.NewEncoder(w).Encode(info)
			return
		}
		_, _ = io.WriteString(w, "page")
	}))
}

type warnings struct {
	mu   sync.Mutex
	got  []string
	seen chan struct{}
}

func (w *warnings) warn(host, label string, server contract.RemoteInfo, warning string) {
	w.mu.Lock()
	w.got = append(w.got, host+"|"+label+"|"+server.Version+"|"+warning)
	w.mu.Unlock()
	w.seen <- struct{}{}
}

func checkingProxy(t *testing.T, remote *pinnedServer, local contract.RemoteInfo) (*Proxy, *warnings) {
	t.Helper()
	store := &fakeStore{}
	store.put(remote.saved)
	connections := NewConnections(&fakeDaemon{}, store, "")
	w := &warnings{seen: make(chan struct{}, 8)}
	connections.CheckVersions(VersionCheck{Local: local, Warn: w.warn})
	p := New(connections)
	t.Cleanup(p.Close)
	return p, w
}

func load(p *Proxy, origin string, document bool) *httptest.ResponseRecorder {
	r := request(http.MethodGet, origin+"/", nil)
	if document {
		r.Header.Set("Accept", "text/html")
		r.Header.Set("Sec-Fetch-Dest", "document")
	} else {
		r.Header.Set("Accept", "application/json")
	}
	recorder := httptest.NewRecorder()
	p.ServeHTTP(recorder, r)
	return recorder
}

func TestAnOlderServerWarnsOnceAndStillLoads(t *testing.T) {
	var asked atomic.Int32
	remote := describing(t, contract.RemoteInfo{Protocol: 1, Version: "0.2.0", Name: "box"}, nil, &asked)
	p, w := checkingProxy(t, remote, contract.RemoteInfo{Protocol: 1, Version: "0.2.1"})
	origin := OriginOf(remote.saved.ID)
	for range 3 {
		if got := load(p, origin, true); got.Code != http.StatusOK || got.Body.String() != "page" {
			t.Fatalf("page load = %d %q", got.Code, got.Body.String())
		}
	}
	select {
	case <-w.seen:
	case <-time.After(5 * time.Second):
		t.Fatal("no warning")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	want := remote.saved.ID + "|box|0.2.0|box runs zero 0.2.0; this computer runs 0.2.1. On box, run `zero update`, then start `zero <path> --remote` again."
	if len(w.got) != 1 || w.got[0] != want {
		t.Fatalf("warnings = %q, want [%q]", w.got, want)
	}
	if asked.Load() != 1 {
		t.Fatalf("asked the server %d times, want once", asked.Load())
	}
}

func TestTheSameReleaseDoesNotWarn(t *testing.T) {
	var asked atomic.Int32
	remote := describing(t, contract.RemoteInfo{Protocol: 1, Version: "0.2.0", Name: "box"}, nil, &asked)
	p, w := checkingProxy(t, remote, contract.RemoteInfo{Protocol: 1, Version: "0.2.0"})
	if got := load(p, OriginOf(remote.saved.ID), true); got.Code != http.StatusOK {
		t.Fatalf("page load = %d", got.Code)
	}
	select {
	case <-w.seen:
		t.Fatalf("warned: %q", w.got)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestAnotherProtocolIsRefusedForEveryRequest(t *testing.T) {
	var asked atomic.Int32
	remote := describing(t, contract.RemoteInfo{Protocol: 2, Version: "0.9.0", Name: "box"}, nil, &asked)
	p, _ := checkingProxy(t, remote, contract.RemoteInfo{Protocol: 1, Version: "0.2.0"})
	origin := OriginOf(remote.saved.ID)
	page := load(p, origin, true)
	if page.Code != http.StatusBadGateway || page.Body.String() == "page" {
		t.Fatalf("page load = %d %q", page.Code, page.Body.String())
	}
	api := load(p, origin, false)
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if api.Code != http.StatusBadGateway || json.Unmarshal(api.Body.Bytes(), &body) != nil || body.Code != "remoteIncompatible" {
		t.Fatalf("request = %d %q", api.Code, api.Body.String())
	}
}

func TestAServerThatCannotDescribeItselfIsCheckedAgain(t *testing.T) {
	var asked atomic.Int32
	var broken atomic.Bool
	broken.Store(true)
	remote := describing(t, contract.RemoteInfo{Protocol: 1, Version: "0.3.0", Name: "box"}, &broken, &asked)
	p, w := checkingProxy(t, remote, contract.RemoteInfo{Protocol: 1, Version: "0.2.0"})
	origin := OriginOf(remote.saved.ID)
	if got := load(p, origin, true); got.Code != http.StatusOK {
		t.Fatalf("first load = %d", got.Code)
	}
	// Page requests do not check; the next page load does.
	load(p, origin, false)
	if asked.Load() != 1 {
		t.Fatalf("asked %d times before the second page load", asked.Load())
	}
	broken.Store(false)
	load(p, origin, true)
	select {
	case <-w.seen:
	case <-time.After(5 * time.Second):
		t.Fatal("no warning after the server answered")
	}
}
