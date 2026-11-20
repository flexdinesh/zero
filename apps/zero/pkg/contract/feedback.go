package contract

// FeedbackAuthor names who wrote a feedback message (decision 0120).
type FeedbackAuthor string

const (
	FeedbackAuthorUser  FeedbackAuthor = "user"
	FeedbackAuthorAgent FeedbackAuthor = "agent"
)

// FeedbackStatus is a thread's state: open until resolved or declined.
type FeedbackStatus string

const (
	FeedbackStatusOpen     FeedbackStatus = "open"
	FeedbackStatusResolved FeedbackStatus = "resolved"
	FeedbackStatusWontfix  FeedbackStatus = "wontfix"
)

// FeedbackSide names which side's lines a thread anchors to: new (the
// working tree, a compare's head) or old (a compare's base).
type FeedbackSide string

const (
	FeedbackSideNew FeedbackSide = "new"
	FeedbackSideOld FeedbackSide = "old"
)

// FeedbackAnchorState is where a thread's anchored text is now: anchored at
// its lines (the content is unchanged), moved to other lines, or outdated
// (the text is gone).
type FeedbackAnchorState string

const (
	FeedbackAnchored FeedbackAnchorState = "anchored"
	FeedbackMoved    FeedbackAnchorState = "moved"
	FeedbackOutdated FeedbackAnchorState = "outdated"
)

// FeedbackAwaiting is who a thread waits on: the agent (open, and the last
// message is the user's), the user (the last message is the agent's), or
// nobody.
type FeedbackAwaiting string

const (
	FeedbackAwaitingNone  FeedbackAwaiting = "none"
	FeedbackAwaitingAgent FeedbackAwaiting = "agent"
	FeedbackAwaitingUser  FeedbackAwaiting = "user"
)

// FeedbackCompareKind names the compare a thread was written in.
type FeedbackCompareKind string

const (
	FeedbackCompareWorking FeedbackCompareKind = "working"
	FeedbackCompareBranch  FeedbackCompareKind = "branch"
	FeedbackCompareCommit  FeedbackCompareKind = "commit"
	FeedbackCompareRange   FeedbackCompareKind = "range"
)

// FeedbackCompare names a Source Control compare as walkthroughs do: working,
// branch (Base to Head), commit (Commit against its first parent), or range
// (From's parent to To). Hashes are full.
type FeedbackCompare struct {
	Kind        FeedbackCompareKind `json:"kind"`
	Base        string              `json:"base,omitempty"`
	Head        string              `json:"head,omitempty"`
	Uncommitted bool                `json:"uncommitted"`
	Commit      string              `json:"commit,omitempty"`
	From        string              `json:"from,omitempty"`
	To          string              `json:"to,omitempty"`
}

// FeedbackAnchor is where a thread was written. Lines is an inclusive,
// 1-based [start, end], absent for a file-level thread. Text holds the
// anchored lines as written, Before and After up to three lines around them,
// and Blob the side's git blob hash then. Compare is the compare it was
// written in, absent for Source. Language is the document registry's
// highlight language for the thread's current path, "" when it has none;
// the server fills it when it answers and never stores it.
type FeedbackAnchor struct {
	Path     string           `json:"path"`
	Side     FeedbackSide     `json:"side"`
	Lines    []int            `json:"lines,omitempty"`
	Text     []string         `json:"text,omitempty"`
	Before   []string         `json:"before,omitempty"`
	After    []string         `json:"after,omitempty"`
	Blob     string           `json:"blob,omitempty"`
	Compare  *FeedbackCompare `json:"compare,omitempty"`
	Language string           `json:"language,omitempty"`
}

// FeedbackRect is a rectangle of whole pixels from a top-left origin, x
// right and y down. Inside a visual target (decision 0176) it is in
// screenshot image pixels, wholly inside the image; a page's clip is in
// frame pixels.
type FeedbackRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// FeedbackViewport is a captured page's layout viewport in CSS pixels.
// DeviceScaleFactor is the guest's zoom factor times devicePixelRatio; the
// frame is round(width × it) by round(height × it).
type FeedbackViewport struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
}

// FeedbackScroll is a captured page's scroll position in CSS pixels.
type FeedbackScroll struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// FeedbackLocalhost says what a loopback page URL refers to: the project's
// host (the agent can open it as written) or the reviewer's machine.
type FeedbackLocalhost string

const (
	FeedbackLocalhostProject FeedbackLocalhost = "project"
	FeedbackLocalhostViewer  FeedbackLocalhost = "viewer"
)

// FeedbackPage is the page a screenshot was captured from. URL is http or
// https as the server normalized and redacted it; Clip, in frame pixels, is
// the part of the frame kept as the image, absent when the image is the
// whole frame. Localhost is the server's, from the transport the thread
// arrived on, and absent for a host that is not loopback.
type FeedbackPage struct {
	URL       string            `json:"url"`
	Title     string            `json:"title,omitempty"`
	Viewport  FeedbackViewport  `json:"viewport"`
	Scroll    FeedbackScroll    `json:"scroll"`
	Clip      *FeedbackRect     `json:"clip,omitempty"`
	Localhost FeedbackLocalhost `json:"localhost,omitempty"`
	// ColorScheme is the scheme the page showed in, absent when the capture
	// did not say (decision 0184).
	ColorScheme FeedbackColorScheme `json:"colorScheme,omitempty"`
}

// FeedbackColorScheme is the color scheme a captured page showed in.
type FeedbackColorScheme string

const (
	FeedbackColorSchemeLight FeedbackColorScheme = "light"
	FeedbackColorSchemeDark  FeedbackColorScheme = "dark"
)

// FeedbackElementPair is one attribute or computed style of an element.
type FeedbackElementPair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// FeedbackElement is the page's own word on a visual target's element when
// it was captured: advisory, bounded, never trusted (decisions 0176, 0184).
// Box is its border box clipped to the viewport, in image pixels. Path is
// its ancestors, outermost first; Component the chain of components that
// rendered it and Source where its source is, when a framework's
// development build said; Nearby the text around it and SelectedText the
// text selected in it. Attributes never hold a field's value.
type FeedbackElement struct {
	Selector     string                `json:"selector,omitempty"`
	Tag          string                `json:"tag"`
	Role         string                `json:"role,omitempty"`
	Name         string                `json:"name,omitempty"`
	Text         string                `json:"text,omitempty"`
	Box          *FeedbackRect         `json:"box,omitempty"`
	Path         string                `json:"path,omitempty"`
	Classes      string                `json:"classes,omitempty"`
	Attributes   []FeedbackElementPair `json:"attributes,omitempty"`
	Styles       []FeedbackElementPair `json:"styles,omitempty"`
	Component    string                `json:"component,omitempty"`
	Source       string                `json:"source,omitempty"`
	Nearby       string                `json:"nearby,omitempty"`
	SelectedText string                `json:"selectedText,omitempty"`
}

// FeedbackAttachment is an image the server holds for one feedback (at-
// and ten lowercase base32 characters), PNG only. Path is its absolute
// file path, filled only by the CLI; HTTP never sends host paths.
type FeedbackAttachment struct {
	ID        string `json:"id"`
	MediaType string `json:"mediaType"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Bytes     int    `json:"bytes"`
	SHA256    string `json:"sha256"`
	Path      string `json:"path,omitempty"`
}

// FeedbackUpload is POST /api/feedback-attachments: an image staged for the
// project's repository until ExpiresAt (an RFC 3339 time) or a thread takes
// it.
type FeedbackUpload struct {
	ID        string `json:"id"`
	MediaType string `json:"mediaType"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Bytes     int    `json:"bytes"`
	SHA256    string `json:"sha256"`
	ExpiresAt string `json:"expiresAt"`
}

// FeedbackVisual is a visual thread's target (decision 0176): one
// screenshot, one rectangle on it, and optionally the page and an element
// hint. Head is the project's HEAD commit when the thread was created,
// absent without git. Available is false once the screenshot is gone.
type FeedbackVisual struct {
	Attachment FeedbackAttachment `json:"attachment"`
	Rect       FeedbackRect       `json:"rect"`
	Page       *FeedbackPage      `json:"page,omitempty"`
	Element    *FeedbackElement   `json:"element,omitempty"`
	Head       string             `json:"head,omitempty"`
	Available  bool               `json:"available"`
}

// FeedbackLocation is a thread's anchor resolved against what a request
// views: a compare's sides, or else the working tree (new side) and the
// thread's own compare (old side). Path follows renames; Lines is absent for
// a file-level thread and for an outdated one.
type FeedbackLocation struct {
	State FeedbackAnchorState `json:"state"`
	Path  string              `json:"path"`
	Side  FeedbackSide        `json:"side"`
	Lines []int               `json:"lines,omitempty"`
}

// FeedbackMessage is one message of a thread. Number counts from 1 within
// the thread. Name is the agent's own name, when it gave one. Status is the
// status this message set, absent when it set none.
type FeedbackMessage struct {
	Number   int            `json:"number"`
	Author   FeedbackAuthor `json:"author"`
	Name     string         `json:"name,omitempty"`
	Body     string         `json:"body"`
	BodyHTML string         `json:"bodyHTML"`
	Status   FeedbackStatus `json:"status,omitempty"`
	// CreatedAt is an RFC 3339 time.
	CreatedAt string `json:"createdAt"`
}

// FeedbackThread is one conversation at an anchor: code (Anchor and its
// Location) or visual (decision 0176), never both. Number counts from 1
// within the feedback and never repeats.
//
//contract:rule anchor == null => visual != null
//contract:rule anchor != null => visual == null
//contract:rule anchor == null => location == null
//contract:rule anchor != null => location != null
type FeedbackThread struct {
	Number   int               `json:"number"`
	Status   FeedbackStatus    `json:"status"`
	Awaiting FeedbackAwaiting  `json:"awaiting"`
	Anchor   *FeedbackAnchor   `json:"anchor,omitempty"`
	Location *FeedbackLocation `json:"location,omitempty"`
	Visual   *FeedbackVisual   `json:"visual,omitempty"`
	Messages []FeedbackMessage `json:"messages"`
	// CreatedAt is an RFC 3339 time.
	CreatedAt string `json:"createdAt"`
	// UpdatedAt is an RFC 3339 time.
	UpdatedAt string `json:"updatedAt"`
}

// Feedback is GET /api/feedback: a branch's threads, oldest first. ID is
// stable for the repository and branch (fb- and six base32 characters);
// Branch is "" for a detached HEAD.
type Feedback struct {
	ID      string           `json:"id"`
	Project string           `json:"project"`
	Branch  string           `json:"branch"`
	Threads []FeedbackThread `json:"threads"`
	// CreatedAt is an RFC 3339 time.
	CreatedAt string `json:"createdAt"`
	// UpdatedAt is an RFC 3339 time.
	UpdatedAt string `json:"updatedAt"`
}

// FeedbackSummary lists one branch's feedback, GET /api/feedback-list (an
// array, most recently updated first).
type FeedbackSummary struct {
	ID            string `json:"id"`
	Branch        string `json:"branch"`
	Threads       int    `json:"threads"`
	Open          int    `json:"open"`
	AwaitingAgent int    `json:"awaitingAgent"`
	AwaitingUser  int    `json:"awaitingUser"`
	// UpdatedAt is an RFC 3339 time.
	UpdatedAt string `json:"updatedAt"`
}

// FeedbackEvent is the project stream's and the control stream's
// "feedback": a branch's feedback changed. Author wrote the change.
type FeedbackEvent struct {
	Project string         `json:"project"`
	ID      string         `json:"id"`
	Branch  string         `json:"branch"`
	Author  FeedbackAuthor `json:"author"`
	// UpdatedAt is an RFC 3339 time.
	UpdatedAt string `json:"updatedAt"`
}
