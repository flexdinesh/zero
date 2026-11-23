package cmd

import (
	"context"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/pkg/contract"
)

func TestRootCommandNormalizesRepo(t *testing.T) {
	for _, args := range [][]string{
		{"--repo", "git@github.com:FlexDinesh/zero.git"},
		{"browser", "--repo", "https://github.com/flexdinesh/zero"},
		{"--repo", "github.com/flexdinesh/zero", "--remote"},
	} {
		var got options
		command := newRootCommand(func(_ context.Context, opts options, _ io.Reader, _, _ io.Writer) error {
			got = opts
			return nil
		})
		command.SetArgs(args)
		if err := command.Execute(); err != nil {
			t.Fatalf("Execute(%v): %v", args, err)
		}
		// --repo serves no path of its own: not even the default ".".
		if got.repo != "github.com/flexdinesh/zero" || len(got.paths) != 0 {
			t.Errorf("Execute(%v) repo = %q, paths = %v", args, got.repo, got.paths)
		}
	}
}

func TestRootCommandRejectsRepoWithAPathOrNoIdentity(t *testing.T) {
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"docs", "--repo", "github.com/o/r"}, "--repo and a path cannot be combined"},
		{[]string{"--path", "docs", "--repo", "github.com/o/r"}, "--repo and a path cannot be combined"},
		{[]string{"--repo", "/srv/git/r.git"}, "is not a repository identity"},
		{[]string{"--repo", "owner/repo"}, "is not a repository identity"},
		{[]string{"--repo", ""}, "is not a repository identity"},
	} {
		command := newRootCommand(func(context.Context, options, io.Reader, io.Writer, io.Writer) error {
			t.Fatalf("runner called for %v", test.args)
			return nil
		})
		command.SetArgs(test.args)
		err := command.Execute()
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("Execute(%v) error = %v, want %q", test.args, err, test.want)
		}
	}
}

func TestRootCommandWithoutRepoKeepsPaths(t *testing.T) {
	for _, test := range []struct {
		args []string
		want []string
	}{
		{nil, []string{}},
		{[]string{"."}, []string{"."}},
		{[]string{"github.com/o/r"}, []string{"github.com/o/r"}},
	} {
		var got options
		command := newRootCommand(func(_ context.Context, opts options, _ io.Reader, _, _ io.Writer) error {
			got = opts
			return nil
		})
		command.SetArgs(test.args)
		if err := command.Execute(); err != nil {
			t.Fatal(err)
		}
		if got.repo != "" || !reflect.DeepEqual(got.paths, test.want) {
			t.Errorf("Execute(%v) repo = %q, paths = %v; want paths %v", test.args, got.repo, got.paths, test.want)
		}
	}
}

func TestCheckoutsOfMatchesAvailableProjectsByIdentity(t *testing.T) {
	response := contract.ProjectsResponse{Projects: []contract.Project{
		{ID: "/work/zero", Identity: "github.com/flexdinesh/zero", Available: true},
		{ID: "/work/zero-fix", Identity: "github.com/flexdinesh/zero", Available: true},
		{ID: "", Identity: "github.com/flexdinesh/zero", Available: false},
		{ID: "/work/other", Identity: "github.com/flexdinesh/other", Available: true},
		{ID: "/work/notes", Available: true},
	}}
	if got := checkoutsOf(response, "github.com/flexdinesh/zero"); !reflect.DeepEqual(got, []string{"/work/zero", "/work/zero-fix"}) {
		t.Errorf("checkoutsOf = %v", got)
	}
	if got := checkoutsOf(response, "github.com/none/here"); got != nil {
		t.Errorf("checkoutsOf(missing) = %v", got)
	}
}

func TestRepoPathNeedsOneCheckoutOfARunningDaemon(t *testing.T) {
	lookup := func(found []string, ok bool) repoLookup {
		return func(context.Context, string) ([]string, bool) { return found, ok }
	}
	opts := options{repo: "github.com/o/r"}
	for _, test := range []struct {
		name   string
		lookup repoLookup
		want   string
		err    string
	}{
		{"one", lookup([]string{"/work/r"}, true), "/work/r", ""},
		{"no daemon", lookup(nil, false), "", "none is running"},
		{"none", lookup(nil, true), "", "serves no checkout of github.com/o/r"},
		{"several", lookup([]string{"/a/r", "/b/r"}, true), "", "serves 2 checkouts of github.com/o/r; pass one as the path:\n  /a/r\n  /b/r"},
	} {
		got, err := repoPath(context.Background(), opts, test.lookup)
		if got != test.want || (test.err == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), test.err)) {
			t.Errorf("%s: repoPath = %q, %v; want %q, %q", test.name, got, err, test.want, test.err)
		}
	}
}

func TestAppOpensRepoInDesktopAppWithoutOpeningAFolder(t *testing.T) {
	fake, deps := newAppFake()
	opts := appOptions()
	opts.repo = "github.com/flexdinesh/zero"
	stdout, _, err := runAppWith(opts, deps)
	if err != nil {
		t.Fatal(err)
	}
	want := "zero://local/?repo=github.com%2Fflexdinesh%2Fzero"
	if !reflect.DeepEqual(fake.openedURLs, []string{want}) || stdout != "opened github.com/flexdinesh/zero in zero\ndesktop: "+want+"\n" {
		t.Errorf("opened %v, stdout %q", fake.openedURLs, stdout)
	}
	if len(fake.ensured) != 1 || len(fake.openedRoots) != 0 {
		t.Errorf("fake = %+v; want the daemon ensured and no folder opened", fake)
	}
}

func TestAppResolvesRepoForTheRemoteFlow(t *testing.T) {
	fake, deps := newAppFake()
	deps.getenv = sshEnv
	deps.checkouts = func(_ context.Context, repo string) ([]string, bool) {
		if repo != "github.com/o/r" {
			t.Errorf("lookup(%q)", repo)
		}
		return []string{"/work/r"}, true
	}
	var got []options
	deps.remote = func(_ context.Context, opts options, _, _ io.Writer) error {
		got = append(got, opts)
		return nil
	}
	opts := appOptions()
	opts.remote = true
	opts.repo = "github.com/o/r"
	if _, _, err := runAppWith(opts, deps); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !reflect.DeepEqual(got[0].paths, []string{"/work/r"}) || len(fake.served) != 0 {
		t.Errorf("remote got %+v", got)
	}
}
