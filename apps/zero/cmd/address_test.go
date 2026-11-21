package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{"localhost": true, "LOCALHOST": true, "127.0.0.1": true, "127.1.2.3": true, "::1": true, "10.0.0.5": false, "0.0.0.0": false, "::": false} {
		if got := loopbackHost(host); got != want {
			t.Errorf("loopbackHost(%q) = %t, want %t", host, got, want)
		}
	}
}

// Every URL the CLI opens names its project, so the page skips choosing one
// (decision 0153).
func TestProjectURLNamesTheProject(t *testing.T) {
	base := serverURL("127.0.0.1", 7971)
	if got, want := projectURL(base, "/home/dee/my project"), "http://127.0.0.1:7971/?project=%2Fhome%2Fdee%2Fmy+project"; got != want {
		t.Errorf("projectURL() = %q, want %q", got, want)
	}
	if got := projectURL(base, ""); got != base {
		t.Errorf("projectURL(no project) = %q, want %q", got, base)
	}
}

// Links that leave this machine name the repository too, so they open where
// it lives at another path (decision 0188).
func TestWithRepoNamesTheRepository(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "zero")
	folder := filepath.Join(root, "notes")
	for _, dir := range []string{filepath.Join(repo, ".git"), folder} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	config := "[remote \"origin\"]\n\turl = git@github.com:flexdinesh/zero.git\n"
	for name, content := range map[string]string{"HEAD": "ref: refs/heads/main\n", "config": config} {
		if err := os.WriteFile(filepath.Join(repo, ".git", name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	base := serverURL("127.0.0.1", 7971)
	if got, want := withRepo(projectURL(base, repo), repo), projectURL(base, repo)+"&repo=github.com%2Fflexdinesh%2Fzero"; got != want {
		t.Errorf("withRepo(repo) = %q, want %q", got, want)
	}
	if got, want := withRepo(projectURL(base, folder), folder), projectURL(base, folder); got != want {
		t.Errorf("withRepo(folder) = %q, want %q", got, want)
	}
	if got := withRepo(base, ""); got != base {
		t.Errorf("withRepo(no project) = %q", got)
	}
	if got, want := withIdentity("zero://local/", "github.com/o/r"), "zero://local/?repo=github.com%2Fo%2Fr"; got != want {
		t.Errorf("withIdentity = %q, want %q", got, want)
	}
}

func TestHyperlinkFramesOnlyTerminals(t *testing.T) {
	const link = "zero://r-0123456789ab/"
	if got := hyperlink(link, false); got != link {
		t.Errorf("hyperlink(tty=false) = %q", got)
	}
	if got, want := hyperlink(link, true), "\x1b]8;;"+link+"\x1b\\"+link+"\x1b]8;;\x1b\\"; got != want {
		t.Errorf("hyperlink(tty=true) = %q, want %q", got, want)
	}
}
