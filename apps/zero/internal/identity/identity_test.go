package identity

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct {
		raw, want string
	}{
		{"git@github.com:flexdinesh/zero.git", "github.com/flexdinesh/zero"},
		{"git@github.com:flexdinesh/zero", "github.com/flexdinesh/zero"},
		{"https://github.com/flexdinesh/zero.git", "github.com/flexdinesh/zero"},
		{"https://github.com/flexdinesh/zero/", "github.com/flexdinesh/zero"},
		{"https://user:ghp_secret@github.com/flexdinesh/zero.git", "github.com/flexdinesh/zero"},
		{"ssh://git@github.com:22/flexdinesh/zero.git", "github.com/flexdinesh/zero"},
		{"git+ssh://git@github.com/flexdinesh/zero", "github.com/flexdinesh/zero"},
		{"git://github.com/flexdinesh/zero.git", "github.com/flexdinesh/zero"},
		{"HTTPS://GitHub.com/FlexDinesh/Zero", "github.com/flexdinesh/zero"},
		{"https://gitlab.example.com:8443/group/sub/project.git?x=1#y", "gitlab.example.com/group/sub/project"},
		{"git@gitlab.com:/group//project.git", "gitlab.com/group/project"},
		{"github.com/flexdinesh/zero", "github.com/flexdinesh/zero"},
		{"  github.com/FlexDinesh/zero.git  ", "github.com/flexdinesh/zero"},
		{"localhost/team/repo", "localhost/team/repo"},
	}
	for _, c := range cases {
		got, ok := Normalize(c.raw)
		if !ok || got != c.want {
			t.Errorf("Normalize(%q) = %q, %v; want %q", c.raw, got, ok, c.want)
		}
	}
}

func TestNormalizeRejectsLocalAndMalformed(t *testing.T) {
	for _, raw := range []string{
		"", "   ", "/srv/git/zero.git", "./zero", "../zero", "~/zero", "file:///srv/git/zero.git",
		`C:\repos\zero`, "C:/repos/zero", "owner/repo", "zero", "https://github.com/", "https://github.com/a/../b",
		"git@github.com:", "ftp://example.com/a/b", "github.com/a b", "https:///path/only",
	} {
		if got, ok := Normalize(raw); ok {
			t.Errorf("Normalize(%q) = %q; want no identity", raw, got)
		}
	}
}

func TestChoose(t *testing.T) {
	cases := []struct {
		name    string
		remotes map[string]string
		want    string
	}{
		{"upstream over origin", map[string]string{"origin": "git@github.com:me/zero.git", "upstream": "https://github.com/flexdinesh/zero"}, "github.com/flexdinesh/zero"},
		{"origin", map[string]string{"origin": "git@github.com:me/zero.git", "backup": "https://example.com/zero"}, "github.com/me/zero"},
		{"only remote", map[string]string{"gh": "git@github.com:me/zero.git"}, "github.com/me/zero"},
		{"local upstream passes to origin", map[string]string{"upstream": "../zero", "origin": "git@github.com:me/zero.git"}, "github.com/me/zero"},
		{"two other remotes", map[string]string{"a": "git@github.com:a/zero.git", "b": "git@github.com:b/zero.git"}, ""},
		{"none", map[string]string{}, ""},
		{"local only", map[string]string{"origin": "/srv/zero.git"}, ""},
	}
	for _, c := range cases {
		got, ok := Choose(c.remotes)
		if got != c.want || ok != (c.want != "") {
			t.Errorf("%s: Choose = %q, %v; want %q", c.name, got, ok, c.want)
		}
	}
}
