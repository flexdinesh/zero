package review

import (
	"net/url"
	"strings"
)

// Failure kinds a guest reports (decisions 0181, 0184).
const (
	FailureLoad        = "load"
	FailureCertificate = "certificate"
	FailureRefused     = "refused"
	FailureCrashed     = "crashed"
)

// refusedDescription is what a refused navigation says.
const refusedDescription = "Only http and https pages open in the browser."

// BrowserFailure is why a guest shows no page: Kind is one of the Failure kinds, URL the page that failed (only its
// scheme and host when refused), Description one line of at most 256
// characters.
type BrowserFailure struct {
	Kind        string `json:"kind"`
	URL         string `json:"url"`
	Description string `json:"description"`
}

// BrowserState is what a window's Browser tab shows of a project's guest
// (decisions 0181, 0184). URL, Loading, CanGoBack, and CanGoForward are read
// from the page when asked; Title and Failure come from its events.
type BrowserState struct {
	URL          string          `json:"url"`
	Title        string          `json:"title"`
	Loading      bool            `json:"loading"`
	CanGoBack    bool            `json:"canGoBack"`
	CanGoForward bool            `json:"canGoForward"`
	Failure      *BrowserFailure `json:"failure"`
}

// Browsing follows a guest's load events. The zero value has no failure. It
// is not safe for concurrent use.
type Browsing struct {
	failure *BrowserFailure
	// title is the page's, one line of at most 256 characters.
	title string
	// certificate is the URL whose certificate was refused, until its load
	// fails or another starts.
	certificate string
}

// Start records an allowed navigation starting: the failure clears.
func (b *Browsing) Start() {
	b.failure = nil
	b.certificate = ""
}

// Title records the page's title.
func (b *Browsing) Title(title string) { b.title = oneLine(title, 256) }

// Refuse records a navigation to raw the guest refused; the failure names
// only its scheme and host.
func (b *Browsing) Refuse(raw string) {
	b.failure = &BrowserFailure{Kind: FailureRefused, URL: RefusedURL(raw), Description: refusedDescription}
}

// Certificate records that the certificate of raw did not verify and was
// refused; its load fails next.
func (b *Browsing) Certificate(raw, description string) {
	b.certificate = raw
	b.failure = &BrowserFailure{Kind: FailureCertificate, URL: raw, Description: describe(description, "The certificate does not verify.")}
}

// Fail records a failed load of raw. A load whose certificate was refused
// stays a certificate failure, with the certificate's words.
func (b *Browsing) Fail(raw, description string) {
	if b.certificate != "" && b.certificate == raw && b.failure != nil && b.failure.Kind == FailureCertificate {
		return
	}
	b.failure = &BrowserFailure{Kind: FailureLoad, URL: raw, Description: describe(description, "The page did not load.")}
}

// Crash records that the page's web process is gone, for reason, while it
// showed raw.
func (b *Browsing) Crash(raw, reason string) {
	b.failure = &BrowserFailure{Kind: FailureCrashed, URL: raw, Description: describe(reason, "crashed")}
}

// State is the guest's state with what the page answers now.
func (b *Browsing) State(pageURL string, loading, canGoBack, canGoForward bool) BrowserState {
	state := BrowserState{URL: pageURL, Title: b.title, Loading: loading, CanGoBack: canGoBack, CanGoForward: canGoForward}
	if b.failure != nil {
		failure := *b.failure
		state.Failure = &failure
	}
	return state
}

// RefusedURL cuts a refused URL to its scheme and host, never its path:
// "file:" for file:///etc/passwd, "zero-app://local" for an app page.
func RefusedURL(raw string) string {
	raw = strings.TrimSpace(raw)
	scheme, rest, found := strings.Cut(raw, ":")
	if !found || !isScheme(scheme) {
		return ""
	}
	scheme = strings.ToLower(scheme)
	if !strings.HasPrefix(rest, "//") {
		return scheme + ":"
	}
	host := ""
	if parsed, err := url.Parse(raw); err == nil {
		host = parsed.Host
	}
	if host == "" {
		return scheme + ":"
	}
	return oneLine(scheme+"://"+host, 256)
}

func isScheme(text string) bool {
	if text == "" || len(text) > 32 {
		return false
	}
	for index, r := range text {
		letter := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
		if !letter && (index == 0 || !(r >= '0' && r <= '9' || r == '+' || r == '-' || r == '.')) {
			return false
		}
	}
	return true
}

// describe is text as one line of at most 256 characters, or fallback when
// nothing is left.
func describe(text, fallback string) string {
	if line := oneLine(text, 256); line != "" {
		return line
	}
	return fallback
}
