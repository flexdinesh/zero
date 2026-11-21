package app

import (
	"context"
	"os"
	"testing"

	"github.com/flexdinesh/zero/pkg/contract"
)

// Projects say where they are from the request's side: the listener's
// transport decides, except that a sandbox's server is always in the sandbox
// (decision 0187). Host names the serving machine.
func TestProjectsPlaceFollowsTransport(t *testing.T) {
	host, err := os.Hostname()
	if err != nil {
		host = ""
	}
	local := WithTransport(context.Background(), TransportLocal)
	remote := WithTransport(context.Background(), TransportRemote)
	for name, test := range map[string]struct {
		mode contract.DiagnosticsMode
		ctx  context.Context
		want contract.ServerPlace
	}{
		"daemon socket":        {contract.DiagnosticsDaemon, local, contract.PlaceLocal},
		"daemon exposure":      {contract.DiagnosticsDaemon, remote, contract.PlaceRemote},
		"unmarked request":     {contract.DiagnosticsDaemon, context.Background(), contract.PlaceRemote},
		"browser loopback":     {contract.DiagnosticsBrowser, local, contract.PlaceLocal},
		"sandbox over stdio":   {contract.DiagnosticsStdio, remote, contract.PlaceSandbox},
		"sandbox marked local": {contract.DiagnosticsStdio, local, contract.PlaceSandbox},
	} {
		t.Run(name, func(t *testing.T) {
			listed := newDiagnosticsApp(t, ServerInfo{Mode: test.mode}, "/home/u").Projects.List(test.ctx)
			if listed.Place != test.want || listed.Host != host {
				t.Errorf("place, host = %q, %q; want %q, %q", listed.Place, listed.Host, test.want, host)
			}
		})
	}
}
