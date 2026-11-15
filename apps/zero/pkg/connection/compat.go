package connection

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/flexdinesh/zero/pkg/contract"
)

// Compat is how a client's build relates to a server's (decision 0148).
type Compat int

const (
	// CompatSame: the same release, or the same development commit.
	CompatSame Compat = iota
	// CompatUnknown: a development build without a commit on either side;
	// nothing tells the builds apart.
	CompatUnknown
	// CompatServerOlder: both are releases and the server's is older.
	CompatServerOlder
	// CompatServerNewer: both are releases and the server's is newer.
	CompatServerNewer
	// CompatDifferentBuild: a development build on either side, from
	// another commit.
	CompatDifferentBuild
	// CompatIncompatible: the protocols differ; the client refuses.
	CompatIncompatible
)

// Warns reports a difference worth telling a person about.
func (c Compat) Warns() bool {
	return c == CompatServerOlder || c == CompatServerNewer || c == CompatDifferentBuild || c == CompatIncompatible
}

// Compare relates the local build to a server's RemoteInfo. Releases compare
// by version; otherwise by commit when both carry one.
func Compare(local, server contract.RemoteInfo) Compat {
	if local.Protocol != server.Protocol {
		return CompatIncompatible
	}
	l, localRelease := parseRelease(local.Version)
	s, serverRelease := parseRelease(server.Version)
	switch {
	case localRelease && serverRelease && s == l:
		return CompatSame
	case localRelease && serverRelease && s.less(l):
		return CompatServerOlder
	case localRelease && serverRelease:
		return CompatServerNewer
	case local.Commit == "" || server.Commit == "":
		return CompatUnknown
	case strings.HasPrefix(local.Commit, server.Commit) || strings.HasPrefix(server.Commit, local.Commit):
		return CompatSame
	default:
		return CompatDifferentBuild
	}
}

// VersionWarning says how the builds differ and which side to update; "" when
// they do not. cli is the local command name.
func VersionWarning(c Compat, local, server contract.RemoteInfo, cli string) string {
	if cli == "" {
		cli = "zero"
	}
	switch c {
	case CompatServerOlder:
		return fmt.Sprintf("%s runs zero %s; this computer runs %s. On %s, run `zero update`, then start `zero <path> --remote` again.", server.Name, server.Version, local.Version, server.Name)
	case CompatServerNewer:
		return fmt.Sprintf("%s runs zero %s; this computer runs %s. Run `%s update` here.", server.Name, server.Version, local.Version, cli)
	case CompatDifferentBuild:
		return fmt.Sprintf("%s runs zero %s; this computer runs %s. Install the same build on both.", server.Name, build(server), build(local))
	case CompatIncompatible:
		return fmt.Sprintf("%s runs zero %s, which speaks protocol %d; this computer runs %s, which speaks protocol %d. Install the same zero release on both.", server.Name, build(server), server.Protocol, build(local), local.Protocol)
	default:
		return ""
	}
}

func build(info contract.RemoteInfo) string {
	if info.Commit == "" {
		return info.Version
	}
	return info.Version + " (" + info.Commit + ")"
}

type release struct{ major, minor, patch int }

func (r release) less(other release) bool {
	if r.major != other.major {
		return r.major < other.major
	}
	if r.minor != other.minor {
		return r.minor < other.minor
	}
	return r.patch < other.patch
}

// parseRelease parses X.Y.Z, the only versions releases carry.
func parseRelease(version string) (release, bool) {
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return release{}, false
	}
	var numbers [3]int
	for i, part := range parts {
		if part == "" || strings.Trim(part, "0123456789") != "" || (len(part) > 1 && part[0] == '0') {
			return release{}, false
		}
		n, err := strconv.Atoi(part)
		if err != nil {
			return release{}, false
		}
		numbers[i] = n
	}
	return release{numbers[0], numbers[1], numbers[2]}, true
}
