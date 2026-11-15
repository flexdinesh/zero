package connection

import (
	"net/url"
	"path"
	"strings"
)

// Invite is a connection string that may also name the project to open: the
// one `zero <path> --remote` started with (decision 0153). Its grammar is
//
//	<host>[,<host>...]:<port>/<credential>[<absolute path>]
//
// with each path segment percent-escaped, so the string stays one word with
// no whitespace and no character a single-quoted shell word interprets.
type Invite struct {
	Endpoint TLS
	// Project is an absolute path on the server, or empty for none.
	Project string
}

// ParseInvite reads a connection string with or without a project,
// tolerating what Parse tolerates.
func ParseInvite(text string) (Invite, error) {
	compact := strings.Trim(strings.Join(strings.Fields(text), ""), `'"`)
	address, rest, found := strings.Cut(compact, "/")
	if !found {
		return Invite{}, ErrInvalid
	}
	encoded, escaped, hasProject := strings.Cut(rest, "/")
	endpoint, err := Parse(address + "/" + encoded)
	if err != nil {
		return Invite{}, err
	}
	if !hasProject {
		return Invite{Endpoint: endpoint}, nil
	}
	project, err := unescapeProject("/" + escaped)
	if err != nil {
		return Invite{}, err
	}
	return Invite{Endpoint: endpoint, Project: project}, nil
}

func unescapeProject(escaped string) (string, error) {
	if escaped == "/" {
		return escaped, nil
	}
	segments := strings.Split(strings.TrimPrefix(escaped, "/"), "/")
	for i, segment := range segments {
		unescaped, err := url.PathUnescape(segment)
		if err != nil || unescaped == "" || strings.ContainsAny(unescaped, "/\x00") {
			return "", ErrInvalid
		}
		segments[i] = unescaped
	}
	project := "/" + strings.Join(segments, "/")
	if path.Clean(project) != project {
		return "", ErrInvalid
	}
	return project, nil
}

// Format is the invite's connection string.
func (i Invite) Format() string {
	text := i.Endpoint.Format()
	if i.Project == "" {
		return text
	}
	segments := strings.Split(strings.TrimPrefix(i.Project, "/"), "/")
	for n, segment := range segments {
		segments[n] = url.PathEscape(segment)
	}
	return text + "/" + strings.Join(segments, "/")
}

// Shell is Format as a single shell word: quoted when it names a project or
// an IPv6 host, whose brackets would otherwise glob.
func (i Invite) Shell() string {
	if i.Project == "" {
		return i.Endpoint.Shell()
	}
	return "'" + i.Format() + "'"
}

// WebURL is the browser's address, opening the project when there is one.
func (i Invite) WebURL() (string, error) {
	web, err := i.Endpoint.WebURL()
	if err != nil || i.Project == "" {
		return web, err
	}
	return web + "&" + url.Values{"project": {i.Project}}.Encode(), nil
}
