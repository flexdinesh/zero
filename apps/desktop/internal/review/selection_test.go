package review

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const pagePart = `"page":{"title":" Settings\n· Acme ","width":1280,"height":720,"devicePixelRatio":2,"scrollX":0,"scrollY":1320.4,"colorScheme":"dark"}`

func TestParseEvent(t *testing.T) {
	for _, each := range []string{EventCancel, EventEscape, EventFocus, EventReplaced} {
		event, err := ParseEvent(`{"type":"`+each+`"}`, "http://localhost:5173/", 1)
		if err != nil || event.Type != each || event.Selection != nil {
			t.Errorf("%s = %+v, %v", each, event, err)
		}
	}
	if event, err := ParseEvent(`{"type":"pin","thread":3}`, "http://localhost:5173/", 1); err != nil || event.Type != EventPin || event.Thread != 3 {
		t.Errorf("pin = %+v, %v", event, err)
	}
	for _, raw := range []string{`{"type":"pin"}`, `{"type":"pin","thread":0}`, `{"type":"else"}`, `{}`, `nope`, `{"type":"pick"}`, strings.Repeat(" ", maxEventBytes+1)} {
		if event, err := ParseEvent(raw, "http://localhost:5173/", 1); err == nil {
			t.Errorf("ParseEvent(%.40q) = %+v", raw, event)
		}
	}
	event, err := ParseEvent(`{"type":"pick","kind":"region","rect":{"x":10,"y":20,"width":30,"height":40},`+pagePart+`}`, "http://localhost:5173/", 1)
	if err != nil || event.Type != EventPick || event.Selection == nil || event.Selection.Kind != KindRegion {
		t.Errorf("pick = %+v, %v", event, err)
	}
}

func TestParseSelection(t *testing.T) {
	raw := `{"kind":"element","canWalkUp":true,"canWalkDown":true,"rect":{"x":604.5,"y":-10,"width":210.2,"height":58},` +
		`"element":{"tag":"button","box":{"x":604.5,"y":-10,"width":210.2,"height":58},"selector":"main form > button[data-testid=\"save\"]",` +
		`"role":"button","name":" Save\nchanges ","text":"Save changes","path":"main › form.settings › button.btn","classes":"btn  btn-primary",` +
		`"attributes":[{"name":"type","value":"submit"},{"name":"value","value":"secret"},{"name":"Bad Name","value":"x"},{"name":"data-testid","value":"save"}],` +
		`"styles":[{"name":"color","value":"rgb(255, 255, 255)"}],"component":"SettingsForm › Button","source":"/repo/src/Settings.tsx:42","nearby":"Cancel","selectedText":""},` +
		pagePart + `}`
	got, err := ParseSelection(raw, "http://localhost:5173/settings?tab=billing#plan", 1.25)
	if err != nil {
		t.Fatal(err)
	}
	want := Selection{
		Kind: KindElement, Rect: Rect{X: 604, Y: 0, Width: 211, Height: 48}, CanWalkUp: true, CanWalkDown: true,
		Element: &Element{
			Tag: "button", Box: Rect{X: 604, Y: 0, Width: 211, Height: 48}, Selector: `main form > button[data-testid="save"]`,
			Role: "button", Name: "Save changes", Text: "Save changes", Path: "main › form.settings › button.btn", Classes: "btn btn-primary",
			Attributes: []Pair{{Name: "type", Value: "submit"}, {Name: "data-testid", Value: "save"}},
			Styles:     []Pair{{Name: "color", Value: "rgb(255, 255, 255)"}},
			Component:  "SettingsForm › Button", Source: "/repo/src/Settings.tsx:42", Nearby: "Cancel",
		},
		Page: Page{URL: "http://localhost:5173/settings?tab=billing#plan", Title: "Settings · Acme", Viewport: Viewport{Width: 1280, Height: 720, DeviceScaleFactor: 2.5}, Scroll: Scroll{X: 0, Y: 1320}, ColorScheme: "dark"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("selection =\n%+v\n%+v\nwant\n%+v\n%+v", got, got.Element, want, want.Element)
	}

	// What the composer reads: the capture's fields beside the pick's.
	encoded, err := json.Marshal(Capture{Project: "/repo", PNG: "AAAA", Selection: Selection{Kind: KindRegion, Rect: Rect{X: 1, Y: 2, Width: 3, Height: 4}, Page: Page{URL: "http://a.test/", ColorScheme: "light"}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := string(encoded); got != `{"project":"/repo","png":"AAAA","kind":"region","rect":{"x":1,"y":2,"width":3,"height":4},"element":null,"canWalkUp":false,"canWalkDown":false,"page":{"url":"http://a.test/","title":"","viewport":{"width":0,"height":0,"deviceScaleFactor":0},"scroll":{"x":0,"y":0},"colorScheme":"light"}}` {
		t.Errorf("capture = %s", got)
	}

	region := func(rect, element string) string {
		return `{"kind":"region","canWalkUp":true,"rect":` + rect + element + `,` + pagePart + `}`
	}
	// A region walks nowhere, needs no element, and drops one that does
	// not hold; a long selector is left out, never cut.
	got, err = ParseSelection(region(`{"x":1270,"y":700,"width":100,"height":100}`, `,"element":{"tag":"DIV","box":{"x":0,"y":0,"width":10,"height":10}}`), "https://example.com/", 0)
	if err != nil || got.Rect != (Rect{X: 1270, Y: 700, Width: 10, Height: 20}) || got.Element != nil || got.CanWalkUp || got.Page.Viewport.DeviceScaleFactor != 2 {
		t.Errorf("region = %+v, %v", got, err)
	}
	got, err = ParseSelection(region(`{"x":0,"y":0,"width":10,"height":10}`, `,"element":{"tag":"div","box":{"x":0,"y":0,"width":10,"height":10},"selector":"`+strings.Repeat("a", maxSelectorBytes+1)+`","path":"`+strings.Repeat("é", maxPathBytes)+`","role":"`+strings.Repeat("r", maxRole+1)+`"}`), "https://example.com/", 1)
	if err != nil || got.Element == nil || got.Element.Selector != "" || got.Element.Role != "" || len(got.Element.Path) > maxPathBytes || len(got.Element.Path) < maxPathBytes-1 {
		t.Errorf("bounded element = %+v, %v", got.Element, err)
	}

	for name, each := range map[string][2]string{
		"not a page":         {region(`{"x":0,"y":0,"width":10,"height":10}`, ""), "file:///etc/passwd"},
		"about":              {region(`{"x":0,"y":0,"width":10,"height":10}`, ""), "about:blank"},
		"outside":            {region(`{"x":2000,"y":0,"width":10,"height":10}`, ""), "http://a.test/"},
		"no size":            {region(`{"x":0,"y":0,"width":0,"height":10}`, ""), "http://a.test/"},
		"no rect":            {`{"kind":"region",` + pagePart + `}`, "http://a.test/"},
		"no page":            {`{"kind":"region","rect":{"x":0,"y":0,"width":10,"height":10}}`, "http://a.test/"},
		"no kind":            {`{"kind":"window","rect":{"x":0,"y":0,"width":10,"height":10},` + pagePart + `}`, "http://a.test/"},
		"element without":    {`{"kind":"element","rect":{"x":0,"y":0,"width":10,"height":10},` + pagePart + `}`, "http://a.test/"},
		"viewport too large": {`{"kind":"region","rect":{"x":0,"y":0,"width":10,"height":10},"page":{"width":20000,"height":720,"devicePixelRatio":1,"scrollX":0,"scrollY":0}}`, "http://a.test/"},
		"no ratio":           {`{"kind":"region","rect":{"x":0,"y":0,"width":10,"height":10},"page":{"width":1280,"height":720,"devicePixelRatio":0,"scrollX":0,"scrollY":0}}`, "http://a.test/"},
	} {
		if got, err := ParseSelection(each[0], each[1], 1); err == nil {
			t.Errorf("%s: selection = %+v", name, got)
		}
	}
}

func TestPlaceComposer(t *testing.T) {
	guest := Frame{X: 300, Y: 100, Width: 900, Height: 600}
	for name, each := range map[string]struct {
		rect      Rect
		guestZoom float64
		guest     Frame
		height    float64
		appZoom   float64
		want      Frame
	}{
		"under the pick, left edges aligned": {Rect{X: 100, Y: 50, Width: 200, Height: 40}, 1, guest, 196, 1, Frame{X: 400, Y: 198, Width: 360, Height: 196}},
		"over a pick near the bottom":        {Rect{X: 100, Y: 500, Width: 200, Height: 40}, 1, guest, 196, 1, Frame{X: 400, Y: 396, Width: 360, Height: 196}},
		"kept inside the guest's right edge": {Rect{X: 800, Y: 50, Width: 90, Height: 40}, 1, guest, 196, 1, Frame{X: 832, Y: 198, Width: 360, Height: 196}},
		"kept inside the guest's left edge":  {Rect{X: 0, Y: 50, Width: 90, Height: 40}, 1, guest, 196, 1, Frame{X: 308, Y: 198, Width: 360, Height: 196}},
		"the guest's zoom moves the pick":    {Rect{X: 100, Y: 50, Width: 200, Height: 40}, 2, guest, 196, 1, Frame{X: 500, Y: 288, Width: 360, Height: 196}},
		"the app's zoom sizes the composer":  {Rect{X: 100, Y: 50, Width: 200, Height: 40}, 1, guest, 196, 1.5, Frame{X: 400, Y: 198, Width: 540, Height: 294}},
		"a pick as tall as the page":         {Rect{X: 100, Y: 0, Width: 200, Height: 600}, 1, guest, 196, 1, Frame{X: 400, Y: 516, Width: 360, Height: 196}},
		"a guest narrower than the composer": {Rect{X: 10, Y: 50, Width: 50, Height: 40}, 1, Frame{X: 1000, Y: 100, Width: 200, Height: 600}, 196, 1, Frame{X: 912, Y: 198, Width: 360, Height: 196}},
		"no zoom reads as one":               {Rect{X: 100, Y: 50, Width: 200, Height: 40}, 0, guest, 196, 0, Frame{X: 400, Y: 198, Width: 360, Height: 196}},
	} {
		if got := PlaceComposer(each.rect, each.guestZoom, each.guest, each.height, each.appZoom, 1280, 720); got != each.want {
			t.Errorf("%s: %+v, want %+v", name, got, each.want)
		}
	}
	// A window smaller than the composer still holds all of it.
	if got := PlaceComposer(Rect{X: 0, Y: 0, Width: 10, Height: 10}, 1, Frame{X: 0, Y: 0, Width: 300, Height: 150}, 196, 1, 300, 150); got != (Frame{X: 8, Y: 8, Width: 284, Height: 134}) {
		t.Errorf("small window: %+v", got)
	}
	for height, want := range map[float64]float64{0: 120, 150.2: 151, 9000: 480} {
		if got := ComposerHeightOf(height); got != want {
			t.Errorf("ComposerHeightOf(%v) = %v, want %v", height, got, want)
		}
	}
}
