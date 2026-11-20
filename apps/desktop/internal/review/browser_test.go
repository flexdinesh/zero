package review

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBrowserStateJSON(t *testing.T) {
	var browsing Browsing
	raw, err := json.Marshal(browsing.State("http://localhost:5173/", true, true, false))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(raw); got != `{"url":"http://localhost:5173/","title":"","loading":true,"canGoBack":true,"canGoForward":false,"failure":null}` {
		t.Errorf("state = %s", got)
	}
	browsing.Fail("http://localhost:1/", "Could not connect: Connection refused")
	browsing.Title("  Problem\nloading page ")
	raw, _ = json.Marshal(browsing.State("http://localhost:1/", false, false, false))
	if got := string(raw); got != `{"url":"http://localhost:1/","title":"Problem loading page","loading":false,"canGoBack":false,"canGoForward":false,"failure":{"kind":"load","url":"http://localhost:1/","description":"Could not connect: Connection refused"}}` {
		t.Errorf("failed state = %s", got)
	}
}

func TestBrowsingFailures(t *testing.T) {
	failure := func(b *Browsing) *BrowserFailure { return b.State("", false, false, false).Failure }
	var b Browsing
	b.Fail("http://a.test/", "  Not\nfound\t")
	if got := failure(&b); got == nil || *got != (BrowserFailure{Kind: FailureLoad, URL: "http://a.test/", Description: "Not found"}) {
		t.Errorf("load failure = %+v", got)
	}
	b.Start()
	if got := failure(&b); got != nil {
		t.Errorf("after a start: %+v, want none", got)
	}

	b.Certificate("https://self.test/", "the certificate is not trusted")
	b.Fail("https://self.test/", "Unacceptable TLS certificate")
	if got := failure(&b); got == nil || *got != (BrowserFailure{Kind: FailureCertificate, URL: "https://self.test/", Description: "the certificate is not trusted"}) {
		t.Errorf("certificate failure = %+v", got)
	}
	b.Fail("http://other.test/", "")
	if got := failure(&b); got == nil || got.Kind != FailureLoad || got.Description != "The page did not load." {
		t.Errorf("another page's failure = %+v", got)
	}
	b.Start()
	b.Fail("https://self.test/", "Unacceptable TLS certificate")
	if got := failure(&b); got == nil || got.Kind != FailureLoad {
		t.Errorf("a start forgets the refused certificate: %+v", got)
	}

	b.Refuse("file:///home/u/secret.txt")
	if got := failure(&b); got == nil || got.Kind != FailureRefused || got.URL != "file:" || strings.Contains(got.Description, "secret") {
		t.Errorf("refused = %+v", got)
	}
	b.Crash("http://a.test/", "exceeded memory limit")
	if got := failure(&b); got == nil || *got != (BrowserFailure{Kind: FailureCrashed, URL: "http://a.test/", Description: "exceeded memory limit"}) {
		t.Errorf("crashed = %+v", got)
	}

	b.Fail("http://a.test/", strings.Repeat("long ", 100))
	if got := failure(&b); got == nil || utf8.RuneCountInString(got.Description) > 256 || !strings.HasSuffix(got.Description, "…") {
		t.Errorf("long description: %+v", got)
	}
	// The state's failure is a copy.
	state := b.State("", false, false, false)
	state.Failure.Kind = "changed"
	if failure(&b).Kind != FailureLoad {
		t.Error("the state shares its failure")
	}
}

func TestRefusedURL(t *testing.T) {
	for raw, want := range map[string]string{
		"file:///etc/passwd":                  "file:",
		"zero-app://local/view?project=/home": "zero-app://local",
		"ZERO://r-0123456789ab/":              "zero://r-0123456789ab",
		"javascript:alert(document.cookie)":   "javascript:",
		"chrome://settings/passwords":         "chrome://settings",
		"ftp://user:pw@files.test/a":          "ftp://files.test",
		"about:config":                        "about:",
		"no scheme here":                      "",
		"1http://a.test/":                     "",
	} {
		if got := RefusedURL(raw); got != want {
			t.Errorf("RefusedURL(%q) = %q, want %q", raw, got, want)
		}
	}
}
