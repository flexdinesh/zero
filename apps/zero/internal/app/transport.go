package app

import (
	"context"

	"github.com/flexdinesh/zero/pkg/contract"
)

// Transport is how a request reached the server, as the listener that took
// it knows: never the client's own claim. Feedback derives what a visual
// target's loopback URL refers to from it (decision 0176).
type Transport int

const (
	// TransportRemote: the client may be on another machine. The daemon's
	// tls and tailscale exposures and serve-stdio (whose loopback is the
	// sandbox's) are remote, and so is a request no listener marked.
	TransportRemote Transport = iota
	// TransportLocal: the client shares the project's host: the daemon's
	// Unix socket and `zero browser`'s loopback listener.
	TransportLocal
)

type transportKey struct{}

// WithTransport marks ctx as arriving on transport.
func WithTransport(ctx context.Context, transport Transport) context.Context {
	return context.WithValue(ctx, transportKey{}, transport)
}

// TransportOf is the transport ctx arrived on, TransportRemote when no
// listener marked it.
func TransportOf(ctx context.Context) Transport {
	if transport, ok := ctx.Value(transportKey{}).(Transport); ok {
		return transport
	}
	return TransportRemote
}

// place is where a server's projects are from the side of a request on
// transport (decision 0187): a sandbox's server (mode stdio) is always in the
// sandbox, its loopback the sandbox's; otherwise the transport decides.
func place(mode contract.DiagnosticsMode, transport Transport) contract.ServerPlace {
	switch {
	case mode == contract.DiagnosticsStdio:
		return contract.PlaceSandbox
	case transport == TransportLocal:
		return contract.PlaceLocal
	default:
		return contract.PlaceRemote
	}
}
