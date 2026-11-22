package viewed

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const blobA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const blobB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestStoreKeepsMarksAcrossOpens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "viewed.json")
	store := Open(path)
	if err := store.Set("github.com/me/zero", [][2]string{{"a.go", blobA}, {"b.go", blobB}, {"a.go", blobB}}); err != nil {
		t.Fatal(err)
	}
	reopened := Open(path)
	if got, want := reopened.Get("github.com/me/zero"), map[string]string{"a.go": blobB, "b.go": blobB}; !reflect.DeepEqual(got, want) {
		t.Errorf("Get = %v, want %v", got, want)
	}
	if got := reopened.Get("github.com/me/other"); len(got) != 0 {
		t.Errorf("Get(unknown) = %v", got)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("stat = %v, %v; want 0600", info, err)
	}
	// No files forget the identity.
	if err := store.Set("github.com/me/zero", nil); err != nil {
		t.Fatal(err)
	}
	if got := Open(path).Get("github.com/me/zero"); len(got) != 0 {
		t.Errorf("after forgetting = %v", got)
	}
}

func TestStoreDropsWhatIsNotValid(t *testing.T) {
	store := Open("")
	_ = store.Set("GitHub.com/Me/Zero", [][2]string{{"a.go", blobA}})
	_ = store.Set("not an identity", [][2]string{{"a.go", blobA}})
	_ = store.Set("github.com/me/zero", [][2]string{{"/etc/passwd", blobA}, {"", blobA}, {"a.go", "short"}, {"__proto__", blobA}, {"ok.go", blobA}})
	if got := store.Get("github.com/me/zero"); !reflect.DeepEqual(got, map[string]string{"ok.go": blobA}) {
		t.Errorf("Get = %v", got)
	}
	if len(store.entries) != 1 {
		t.Errorf("entries = %+v", store.entries)
	}

	path := filepath.Join(t.TempDir(), "viewed.json")
	if err := os.WriteFile(path, []byte(`[{"identity":"Bad Identity","files":[["a.go","`+blobA+`"]]},{"identity":"github.com/me/zero","files":[["a.go","nope"],["b.go","`+blobB+`"]]}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := Open(path).Get("github.com/me/zero"); !reflect.DeepEqual(got, map[string]string{"b.go": blobB}) {
		t.Errorf("Open dropped wrongly: %v", got)
	}
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := Open(path).Get("github.com/me/zero"); len(got) != 0 {
		t.Errorf("Open(garbage) = %v", got)
	}
}

func TestStoreBoundsIdentitiesAndFiles(t *testing.T) {
	store := Open("")
	for i := range MaxIdentities + 2 {
		_ = store.Set(fmt.Sprintf("github.com/me/repo%d", i), [][2]string{{"a.go", blobA}})
	}
	if len(store.entries) != MaxIdentities || len(store.Get("github.com/me/repo0")) != 0 || len(store.Get(fmt.Sprintf("github.com/me/repo%d", MaxIdentities+1))) != 1 {
		t.Errorf("identities = %d", len(store.entries))
	}
	files := make([][2]string, 0, MaxFiles+5)
	for i := range MaxFiles + 5 {
		files = append(files, [2]string{fmt.Sprintf("f%d.go", i), blobA})
	}
	_ = store.Set("github.com/me/big", files)
	got := store.Get("github.com/me/big")
	if len(got) != MaxFiles || got["f0.go"] != "" || got[fmt.Sprintf("f%d.go", MaxFiles+4)] != blobA {
		t.Errorf("files = %d", len(got))
	}
}

func TestIsIdentity(t *testing.T) {
	for identity, want := range map[string]bool{
		"github.com/me/zero": true, "localhost/team/repo": true, "gitlab.example.com/a/b/c": true,
		"github.com": false, "GitHub.com/me/zero": false, "github.com/me zero": false, "": false,
		"github.com/" + strings.Repeat("x", MaxIdentity): false,
	} {
		if got := IsIdentity(identity); got != want {
			t.Errorf("IsIdentity(%q) = %v, want %v", identity, got, want)
		}
	}
}
