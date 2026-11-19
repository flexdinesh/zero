package review

import (
	"context"
	"encoding/base64"
	"errors"
	"strconv"
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

// hitsAnswer is a capture() answer for an 800×600 viewport holding hits.
func hitsAnswer(hits string) string {
	return `{"title":"t","width":800,"height":600,"devicePixelRatio":1,"scrollX":0,"scrollY":0,"hits":` + hits + `}`
}

// grid is a grid of cells cells, all value.
func grid(cells, value int) string {
	parts := make([]string, cells)
	for index := range parts {
		parts[index] = strconv.Itoa(value)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func TestParseHits(t *testing.T) {
	viewport := Viewport{Width: 800, Height: 600, DeviceScaleFactor: 1}
	// 8 px cells: 100 × 75.
	elements := `[{"parent":-1,"tag":"body","box":{"x":0,"y":0,"width":800,"height":600}},
		{"parent":0,"tag":"button","selector":"[data-testid=\"save\"]","role":"button","name":"Save\n  changes","text":"` + strings.Repeat("x", 300) + `","meaningful":true,"box":{"x":-10.2,"y":580.5,"width":210.4,"height":48}},
		{"parent":0,"tag":"linearGradient","selector":"p\u0000","role":"` + strings.Repeat("r", 65) + `","box":{"x":900,"y":0,"width":10,"height":10}}]`
	hits := ParseHits(hitsAnswer(`{"step":8,"columns":100,"rows":75,"grid":`+grid(7500, 1)+`,"elements":`+elements+`}`), viewport)
	if hits == nil {
		t.Fatal("ParseHits refused a sound map")
	}
	save := hits.Elements[1]
	if save.Parent != 0 || save.Tag != "button" || save.Selector != `[data-testid="save"]` || save.Role != "button" || save.Name != "Save changes" || !save.Meaningful {
		t.Errorf("button = %+v", save)
	}
	if n := len([]rune(save.Text)); n != 256 {
		t.Errorf("text: %d characters, want 256", n)
	}
	if save.Box == nil || *save.Box != (Rect{X: 0, Y: 580, Width: 201, Height: 20}) {
		t.Errorf("box = %+v, want rounded outward and clipped to the viewport", save.Box)
	}
	// The page's word on one element drops that word, not the map.
	if odd := hits.Elements[2]; odd.Tag != "" || odd.Selector != "" || odd.Role != "" || odd.Box != nil {
		t.Errorf("odd tag, control selector, long role, box outside = %+v, want each dropped", odd)
	}

	sound := func(step, columns, rows int, cells string, elements string) string {
		return hitsAnswer(`{"step":` + strconv.Itoa(step) + `,"columns":` + strconv.Itoa(columns) + `,"rows":` + strconv.Itoa(rows) + `,"grid":` + cells + `,"elements":` + elements + `}`)
	}
	one := `[{"parent":-1,"tag":"body"}]`
	for name, raw := range map[string]string{
		"no hits":         `{"width":800,"height":600}`,
		"not JSON":        `{`,
		"zero step":       sound(0, 100, 75, grid(7500, 0), one),
		"wrong columns":   sound(8, 99, 75, grid(7425, 0), one),
		"short grid":      sound(8, 100, 75, grid(7499, 0), one),
		"too many cells":  sound(2, 400, 300, grid(120000, 0), one),
		"cell past end":   sound(8, 100, 75, grid(7500, 1), one),
		"cell below none": sound(8, 100, 75, grid(7500, -2), one),
		"later parent":    sound(8, 100, 75, grid(7500, 0), `[{"parent":1,"tag":"a"},{"parent":-1,"tag":"b"}]`),
		"own parent":      sound(8, 100, 75, grid(7500, 0), `[{"parent":0,"tag":"a"}]`),
		"too many":        sound(8, 100, 75, grid(7500, 0), "["+strings.TrimSuffix(strings.Repeat(`{"parent":-1},`, MaxHitElements+1), ",")+"]"),
	} {
		if got := ParseHits(raw, viewport); got != nil {
			t.Errorf("%s: accepted a map of %d elements", name, len(got.Elements))
		}
	}
}

// fakePage is a guest page whose capture() and signature() answer in turn.
type fakePage struct {
	answers []string
	evals   []string
	frames  int
	failAt  string
}

func (f *fakePage) URL() string         { return "http://localhost:5173/settings" }
func (f *fakePage) ZoomFactor() float64 { return 1.5 }
func (f *fakePage) CapturePage() ([]byte, error) {
	f.frames++
	if f.failAt == "frame" {
		return nil, errors.New("no frame")
	}
	return []byte("png" + strconv.Itoa(f.frames)), nil
}
func (f *fakePage) Eval(_ context.Context, code string) (string, error) {
	f.evals = append(f.evals, code)
	if f.failAt == "eval" || len(f.answers) == 0 {
		return "", errors.New("no answer")
	}
	answer := f.answers[0]
	f.answers = f.answers[1:]
	return answer, nil
}

func TestCaptureFrom(t *testing.T) {
	answer := func(signature string) string {
		return `{"title":"Settings","width":800,"height":600,"devicePixelRatio":2,"scrollX":0,"scrollY":40,"signature":"` + signature + `",
			"hits":{"step":8,"columns":100,"rows":75,"grid":` + grid(7500, 0) + `,"elements":[{"parent":-1,"tag":"body"}]}}`
	}

	still := &fakePage{answers: []string{answer("a"), "a"}}
	capture, err := CaptureFrom(context.Background(), still, "/p")
	if err != nil {
		t.Fatal(err)
	}
	// The facts and hit map come first, in one evaluation; the frame after.
	if len(still.evals) != 2 || !strings.Contains(still.evals[0], "capture()") || !strings.Contains(still.evals[1], "signature()") || still.frames != 1 {
		t.Errorf("evaluations %q, %d frames", still.evals, still.frames)
	}
	if capture.Drift || capture.Hits == nil || capture.Project != "/p" || capture.PNG != base64.StdEncoding.EncodeToString([]byte("png1")) ||
		capture.Page.Viewport.DeviceScaleFactor != 3 || capture.Page.Scroll.Y != 40 || len(capture.ID) != 12 {
		t.Errorf("capture = %+v", capture)
	}

	// A layout that moves once is captured again; the second capture holds.
	once := &fakePage{answers: []string{answer("a"), "b", answer("c"), "c"}}
	if capture, err := CaptureFrom(context.Background(), once, "/p"); err != nil || capture.Drift || capture.PNG != base64.StdEncoding.EncodeToString([]byte("png2")) {
		t.Errorf("moved once: %+v, %v; want the second frame without drift", capture, err)
	}
	// A layout that keeps moving is captured twice, then marked.
	moving := &fakePage{answers: []string{answer("a"), "b", answer("c"), "d"}}
	if capture, err := CaptureFrom(context.Background(), moving, "/p"); err != nil || !capture.Drift || moving.frames != 2 {
		t.Errorf("kept moving: drift %v, %d frames, %v", capture.Drift, moving.frames, err)
	}
	// A hit map that does not hold leaves the capture without one.
	broken := &fakePage{answers: []string{strings.Replace(answer("a"), `"step":8`, `"step":9`, 1), "a"}}
	if capture, err := CaptureFrom(context.Background(), broken, "/p"); err != nil || capture.Hits != nil {
		t.Errorf("broken hits: %+v, %v; want a capture without hits", capture.Hits, err)
	}
	for _, fail := range []string{"eval", "frame"} {
		if _, err := CaptureFrom(context.Background(), &fakePage{answers: []string{answer("a"), "a"}, failAt: fail}, "/p"); err == nil {
			t.Errorf("failing %s: captured", fail)
		}
	}
}

func TestGuestScriptIsEmbedded(t *testing.T) {
	if !strings.Contains(Guest, "__zeroReview") || !strings.Contains(Guest, "capture") || !strings.Contains(Guest, "signature") {
		t.Error("the guest script is missing its API")
	}
}
