package feedback

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func visualDir() string {
	return filepath.Join("..", "..", "..", "..", "testdata", "feedback", "visual")
}

func TestStoredVisualFixtureRoundTrips(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(visualDir(), "stored.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored Feedback
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if code, visual := stored.Threads[0], stored.Threads[1]; code.Anchor == nil || code.Visual != nil || visual.Anchor != nil || visual.Visual == nil || visual.Visual.Page.Localhost != LocalhostViewer {
		t.Fatalf("decoded threads = %+v", stored.Threads)
	}
	// The store writes it compact; field order and values are what matter.
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(stored); err != nil {
		t.Fatal(err)
	}
	if encoded, want := bytes.TrimSpace(out.Bytes()), bytes.TrimSpace(data); !bytes.Equal(encoded, want) {
		t.Errorf("stored.json round trip =\n%s\nwant\n%s", encoded, want)
	}
}

func TestNormalizeURL(t *testing.T) {
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"
	for _, test := range []struct {
		raw, want, problem string
	}{
		{"http://admin:hunter2@localhost:5173/settings?tab=billing&session=8f2c1e9a7b#plan", "http://localhost:5173/settings?tab=billing&session=REDACTED#plan", ""},
		{"HTTPS://example.com/a?Token=1&API_KEY=2&apikey=3&x=4", "https://example.com/a?Token=REDACTED&API_KEY=REDACTED&apikey=REDACTED&x=4", ""},
		{"https://bucket.s3.amazonaws.com/k?X-Amz-Signature=abc&x-amz-credential=def&X-Amz-Expires=60", "https://bucket.s3.amazonaws.com/k?X-Amz-Signature=REDACTED&x-amz-credential=REDACTED&X-Amz-Expires=REDACTED", ""},
		{"https://app.test/cb#access_token=abc&token_type=bearer&state=s", "https://app.test/cb#access_token=REDACTED&token_type=bearer&state=s", ""},
		{"https://app.test/reset/" + jwt + "/done?next=" + jwt + "&" + jwt, "https://app.test/reset/REDACTED/done?next=REDACTED&REDACTED", ""},
		{"https://app.test/?code=1&pass=2&pwd=3&auth=4&authorization=5&sessionid=6&sid=7&sig=8&signature=9&jwt=10&otp=11&secret=12&client_secret=13&password=14&id_token=15&refresh_token=16&key=17", "https://app.test/?code=REDACTED&pass=REDACTED&pwd=REDACTED&auth=REDACTED&authorization=REDACTED&sessionid=REDACTED&sid=REDACTED&sig=REDACTED&signature=REDACTED&jwt=REDACTED&otp=REDACTED&secret=REDACTED&client_secret=REDACTED&password=REDACTED&id_token=REDACTED&refresh_token=REDACTED&key=REDACTED", ""},
		{"http://[::1]:3000/", "http://[::1]:3000/", ""},
		{"http://localhost:3000", "http://localhost:3000", ""},
		{"ftp://example.com/", "", "must be an http or https URL"},
		{"file:///etc/passwd", "", "must be an http or https URL"},
		{"javascript:alert(1)", "", "must be an http or https URL"},
		{"http:example.com", "", "must name a host"},
		{"http://bad host/", "", "is not a URL"},
	} {
		got, problem := NormalizeURL(test.raw)
		if got != test.want || problem != test.problem {
			t.Errorf("NormalizeURL(%q) = %q, %q; want %q, %q", test.raw, got, problem, test.want, test.problem)
		}
	}
}

func TestIsLoopbackURL(t *testing.T) {
	for raw, want := range map[string]bool{
		"http://localhost:5173/":     true,
		"http://LOCALHOST./":         true,
		"http://app.localhost:3000/": true,
		"http://127.0.0.1/":          true,
		"http://127.4.5.6:8080/":     true,
		"http://[::1]:3000/":         true,
		"http://128.0.0.1/":          false,
		"http://localhost.example/":  false,
		"https://example.com/":       false,
		"http://[::2]/":              false,
		"http://192.168.1.2:5173/":   false,
	} {
		if got := IsLoopbackURL(raw); got != want {
			t.Errorf("IsLoopbackURL(%q) = %v, want %v", raw, got, want)
		}
	}
}

func validVisual() *VisualDraft {
	return &VisualDraft{
		Attachment: "at-7hq2mx4kpa",
		Rect:       Rect{X: 96, Y: 96, Width: 420, Height: 96},
		Page: &Page{
			URL: "http://localhost:5173/settings", Title: "Settings",
			Viewport: Viewport{Width: 1440, Height: 900, DeviceScaleFactor: 2},
			Clip:     &Rect{X: 1114, Y: 544, Width: 612, Height: 288},
		},
		Element: &Element{Selector: "main button", Tag: "button", Name: "Save", Box: &Rect{X: 96, Y: 96, Width: 420, Height: 96}},
	}
}

func TestVisualDraftNormalize(t *testing.T) {
	draft := ThreadDraft{Project: "/p", Body: "b", Author: AuthorUser, Visual: validVisual()}
	draft.Visual.Page.URL = " http://u:p@localhost:5173/settings?token=x "
	draft.Visual.Page.Localhost = LocalhostProject
	got, err := draft.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if got.Visual.Page.URL != "http://localhost:5173/settings?token=REDACTED" || got.Visual.Page.Localhost != "" || got.Side != "" {
		t.Errorf("normalized visual = %+v, side %q", got.Visual.Page, got.Side)
	}
	if problems := CheckVisualImage(*got.Visual, &Attachment{Width: 612, Height: 288}, true); problems != nil {
		t.Errorf("CheckVisualImage within 1 px = %v", problems)
	}
	if problems := CheckVisualImage(*got.Visual, &Attachment{Width: 613, Height: 287}, true); problems != nil {
		t.Errorf("CheckVisualImage 1 px off = %v", problems)
	}
	pasted := VisualDraft{Attachment: "at-q3v6ne2wjd", Rect: Rect{X: 300, Y: 200, Width: 240, Height: 60}}
	if problems := CheckVisualImage(pasted, &Attachment{Width: 1280, Height: 720}, true); problems != nil {
		t.Errorf("CheckVisualImage of a paste = %v", problems)
	}
	frame := *validVisual()
	frame.Page.Clip = nil
	if problems := CheckVisualImage(frame, &Attachment{Width: 2880, Height: 1800}, true); problems != nil {
		t.Errorf("CheckVisualImage of a whole frame = %v", problems)
	}
	if got := CheckVisualImage(frame, &Attachment{Width: 612, Height: 288}, true).Error(); got != "invalid feedback: visual.page.viewport: makes a 2880×1800 frame at 2×, but the image is 612×288; send the kept part as clip" {
		t.Errorf("CheckVisualImage of a clip sent as the frame = %s", got)
	}
}

func TestVisualDraftReportsEveryProblem(t *testing.T) {
	visual := validVisual()
	visual.Attachment = "at-NOPE"
	visual.Rect = Rect{X: -1, Y: 0, Width: 0, Height: 5}
	visual.Page.URL = "ftp://example.com/"
	visual.Page.Title = "two\nlines"
	visual.Page.Clip = &Rect{X: 2800, Y: 0, Width: 100, Height: 10}
	visual.Element.Tag = "Button"
	visual.Element.Selector = strings.Repeat("a", MaxSelectorBytes+1)
	visual.Element.Name = strings.Repeat("é", MaxElementTextLength+1)
	draft := ThreadDraft{Project: "/p", Path: "a.go", Side: SideNew, Lines: []int{1, 1}, Compare: &Compare{Kind: CompareWorking}, Body: "b", Author: AuthorUser, Visual: visual}
	_, err := draft.Normalize()
	want := "invalid feedback: " +
		"compare: " + excludedByVisual + "; path: " + excludedByVisual + "; side: " + excludedByVisual + "; lines: " + excludedByVisual + "; " +
		"visual.attachment: must be at- and ten lowercase letters or digits, such as at-7hq2mx4kpa; " +
		"visual.rect: -1,0 0×5 starts before the origin: x and y must be 0 or more; " +
		"visual.rect: -1,0 0×5 is empty: width and height must be at least 1; " +
		"visual.page.url: must be an http or https URL; " +
		"visual.page.title: must be one line of at most 256 characters; " +
		"visual.page.clip: 2800,0 100×10 ends at x 2900, past the frame's width 2880; " +
		"visual.element.selector: must be one line of at most 512 bytes; " +
		"visual.element.tag: must be a lowercase tag name of at most 32 bytes, such as button; " +
		"visual.element.name: must be one line of at most 256 characters"
	if err == nil || err.Error() != want {
		t.Errorf("Normalize =\n%v\nwant\n%s", err, want)
	}

	orphan := validVisual()
	orphan.Page = nil
	if _, err := (ThreadDraft{Project: "/p", Body: "b", Author: AuthorUser, Visual: orphan}).Normalize(); err == nil || err.Error() != "invalid feedback: visual.element: needs page: only a captured page has elements" {
		t.Errorf("element without page = %v", err)
	}
	long := validVisual()
	long.Page.URL = "https://example.com/" + strings.Repeat("a", MaxURLBytes)
	if _, err := (ThreadDraft{Project: "/p", Body: "b", Author: AuthorUser, Visual: long}).Normalize(); err == nil || !strings.Contains(err.Error(), "visual.page.url: is 2068 bytes after redaction; the most is 2048") {
		t.Errorf("long URL = %v", err)
	}
}

// TestVisualProblemsFixture builds problems.json's draft: a path beside
// visual, an expired upload of 612×288, and a rectangle, clip, and box that
// do not fit it.
func TestVisualProblemsFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(visualDir(), "problems.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ Error, Code string }
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	visual := validVisual()
	visual.Rect = Rect{X: 96, Y: 96, Width: 420, Height: 240}
	visual.Page.Clip = &Rect{X: 1114, Y: 544, Width: 600, Height: 288}
	visual.Element.Box = &Rect{X: 96, Y: 96, Width: 420, Height: 240}
	draft, err := ThreadDraft{Project: "/p", Path: "code/main.go", Body: "b", Author: AuthorUser, Visual: visual}.Normalize()
	problems, ok := err.(Problems)
	if !ok {
		t.Fatalf("Normalize = %v, want Problems", err)
	}
	problems = append(problems, CheckVisualImage(*draft.Visual, &Attachment{Width: 612, Height: 288}, false)...)
	if problems.Error() != fixture.Error {
		t.Errorf("problems =\n%s\nwant problems.json\n%s", problems.Error(), fixture.Error)
	}
}

// Decision 0184: a pick carries more of its element, each part bounded; a
// selector is no longer required, and a field's value never arrives.
func TestVisualDraftElementFacts(t *testing.T) {
	problemsOf := func(change func(*VisualDraft)) string {
		draft := ThreadDraft{Project: "/p", Body: "b", Author: AuthorUser, Visual: validVisual()}
		change(draft.Visual)
		_, err := draft.Normalize()
		if err == nil {
			return ""
		}
		return err.Error()
	}
	full := func(visual *VisualDraft) {
		visual.Page.ColorScheme = ColorSchemeDark
		visual.Element.Selector = ""
		visual.Element.Path = " main › form.settings › button "
		visual.Element.Classes = "btn btn-primary"
		visual.Element.Attributes = []ElementPair{{Name: "type", Value: "submit"}, {Name: "data-testid", Value: "save"}}
		visual.Element.Styles = []ElementPair{{Name: "background-color", Value: "rgb(50, 93, 200)"}}
		visual.Element.Component = "SettingsForm › Button"
		visual.Element.Source = "src/settings/SettingsForm.tsx:42"
		visual.Element.Nearby = "Cancel"
		visual.Element.SelectedText = "Save"
	}
	if got := problemsOf(full); got != "" {
		t.Errorf("a full element = %s", got)
	}
	draft := ThreadDraft{Project: "/p", Body: "b", Author: AuthorUser, Visual: validVisual()}
	full(draft.Visual)
	normalized, err := draft.Normalize()
	if err != nil || normalized.Visual.Element.Path != "main › form.settings › button" {
		t.Errorf("normalized path = %+v, %v", normalized.Visual, err)
	}

	many := make([]ElementPair, MaxStyles+1)
	for index := range many {
		many[index] = ElementPair{Name: "color", Value: "red"}
	}
	for name, test := range map[string]struct {
		change func(*VisualDraft)
		want   string
	}{
		"a scheme that is none": {func(v *VisualDraft) { v.Page.ColorScheme = "sepia" }, "visual.page.colorScheme: must be light or dark"},
		"a field's value":       {func(v *VisualDraft) { v.Element.Attributes = []ElementPair{{Name: "value", Value: "hunter2"}} }, "visual.element.attributes[0].name: is value, which is never captured"},
		"an attribute's name":   {func(v *VisualDraft) { v.Element.Attributes = []ElementPair{{Name: "onClick", Value: "x"}} }, "visual.element.attributes[0].name: must be a lowercase name of at most 64 bytes, such as aria-label"},
		"too many attributes": {func(v *VisualDraft) {
			v.Element.Attributes = many[:MaxAttributes+1]
		}, "visual.element.attributes: has 9 entries; the most is 8"},
		"too many styles": {func(v *VisualDraft) { v.Element.Styles = many }, "visual.element.styles: has 25 entries; the most is 24"},
		"a long style": {func(v *VisualDraft) {
			v.Element.Styles = []ElementPair{{Name: "font-family", Value: strings.Repeat("a", MaxStyleValueLength+1)}}
		}, "visual.element.styles[0].value: must be one line of at most 128 characters"},
		"a path of two lines":  {func(v *VisualDraft) { v.Element.Path = "main\nbutton" }, "visual.element.path: must be one line of at most 512 bytes"},
		"a long source":        {func(v *VisualDraft) { v.Element.Source = strings.Repeat("a", MaxSourceBytes+1) }, "visual.element.source: must be one line of at most 512 bytes"},
		"long selected text":   {func(v *VisualDraft) { v.Element.SelectedText = strings.Repeat("é", MaxElementTextLength+1) }, "visual.element.selectedText: must be one line of at most 256 characters"},
		"a long component":     {func(v *VisualDraft) { v.Element.Component = strings.Repeat("A", MaxComponentLength+1) }, "visual.element.component: must be one line of at most 256 characters"},
		"long classes":         {func(v *VisualDraft) { v.Element.Classes = strings.Repeat("a", MaxClassesBytes+1) }, "visual.element.classes: must be one line of at most 256 bytes"},
		"long text nearby":     {func(v *VisualDraft) { v.Element.Nearby = strings.Repeat("a", MaxElementTextLength+1) }, "visual.element.nearby: must be one line of at most 256 characters"},
		"a long selector":      {func(v *VisualDraft) { v.Element.Selector = strings.Repeat("a", MaxSelectorBytes+1) }, "visual.element.selector: must be one line of at most 512 bytes"},
		"a tag that is no tag": {func(v *VisualDraft) { v.Element.Tag = "" }, "visual.element.tag: must be a lowercase tag name of at most 32 bytes, such as button"},
	} {
		if got := problemsOf(test.change); !strings.Contains(got, test.want) {
			t.Errorf("%s: problems = %q, want %q", name, got, test.want)
		}
	}
}
