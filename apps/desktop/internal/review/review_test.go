package review

import (
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

func TestTitle(t *testing.T) {
	if got := Title("http://localhost:5173/settings?tab=2", "/home/u/code/app/", "feature/menu"); got != "localhost:5173/settings?tab=2 · app · feature/menu" {
		t.Errorf("Title = %q", got)
	}
	if got := Title("https://example.test/", "/p", ""); got != "example.test/ · p · detached HEAD" {
		t.Errorf("Title(detached) = %q", got)
	}
}

func TestParseFacts(t *testing.T) {
	raw := `{"title":"  Settings\n · Acme\t","width":1440,"height":900.4,"devicePixelRatio":2,"scrollX":0,"scrollY":1319.6}`
	page, err := ParseFacts(raw, "http://localhost:5173/settings?tab=billing", 1.25)
	if err != nil {
		t.Fatal(err)
	}
	want := Page{URL: "http://localhost:5173/settings?tab=billing", Title: "Settings · Acme", Viewport: Viewport{Width: 1440, Height: 900, DeviceScaleFactor: 2.5}, Scroll: Scroll{X: 0, Y: 1320}}
	if page != want {
		t.Errorf("ParseFacts = %+v, want %+v", page, want)
	}
	if page, _ := ParseFacts(raw, "http://a.test/", 0); page.Viewport.DeviceScaleFactor != 2 {
		t.Errorf("no zoom: deviceScaleFactor = %v, want the ratio alone", page.Viewport.DeviceScaleFactor)
	}
	long, _ := ParseFacts(`{"title":"`+strings.Repeat("a", 400)+`","width":10,"height":10,"devicePixelRatio":1,"scrollX":0,"scrollY":0}`, "http://a.test/", 1)
	if n := len([]rune(long.Title)); n != 256 || !strings.HasSuffix(long.Title, "…") {
		t.Errorf("long title: %d characters", n)
	}
	for name, test := range map[string][2]string{
		"about page":    {raw, "about:blank"},
		"bare host":     {raw, "localhost:5173"},
		"app page":      {raw, "zero-app://local/"},
		"not JSON":      {"{", "http://a.test/"},
		"no viewport":   {`{"width":0,"height":10,"devicePixelRatio":1,"scrollX":0,"scrollY":0}`, "http://a.test/"},
		"huge viewport": {`{"width":1e9,"height":10,"devicePixelRatio":1,"scrollX":0,"scrollY":0}`, "http://a.test/"},
		"no ratio":      {`{"width":10,"height":10,"devicePixelRatio":0,"scrollX":0,"scrollY":0}`, "http://a.test/"},
		"wild scroll":   {`{"width":10,"height":10,"devicePixelRatio":1,"scrollX":1e12,"scrollY":0}`, "http://a.test/"},
	} {
		if page, err := ParseFacts(test[0], test[1], 1); err == nil {
			t.Errorf("%s: accepted %+v", name, page)
		}
	}
}

func TestSameView(t *testing.T) {
	captured := Page{URL: "http://a.test/", Viewport: Viewport{Width: 800, Height: 600, DeviceScaleFactor: 2}, Scroll: Scroll{Y: 40}}
	now := captured
	now.Title = "Renamed"
	if !SameView(captured, now) {
		t.Error("a new title is still the same view")
	}
	for name, change := range map[string]func(*Page){
		"url":    func(p *Page) { p.URL = "http://a.test/b" },
		"scroll": func(p *Page) { p.Scroll.Y = 41 },
		"size":   func(p *Page) { p.Viewport.Width = 801 },
	} {
		moved := captured
		change(&moved)
		if SameView(captured, moved) {
			t.Errorf("%s changed, but SameView", name)
		}
	}
}

func TestParseElement(t *testing.T) {
	viewport := Viewport{Width: 800, Height: 600, DeviceScaleFactor: 1}
	raw := `{"selector":"main form > button[data-testid=\"save\"]","tag":"button","role":"button","name":"Save\n  changes","text":"` + strings.Repeat("x", 300) + `","box":{"x":-10.2,"y":580,"width":210.4,"height":48}}`
	element, ok := ParseElement(raw, viewport)
	if !ok || element == nil {
		t.Fatalf("ParseElement = %+v, %v", element, ok)
	}
	if element.Selector != `main form > button[data-testid="save"]` || element.Tag != "button" || element.Role != "button" || element.Name != "Save changes" {
		t.Errorf("element = %+v", element)
	}
	if n := len([]rune(element.Text)); n != 256 {
		t.Errorf("text: %d characters, want 256", n)
	}
	if element.Box == nil || *element.Box != (Rect{X: 0, Y: 580, Width: 200, Height: 20}) {
		t.Errorf("box = %+v, want clipped to the viewport", element.Box)
	}
	if element, ok := ParseElement("null", viewport); !ok || element != nil {
		t.Errorf("null = %+v, %v", element, ok)
	}
	outside, ok := ParseElement(`{"selector":"p","tag":"p","role":"`+strings.Repeat("r", 65)+`","box":{"x":900,"y":0,"width":10,"height":10}}`, viewport)
	if !ok || outside.Box != nil || outside.Role != "" {
		t.Errorf("outside the viewport, long role = %+v, %v", outside, ok)
	}
	for name, raw := range map[string]string{
		"no selector":   `{"selector":"","tag":"p"}`,
		"long selector": `{"selector":"` + strings.Repeat("a", 513) + `","tag":"p"}`,
		"control":       `{"selector":"p\u0000","tag":"p"}`,
		"upper tag":     `{"selector":"p","tag":"P"}`,
		"odd tag":       `{"selector":"p","tag":"p q"}`,
		"long tag":      `{"selector":"p","tag":"` + strings.Repeat("a", 33) + `"}`,
		"not JSON":      `{`,
	} {
		if element, ok := ParseElement(raw, viewport); ok {
			t.Errorf("%s: accepted %+v", name, element)
		}
	}
}

func TestIsCaptureID(t *testing.T) {
	if !IsCaptureID("0123456789ab") || IsCaptureID("0123456789AB") || IsCaptureID("0123") || IsCaptureID("0123456789abc") {
		t.Error("IsCaptureID accepts twelve lowercase hex digits only")
	}
}

func TestGuestScriptIsEmbedded(t *testing.T) {
	if !strings.Contains(Guest, "__zeroReview") || !strings.Contains(Guest, "elementAt") || !strings.Contains(Guest, "facts") {
		t.Error("the guest script is missing its API")
	}
}
