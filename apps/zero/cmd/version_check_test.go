package cmd

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/flexdinesh/zero/internal/daemon"
	"github.com/flexdinesh/zero/internal/version"
	"github.com/flexdinesh/zero/pkg/connection"
	"github.com/flexdinesh/zero/pkg/contract"
)

// stampVersion builds this test binary as release v.
func stampVersion(t *testing.T, v string) {
	t.Helper()
	previous, previousCommit := version.Version, version.Commit
	version.Version, version.Commit = v, "aaaaaaaaaaaa"
	t.Cleanup(func() { version.Version, version.Commit = previous, previousCommit })
}

// connectAnswering connects to a server that describes itself as server.
func connectAnswering(t *testing.T, server contract.RemoteInfo) (stdout, stderr string, saved bool, err error) {
	t.Helper()
	fake, deps := newConnectFake(t)
	endpoint := connection.TLS{Hosts: []string{"127.0.0.1"}, Port: 7970, Credential: connection.Credential{Token: [connection.TokenSize]byte{9}}}
	deps.probe = func(context.Context, connection.TLS) (connection.TLS, contract.RemoteInfo, error) {
		return endpoint, server, nil
	}
	var out, errOut bytes.Buffer
	err = runConnect(context.Background(), connectOptions{cliName: "zero-cli", text: endpoint.Format(), noOpen: true}, &out, &errOut, deps)
	_, found, lookupErr := connection.NewStore(fake.store).Lookup(endpoint.Credential.ID())
	if lookupErr != nil {
		t.Fatal(lookupErr)
	}
	return out.String(), errOut.String(), found, err
}

func TestConnectWarnsWhenTheServerRunsAnotherRelease(t *testing.T) {
	stampVersion(t, "0.2.1")
	_, stderr, saved, err := connectAnswering(t, contract.RemoteInfo{Protocol: daemon.ProtocolVersion, Version: "0.2.0", Name: "box"})
	if err != nil || !saved {
		t.Fatalf("connect = %v, saved %v", err, saved)
	}
	if !strings.Contains(stderr, "warning: box runs zero 0.2.0; this computer runs 0.2.1. On box, run `zero update`") {
		t.Fatalf("stderr = %q", stderr)
	}

	_, stderr, _, err = connectAnswering(t, contract.RemoteInfo{Protocol: daemon.ProtocolVersion, Version: "0.3.0", Name: "box"})
	if err != nil || !strings.Contains(stderr, "Run `zero-cli update` here") {
		t.Fatalf("newer server: %v, stderr %q", err, stderr)
	}
}

func TestConnectIsQuietForTheSameRelease(t *testing.T) {
	stampVersion(t, "0.2.0")
	_, stderr, saved, err := connectAnswering(t, contract.RemoteInfo{Protocol: daemon.ProtocolVersion, Version: "0.2.0", Name: "box"})
	if err != nil || !saved || stderr != "" {
		t.Fatalf("connect = %v, saved %v, stderr %q", err, saved, stderr)
	}
}

func TestConnectRefusesAnotherProtocolAndSavesNothing(t *testing.T) {
	stampVersion(t, "0.2.0")
	_, _, saved, err := connectAnswering(t, contract.RemoteInfo{Protocol: daemon.ProtocolVersion + 1, Version: "0.9.0", Name: "box"})
	if err == nil || saved || !strings.Contains(err.Error(), "same zero release on both") {
		t.Fatalf("connect = %v, saved %v", err, saved)
	}
}

func TestCheckServerVersionIsWhatAttachUses(t *testing.T) {
	stampVersion(t, "0.2.0")
	var stderr bytes.Buffer
	if err := checkServerVersion(contract.RemoteInfo{Protocol: daemon.ProtocolVersion, Version: "0.2.0", Name: "c"}, "zero", &stderr); err != nil || stderr.Len() != 0 {
		t.Fatalf("same: %v %q", err, stderr.String())
	}
	if err := checkServerVersion(contract.RemoteInfo{Protocol: daemon.ProtocolVersion, Version: "0.0.0-dev.main", Commit: "bbbbbbbbbbbb", Name: "c"}, "zero", &stderr); err != nil || !strings.Contains(stderr.String(), "Install the same build on both") {
		t.Fatalf("different build: %v %q", err, stderr.String())
	}
	if err := checkServerVersion(contract.RemoteInfo{Protocol: daemon.ProtocolVersion + 1, Version: "0.2.0", Name: "c"}, "zero", &stderr); err == nil {
		t.Fatal("another protocol was accepted")
	}
}
