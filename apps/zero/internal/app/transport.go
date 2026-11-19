package app

import "context"

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
