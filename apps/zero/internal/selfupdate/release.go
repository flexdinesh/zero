package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Repository is zero's GitHub repository.
const Repository = "https://github.com/flexdinesh/zero"

// rawScripts serves the install scripts at a ref.
const rawScripts = "https://raw.githubusercontent.com/flexdinesh/zero"

// Release is a stable version, X.Y.Z.
type Release struct{ Major, Minor, Patch int }

// ParseRelease parses X.Y.Z (no leading v, prerelease, or build suffix).
func ParseRelease(version string) (Release, bool) {
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return Release{}, false
	}
	var numbers [3]int
	for i, part := range parts {
		if part == "" || strings.Trim(part, "0123456789") != "" || (len(part) > 1 && part[0] == '0') {
			return Release{}, false
		}
		n, err := strconv.Atoi(part)
		if err != nil {
			return Release{}, false
		}
		numbers[i] = n
	}
	return Release{numbers[0], numbers[1], numbers[2]}, true
}

func (r Release) String() string { return fmt.Sprintf("%d.%d.%d", r.Major, r.Minor, r.Patch) }

// Less reports whether r is older than other.
func (r Release) Less(other Release) bool {
	if r.Major != other.Major {
		return r.Major < other.Major
	}
	if r.Minor != other.Minor {
		return r.Minor < other.Minor
	}
	return r.Patch < other.Patch
}

// Newer reports whether latest is a newer release than current. Either one
// not a release is never newer.
func Newer(latest, current string) bool {
	l, ok := ParseRelease(latest)
	if !ok {
		return false
	}
	c, ok := ParseRelease(current)
	return ok && c.Less(l)
}

// InstallScriptURL is install.sh at release version's tag. Tags are never
// moved, so a broken main cannot break updates.
func InstallScriptURL(version string) string {
	return rawScripts + "/v" + version + "/scripts/install.sh"
}

// Releases finds the latest release from the redirect of
// <BaseURL>/releases/latest, which is not rate limited like the API.
type Releases struct {
	// BaseURL defaults to Repository.
	BaseURL string
	// Client defaults to a client with a 10 s timeout.
	Client *http.Client
	// UserAgent is sent on every request.
	UserAgent string
}

// Latest returns the latest release's version, X.Y.Z.
func (r Releases) Latest(ctx context.Context) (string, error) {
	base := r.BaseURL
	if base == "" {
		base = Repository
	}
	client := http.Client{Timeout: 10 * time.Second}
	if r.Client != nil {
		client = *r.Client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	if r.UserAgent != "" {
		request.Header.Set("User-Agent", r.UserAgent)
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("find the latest zero release: %w", err)
	}
	_ = response.Body.Close()
	_, tag, found := strings.Cut(response.Header.Get("Location"), "/releases/tag/")
	if response.StatusCode < 300 || response.StatusCode > 399 || !found {
		return "", errors.New("find the latest zero release: no release found")
	}
	version, ok := strings.CutPrefix(tag, "v")
	if _, valid := ParseRelease(version); !ok || !valid {
		return "", fmt.Errorf("find the latest zero release: unexpected tag %q", tag)
	}
	return version, nil
}
