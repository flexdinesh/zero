package experimental

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolve(t *testing.T) {
	cases := []struct {
		name       string
		stamp, env string
		stored     bool
		want       State
	}{
		{"nothing set", "", "", false, State{}},
		{"stored choice", "", "", true, State{Enabled: true, Source: SourceSetting}},
		{"environment on", "", "1", false, State{Enabled: true, Source: SourceEnv}},
		{"environment on over a stored choice", "", "1", true, State{Enabled: true, Source: SourceEnv}},
		{"development build", "1", "", false, State{Enabled: true, Source: SourceBuild}},
		{"development build over the environment's on", "1", "1", true, State{Enabled: true, Source: SourceBuild}},
		{"environment off over a development build", "1", "0", true, State{Source: SourceOff}},
		{"environment off over a stored choice", "", "0", true, State{Source: SourceOff}},
		{"other environment values decide nothing", "", "true", false, State{}},
		{"other stamps decide nothing", "yes", "", false, State{}},
	}
	for _, c := range cases {
		if got := Resolve(c.stamp, c.env, c.stored); got != c.want {
			t.Errorf("%s: Resolve(%q, %q, %v) = %+v, want %+v", c.name, c.stamp, c.env, c.stored, got, c.want)
		}
	}
}

func TestStoreRemembersTheChoice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "experimental.json")
	if Open(path).Enabled() {
		t.Fatal("a missing file is on")
	}
	store := Open(path)
	if err := store.Set(true); err != nil {
		t.Fatal(err)
	}
	if !Open(path).Enabled() {
		t.Fatal("the choice was not remembered")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
	if err := store.Set(false); err != nil {
		t.Fatal(err)
	}
	if Open(path).Enabled() {
		t.Fatal("turning it off was not remembered")
	}
}

func TestStoreReadsABrokenFileAsOff(t *testing.T) {
	path := filepath.Join(t.TempDir(), "experimental.json")
	if err := os.WriteFile(path, []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if Open(path).Enabled() {
		t.Fatal("a broken file is on")
	}
}

func TestStoreWithoutAPathKeepsTheChoiceInMemory(t *testing.T) {
	store := Open("")
	if err := store.Set(true); err != nil {
		t.Fatal(err)
	}
	if !store.Enabled() {
		t.Fatal("the choice was not kept")
	}
}
