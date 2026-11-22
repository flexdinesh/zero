package cmd

import (
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/flexdinesh/zero/internal/projects"
)

// noUI reports whether this machine cannot show a UI to the user at its
// terminal: an SSH session, or Linux without a display.
func noUI(goos string, getenv func(string) string) bool {
	if inSSHSession(getenv) {
		return true
	}
	return goos == "linux" && getenv("DISPLAY") == "" && getenv("WAYLAND_DISPLAY") == ""
}

func inSSHSession(getenv func(string) string) bool {
	for _, name := range []string{"SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"} {
		if getenv(name) != "" {
			return true
		}
	}
	return false
}

// loopbackHost reports whether host (an IP or "localhost") only accepts
// connections from this machine.
func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// serverURL is the web URL of a server bound to host and port.
func serverURL(host string, port int) string {
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port)) + "/"
}

// projectURL is a server URL that opens project, so the page skips choosing
// one (decision 0153); an empty project leaves the choice to the page.
func projectURL(base, project string) string {
	if project == "" {
		return base
	}
	return base + "?" + url.Values{"project": {project}}.Encode()
}

// withRepo adds repo=<identity> to a link that names a project on this
// machine, so it opens the same repository on a computer that keeps it at
// another path (decision 0188); a folder, or a repository without a usable
// remote, adds nothing.
func withRepo(link, project string) string {
	if project == "" {
		return link
	}
	return withIdentity(link, projects.Identity(project))
}

// withIdentity adds repo=<identity> to a link; an empty identity adds
// nothing.
func withIdentity(link, identity string) string {
	if identity == "" {
		return link
	}
	separator := "?"
	if strings.Contains(link, "?") {
		separator = "&"
	}
	return link + separator + url.Values{"repo": {identity}}.Encode()
}

// hyperlink wraps link in an OSC 8 hyperlink when tty; the visible text is
// the plain link either way.
func hyperlink(link string, tty bool) string {
	if !tty {
		return link
	}
	return "\x1b]8;;" + link + "\x1b\\" + link + "\x1b]8;;\x1b\\"
}

// linkTerminal reports whether links written to w may be OSC 8 hyperlinks:
// w is a terminal and TERM is not dumb.
func linkTerminal(w io.Writer, getenv func(string) string) bool {
	return isTerminal(w) && getenv("TERM") != "dumb"
}

// isTerminal reports whether w is a terminal device.
func isTerminal(w io.Writer) bool {
	file, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
