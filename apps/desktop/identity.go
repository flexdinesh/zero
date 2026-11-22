package main

import (
	"context"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/flexdinesh/zero/apps/desktop/internal/bridge"
	"github.com/flexdinesh/zero/apps/desktop/internal/link"
	"github.com/flexdinesh/zero/apps/desktop/internal/proxy"
	"github.com/flexdinesh/zero/pkg/client"
	"github.com/flexdinesh/zero/pkg/contract"
)

// Repository identities across windows (decision 0188): one store of Viewed
// marks for every window, and finding a repository's checkout on the other
// connections whose windows are open. Sandbox pages get none of it: a
// container's code can tamper with its server.

// findTimeout bounds asking one connection for its projects.
const findTimeout = 5 * time.Second

// notSandbox accepts the local connection's page and a saved remote
// server's, never a sandbox's.
func (b *bridgeService) notSandbox(host string) bool {
	return host == proxy.Host || (strings.HasPrefix(host, "r-") && b.host.connections.Known(host))
}

// ViewedMarks answers an identity's Viewed marks, file path to blob.
func (b *bridgeService) ViewedMarks(ctx context.Context, identity any) (map[string]string, error) {
	if _, ok := callerWindow(ctx, b.notSandbox); !ok {
		return nil, errRefused
	}
	id, ok := bridge.ParseIdentity(identity)
	if !ok {
		return nil, errRefused
	}
	return b.host.marks.Get(id), nil
}

// SetViewedMarks replaces an identity's Viewed marks.
func (b *bridgeService) SetViewedMarks(ctx context.Context, identity, marks any) error {
	if _, ok := callerWindow(ctx, b.notSandbox); !ok {
		return errRefused
	}
	id, files, ok := bridge.ParseViewedMarks(identity, marks)
	if !ok {
		return errRefused
	}
	return b.host.marks.Set(id, files)
}

// FindProject lists the checkouts of an identity that the local daemon and
// the connections with open windows serve, leaving out the sender's own
// connection. It dials or starts no other connection.
func (b *bridgeService) FindProject(ctx context.Context, identity any) ([]bridge.ProjectMatch, error) {
	if _, ok := callerWindow(ctx, b.notSandbox); !ok {
		return nil, errRefused
	}
	id, ok := bridge.ParseIdentity(identity)
	if !ok {
		return nil, errRefused
	}
	return b.host.findProject(ctx, hostOf(mygo.CallerPage(ctx).URL()), id), nil
}

// OpenProject opens a project in a connection's window, as a link to it
// would.
func (b *bridgeService) OpenProject(ctx context.Context, connection, project any) error {
	if _, ok := callerWindow(ctx, b.notSandbox); !ok {
		return errRefused
	}
	target, path, ok := bridge.ParseOpenProject(connection, project, b.host.connections.Known)
	if !ok {
		return errRefused
	}
	b.host.loadLink(link.Target{Connection: target, Route: "/", RawQuery: url.Values{"project": {path}}.Encode()})
	return nil
}

// findProject asks the local daemon and every connection with an open
// window but caller, at once, for its checkouts of identity: the local
// daemon's first, then by connection id.
func (h *host) findProject(ctx context.Context, caller, identity string) []bridge.ProjectMatch {
	h.mu.Lock()
	hosts := make([]string, 0, len(h.windows)+1)
	for connectionHost := range h.windows {
		if connectionHost != proxy.Host {
			hosts = append(hosts, connectionHost)
		}
	}
	h.mu.Unlock()
	sort.Strings(hosts)
	hosts = append([]string{proxy.Host}, hosts...)
	found := make([][]bridge.ProjectMatch, len(hosts))
	var wait sync.WaitGroup
	for i, connectionHost := range hosts {
		if connectionHost == caller {
			continue
		}
		wait.Add(1)
		go func() {
			defer wait.Done()
			found[i] = h.checkoutsOn(ctx, connectionHost, identity)
		}()
	}
	wait.Wait()
	var matches []bridge.ProjectMatch
	for _, some := range found {
		matches = append(matches, some...)
	}
	return matches
}

// checkoutsOn asks one connection's server for its checkouts of identity;
// one that does not answer in time has none.
func (h *host) checkoutsOn(ctx context.Context, connectionHost, identity string) []bridge.ProjectMatch {
	ctx, cancel := context.WithTimeout(ctx, findTimeout)
	defer cancel()
	var response contract.ProjectsResponse
	label := "This computer"
	if connectionHost == proxy.Host {
		err := h.daemon.Do(ctx, func(daemon client.Client) (err error) {
			response, err = daemon.Projects(ctx)
			return err
		})
		if err != nil {
			return nil
		}
	} else {
		endpoint, found, err := h.connections.Endpoint(connectionHost)
		if err != nil || !found {
			return nil
		}
		if response, err = client.NewEndpoint(endpoint).Projects(ctx); err != nil {
			return nil
		}
		if label = h.connections.Label(connectionHost); label == "" {
			label = connectionHost
		}
	}
	return bridge.MatchesOf(response, connectionHost, label, identity)
}
