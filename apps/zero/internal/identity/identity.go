// Package identity names a repository the same way on every computer: its
// remote URL normalized to "host/path", lowercase, as in
// "github.com/flexdinesh/zero" (decision 0188). An identity names a
// repository, not a checkout; it only finds projects, which stay addressed by
// path. It is pure: no I/O.
package identity

import (
	"net/url"
	"strings"
)

// Normalize turns a git remote URL, or an identity, into an identity. It reads
// the scp form ("[user@]host:owner/repo"), ssh://, git+ssh://, git://, and
// http(s):// URLs, and "host/path" identities. It drops the user (and any
// token), port, query, fragment, ".git", and trailing slashes, and lowercases
// the result. Local paths, file:// URLs, and empty or relative paths have no
// identity.
func Normalize(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, " \t\r\n\\") {
		return "", false
	}
	host, path, ok := split(raw)
	if !ok {
		return "", false
	}
	host = strings.ToLower(host)
	if !validHost(host) {
		return "", false
	}
	segments := strings.FieldsFunc(path, func(r rune) bool { return r == '/' })
	if len(segments) == 0 {
		return "", false
	}
	last := len(segments) - 1
	segments[last] = strings.TrimSuffix(segments[last], ".git")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return "", false
		}
	}
	return host + "/" + strings.ToLower(strings.Join(segments, "/")), true
}

// split separates a remote's host from its path.
func split(raw string) (string, string, bool) {
	if scheme, rest, ok := strings.Cut(raw, "://"); ok {
		switch strings.ToLower(scheme) {
		case "ssh", "git+ssh", "git", "http", "https":
		default:
			return "", "", false
		}
		u, err := url.Parse(strings.ToLower(scheme) + "://" + rest)
		if err != nil || u.Opaque != "" {
			return "", "", false
		}
		return u.Hostname(), u.Path, true
	}
	if strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, ".") || strings.HasPrefix(raw, "~") {
		return "", "", false
	}
	colon := strings.Index(raw, ":")
	slash := strings.Index(raw, "/")
	if colon >= 0 && (slash < 0 || colon < slash) {
		// scp form: [user@]host:path. A one-letter host is a Windows drive.
		host := raw[:colon]
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
		if len(host) < 2 {
			return "", "", false
		}
		return host, raw[colon+1:], true
	}
	if slash <= 0 {
		return "", "", false
	}
	// An identity: host/path. The host must look like a domain or an address,
	// so "owner/repo" and relative paths are not identities.
	host := raw[:slash]
	if !strings.Contains(host, ".") && !strings.Contains(host, ":") && host != "localhost" {
		return "", "", false
	}
	return host, raw[slash+1:], true
}

// validHost reports whether a lowercased host is a name or an address.
func validHost(host string) bool {
	if host == "" {
		return false
	}
	for _, c := range host {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' && c != '.' && c != '_' && c != ':' && c != '[' && c != ']' {
			return false
		}
	}
	return true
}

// Choose picks the remote that names a repository: upstream, else origin,
// else the only remote; a remote without an identity (a local path) is
// passed over. Remotes maps a remote's name to its URL.
func Choose(remotes map[string]string) (string, bool) {
	for _, name := range []string{"upstream", "origin"} {
		if id, ok := Normalize(remotes[name]); ok {
			return id, true
		}
	}
	if len(remotes) != 1 {
		return "", false
	}
	for _, remote := range remotes {
		return Normalize(remote)
	}
	return "", false
}
