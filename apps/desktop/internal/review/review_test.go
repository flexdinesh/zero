package review

import (
	"math"
	"strings"
	"testing"
)

func TestCheckURL(t *testing.T) {
	for raw, want := range map[string]string{
		"http://localhost:5173/settings": "http://localhost:5173/settings",
		" https://example.test ":         "https://example.test",
		"localhost:3000":                 "http://localhost:3000",
	} {
		if got, ok := CheckURL(raw); !ok || got != want {
			t.Errorf("CheckURL(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "javascript:alert(1)", "file:///etc/passwd", "zero-app://local/", "http://", "http://user:pw@host/", "http://a b"} {
		if got, ok := CheckURL(raw); ok {
			t.Errorf("CheckURL(%q) = %q, accepted", raw, got)
		}
	}
}

func TestAllowsNavigation(t *testing.T) {
	for _, raw := range []string{"http://localhost:5173/", "https://example.test/a", "about:blank", "about:srcdoc", "data:text/html,hi", "blob:http://localhost:5173/9b1d"} {
		if !AllowsNavigation(raw) {
			t.Errorf("AllowsNavigation(%q) refused", raw)
		}
	}
	for _, raw := range []string{"zero-app://local/", "zero://local/", "file:///etc/passwd", "javascript:alert(1)", "about:config", "blob:zero-app://local/x", "localhost:3000", "chrome://settings"} {
		if AllowsNavigation(raw) {
			t.Errorf("AllowsNavigation(%q) allowed", raw)
		}
	}
}

func TestPlace(t *testing.T) {
	cases := []struct {
		name          string
		x, y, w, h    float64
		zoom          float64
		width, height int
		want          Frame
		ok            bool
	}{
		{"as reported", 300, 80, 600, 400, 1, 1200, 800, Frame{300, 80, 600, 400}, true},
		{"scaled by the page's zoom", 300, 80, 600, 400, 1.5, 2000, 1200, Frame{450, 120, 900, 600}, true},
		{"cut to the window", 300, 80, 2000, 2000, 1, 1200, 800, Frame{300, 80, 900, 720}, true},
		{"cut at the top left", -20, -10, 200, 100, 1, 1200, 800, Frame{0, 0, 180, 90}, true},
		{"rounded", 10.4, 20.6, 100.2, 50.2, 1, 1200, 800, Frame{10, 21, 101, 50}, true},
		{"a zoom that is none is 1", 10, 10, 100, 100, 0, 1200, 800, Frame{10, 10, 100, 100}, true},
		{"too small", 10, 10, 8, 100, 1, 1200, 800, Frame{}, false},
		{"outside the window", 1300, 10, 100, 100, 1, 1200, 800, Frame{}, false},
		{"no size", 10, 10, 0, 100, 1, 1200, 800, Frame{}, false},
		{"not a number", math.NaN(), 10, 100, 100, 1, 1200, 800, Frame{}, false},
		{"endless", 10, 10, math.Inf(1), 100, 1, 1200, 800, Frame{}, false},
	}
	for _, c := range cases {
		got, ok := Place(c.x, c.y, c.w, c.h, c.zoom, c.width, c.height)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: Place = %v, %v, want %v, %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestGuestScriptIsEmbedded(t *testing.T) {
	if !strings.Contains(Guest, "__zeroBrowser") || !strings.Contains(Guest, "keydown") {
		t.Error("the guest script is missing its marker or its keys")
	}
}
