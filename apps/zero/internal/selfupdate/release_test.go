package selfupdate

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseRelease(t *testing.T) {
	valid := map[string]Release{"0.2.0": {0, 2, 0}, "1.10.3": {1, 10, 3}}
	for text, want := range valid {
		if got, ok := ParseRelease(text); !ok || got != want {
			t.Errorf("ParseRelease(%q) = %v, %v", text, got, ok)
		}
	}
	for _, text := range []string{"", "dev", "v0.2.0", "0.2", "0.2.0.1", "0.0.0-dev.main", "0.2.0+x", "01.2.3", "0.-1.0", "a.b.c"} {
		if _, ok := ParseRelease(text); ok {
			t.Errorf("ParseRelease(%q) accepted", text)
		}
	}
}

func TestNewer(t *testing.T) {
	tests := []struct {
		latest, current string
		want            bool
	}{
		{"0.2.1", "0.2.0", true},
		{"0.10.0", "0.9.9", true},
		{"1.0.0", "0.99.99", true},
		{"0.2.0", "0.2.0", false},
		{"0.1.9", "0.2.0", false},
		{"0.2.1", "0.0.0-dev.main", false},
		{"", "0.2.0", false},
	}
	for _, test := range tests {
		if got := Newer(test.latest, test.current); got != test.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", test.latest, test.current, got, test.want)
		}
	}
}

func TestInstallScriptURLPinsTheReleaseTag(t *testing.T) {
	want := "https://raw.githubusercontent.com/flexdinesh/zero/v0.2.1/scripts/install.sh"
	if got := InstallScriptURL("0.2.1"); got != want {
		t.Fatalf("InstallScriptURL() = %q, want %q", got, want)
	}
}

func releasesServer(t *testing.T, handler http.HandlerFunc) Releases {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return Releases{BaseURL: server.URL, UserAgent: "zero/test"}
}

func TestLatestReadsTheRedirect(t *testing.T) {
	releases := releasesServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/releases/latest" || r.Header.Get("User-Agent") != "zero/test" {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "https://github.com/flexdinesh/zero/releases/tag/v0.2.1", http.StatusFound)
	})
	if got, err := releases.Latest(context.Background()); err != nil || got != "0.2.1" {
		t.Fatalf("Latest() = %q, %v", got, err)
	}
}

func TestLatestRejects(t *testing.T) {
	tests := map[string]http.HandlerFunc{
		"no release": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://github.com/flexdinesh/zero/releases", http.StatusFound)
		},
		"not a redirect": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Location", "https://github.com/flexdinesh/zero/releases/tag/v0.2.1")
			w.WriteHeader(http.StatusOK)
		},
		"edge tag": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://github.com/flexdinesh/zero/releases/tag/edge", http.StatusFound)
		},
		"prerelease tag": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://github.com/flexdinesh/zero/releases/tag/v0.3.0-rc.1", http.StatusFound)
		},
		"server error": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) },
	}
	for name, handler := range tests {
		t.Run(name, func(t *testing.T) {
			if got, err := releasesServer(t, handler).Latest(context.Background()); err == nil {
				t.Fatalf("Latest() = %q, want an error", got)
			}
		})
	}
}

func TestLatestHonorsTheClientTimeout(t *testing.T) {
	release := make(chan struct{})
	releases := releasesServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	defer close(release)
	releases.Client = &http.Client{Timeout: 50 * time.Millisecond}
	_, err := releases.Latest(context.Background())
	if err == nil || !strings.Contains(err.Error(), "find the latest zero release") {
		t.Fatalf("Latest() error = %v", err)
	}
}
