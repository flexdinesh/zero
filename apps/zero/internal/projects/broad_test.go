package projects

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestBroadMatchesBroadFoldersExactly(t *testing.T) {
	temp := canonicalTemp(t)
	home := filepath.Join(temp, "home", "me")
	project := filepath.Join(home, "code")
	library := filepath.Join(home, "Library")
	for _, dir := range []string{project, library} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	linkedHome := filepath.Join(temp, "linked-home")
	if err := os.Symlink(home, linkedHome); err != nil {
		t.Fatal(err)
	}
	linkedRoot := filepath.Join(temp, "linked-root")
	if err := os.Symlink("/", linkedRoot); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, dir, home string
		want            bool
	}{
		{"filesystem root", "/", home, true},
		{"home", home, home, true},
		{"home with a trailing slash", home + "/", home, true},
		{"home through a symlink", linkedHome, home, true},
		{"home named by a symlink", home, linkedHome, true},
		{"home's Library", library, home, true},
		{"inside home", project, home, false},
		{"home's parent", filepath.Dir(home), home, false},
		{"no home", home, "", false},
		{"symlink to the root", linkedRoot, home, true},
		{"system folder", "/usr", home, true},
		{"inside a system folder", "/usr/local", home, false},
		{"var", "/var", home, true},
		{"etc", "/etc", home, true},
		{"missing broad folder", "/run/media", home, true},
		{"missing folder", filepath.Join(temp, "missing"), home, false},
	}
	for _, test := range cases {
		if got := broad(test.dir, test.home); got != test.want {
			t.Errorf("%s: broad(%q, %q) = %v, want %v", test.name, test.dir, test.home, got, test.want)
		}
	}
}

func TestBroadReadsTheUserHome(t *testing.T) {
	home := canonicalTemp(t)
	t.Setenv("HOME", home)
	if !Broad(home) {
		t.Errorf("Broad(%q) = false, want true for $HOME", home)
	}
	if Broad(filepath.Join(home, "code")) {
		t.Errorf("Broad below $HOME = true, want false")
	}
}

func TestBroadDepthPrefersAnExplicitScanDepth(t *testing.T) {
	if got := BroadDepth(10, false); got != BroadScanDepth {
		t.Errorf("BroadDepth(10, false) = %d, want %d", got, BroadScanDepth)
	}
	if got := BroadDepth(4, true); got != 4 {
		t.Errorf("BroadDepth(4, true) = %d, want 4", got)
	}
}

func TestDiscoverLooksShallowerInsideABroadRoot(t *testing.T) {
	temp := canonicalTemp(t)
	home := filepath.Join(temp, "home")
	other := filepath.Join(temp, "other")
	for _, root := range []string{home, other} {
		makeRepo(t, filepath.Join(root, "near"))
		makeRepo(t, filepath.Join(root, "code", "far"))
	}
	t.Setenv("HOME", home)

	shallow := Discover([]string{home, other}, 10, 1)
	want := []string{
		home, filepath.Join(home, "near"),
		other, filepath.Join(other, "code", "far"), filepath.Join(other, "near"),
	}
	if got := ids(shallow.Projects); !reflect.DeepEqual(got, want) {
		t.Errorf("default broad depth IDs = %v\nwant %v", got, want)
	}

	explicit := Discover([]string{home, other}, 10, 10)
	want = []string{
		home, filepath.Join(home, "code", "far"), filepath.Join(home, "near"),
		other, filepath.Join(other, "code", "far"), filepath.Join(other, "near"),
	}
	if got := ids(explicit.Projects); !reflect.DeepEqual(got, want) {
		t.Errorf("explicit scan depth IDs = %v\nwant %v", got, want)
	}
}
