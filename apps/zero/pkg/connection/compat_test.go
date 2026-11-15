package connection

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/pkg/contract"
)

func info(protocol int, version, commit string) contract.RemoteInfo {
	return contract.RemoteInfo{Protocol: protocol, Version: version, Commit: commit, Name: "box"}
}

func TestCompare(t *testing.T) {
	tests := []struct {
		name          string
		local, server contract.RemoteInfo
		want          Compat
	}{
		{"same release", info(1, "0.2.0", "aaa"), info(1, "0.2.0", "aaa"), CompatSame},
		{"same release, commit ignored", info(1, "0.2.0", "aaa"), info(1, "0.2.0", "bbb"), CompatSame},
		{"server older", info(1, "0.2.1", ""), info(1, "0.2.0", ""), CompatServerOlder},
		{"server older by minor", info(1, "0.10.0", ""), info(1, "0.9.9", ""), CompatServerOlder},
		{"server newer", info(1, "0.2.0", ""), info(1, "1.0.0", ""), CompatServerNewer},
		{"dev against release, other commit", info(1, "0.0.0-dev.main", "aaaaaaaaaaaa"), info(1, "0.2.0", "bbbbbbbbbbbb"), CompatDifferentBuild},
		{"dev builds, same version, other commit", info(1, "0.0.0-dev.main", "aaaaaaaaaaaa"), info(1, "0.0.0-dev.main", "bbbbbbbbbbbb"), CompatDifferentBuild},
		{"dev builds, same commit", info(1, "0.0.0-dev.main", "aaaaaaaaaaaa"), info(1, "0.0.0-dev.main", "aaaaaaaaaaaa"), CompatSame},
		{"commit prefix", info(1, "0.0.0-dev.main", "aaaaaaaaaaaa"), info(1, "0.0.0-dev.main", "aaaaaaa"), CompatSame},
		{"older server without commit", info(1, "0.0.0-dev.main", "aaaaaaaaaaaa"), info(1, "0.0.0-dev.main", ""), CompatUnknown},
		{"unstamped local build", info(1, "dev", ""), info(1, "0.2.0", "bbbbbbbbbbbb"), CompatUnknown},
		{"protocol differs", info(1, "0.2.0", ""), info(2, "0.2.0", ""), CompatIncompatible},
		{"protocol differs, dev", info(1, "dev", ""), info(2, "dev", ""), CompatIncompatible},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := Compare(test.local, test.server); got != test.want {
				t.Fatalf("Compare() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestVersionWarningNamesTheSideToUpdate(t *testing.T) {
	tests := []struct {
		compat        Compat
		local, server contract.RemoteInfo
		cli           string
		want          []string
	}{
		{CompatServerOlder, info(1, "0.2.1", ""), info(1, "0.2.0", ""), "zero-cli", []string{"box runs zero 0.2.0; this computer runs 0.2.1", "On box, run `zero update`", "`zero <path> --remote`"}},
		{CompatServerNewer, info(1, "0.2.0", ""), info(1, "0.3.0", ""), "zero-cli", []string{"box runs zero 0.3.0; this computer runs 0.2.0", "Run `zero-cli update` here"}},
		{CompatDifferentBuild, info(1, "0.0.0-dev.main", "aaa"), info(1, "0.0.0-dev.main", "bbb"), "", []string{"0.0.0-dev.main (bbb)", "0.0.0-dev.main (aaa)", "same build on both"}},
		{CompatIncompatible, info(1, "0.2.0", ""), info(2, "0.3.0", ""), "", []string{"protocol 2", "protocol 1", "same zero release on both"}},
	}
	for _, test := range tests {
		got := VersionWarning(test.compat, test.local, test.server, test.cli)
		for _, want := range test.want {
			if !strings.Contains(got, want) {
				t.Errorf("VersionWarning(%v) = %q, want %q", test.compat, got, want)
			}
		}
	}
	for _, quiet := range []Compat{CompatSame, CompatUnknown} {
		if got := VersionWarning(quiet, info(1, "0.2.0", ""), info(1, "0.2.0", ""), ""); got != "" || quiet.Warns() {
			t.Errorf("%v warns %q", quiet, got)
		}
	}
}

func TestRemoteInfoCommitIsOptionalOnTheWire(t *testing.T) {
	data, err := json.Marshal(contract.RemoteInfo{Protocol: 1, Version: "0.2.0", Name: "box"})
	if err != nil || strings.Contains(string(data), "commit") {
		t.Fatalf("without commit: %s, %v", data, err)
	}
	var old contract.RemoteInfo
	if err := json.Unmarshal([]byte(`{"protocol":1,"version":"0.2.0","name":"box"}`), &old); err != nil || old.Commit != "" || old.Version != "0.2.0" {
		t.Fatalf("an older server's answer = %+v, %v", old, err)
	}
	var current contract.RemoteInfo
	if err := json.Unmarshal([]byte(`{"protocol":1,"version":"0.2.0","name":"box","commit":"abc"}`), &current); err != nil || current.Commit != "abc" {
		t.Fatalf("a current server's answer = %+v, %v", current, err)
	}
}
