package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/flexdinesh/zero/internal/daemon"
	"github.com/flexdinesh/zero/internal/identity"
	"github.com/flexdinesh/zero/pkg/client"
	"github.com/flexdinesh/zero/pkg/contract"
)

// repoLookup lists the checkouts of a repository identity that a running
// daemon serves (decision 0188); ok is false when no daemon answers.
type repoLookup func(ctx context.Context, repo string) (checkouts []string, ok bool)

// normalizeRepo validates --repo: an identity or a remote URL, never beside a
// path.
func normalizeRepo(repo string, paths []string) (string, error) {
	if len(paths) > 0 {
		return "", fmt.Errorf("--repo and a path cannot be combined")
	}
	id, ok := identity.Normalize(repo)
	if !ok {
		return "", fmt.Errorf("--repo %q is not a repository identity or remote URL, as in github.com/owner/repo", repo)
	}
	return id, nil
}

// daemonCheckouts asks a running daemon for its projects; it never starts
// one.
func daemonCheckouts(ctx context.Context, repo string) ([]string, bool) {
	socket, err := daemon.DefaultSocket()
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, daemonTimeout)
	defer cancel()
	response, err := client.NewUnix(socket).Projects(ctx)
	if err != nil {
		return nil, false
	}
	return checkoutsOf(response, repo), true
}

// checkoutsOf lists the available projects whose repository has the
// identity.
func checkoutsOf(response contract.ProjectsResponse, repo string) []string {
	var found []string
	for _, project := range response.Projects {
		if project.Available && project.Identity == repo {
			found = append(found, project.ID)
		}
	}
	return found
}

// repoPath is the one checkout of opts.repo a running daemon serves, for the
// commands that serve a path: `zero browser`, --remote, and --tailscale.
func repoPath(ctx context.Context, opts options, lookup repoLookup) (string, error) {
	found, ok := lookup(ctx, opts.repo)
	switch {
	case !ok:
		return "", fmt.Errorf("--repo finds checkouts the zero daemon serves, and none is running; open the folder with `%s <path>`", opts.cliName)
	case len(found) == 0:
		return "", fmt.Errorf("the zero daemon serves no checkout of %s; open its folder with `%s <path>`", opts.repo, opts.cliName)
	case len(found) > 1:
		return "", fmt.Errorf("the zero daemon serves %d checkouts of %s; pass one as the path:\n  %s", len(found), opts.repo, strings.Join(found, "\n  "))
	}
	return found[0], nil
}

// withRepoPath resolves opts.repo into opts.paths; without --repo it changes
// nothing.
func withRepoPath(ctx context.Context, opts options, lookup repoLookup) (options, error) {
	if opts.repo == "" {
		return opts, nil
	}
	path, err := repoPath(ctx, opts, lookup)
	if err != nil {
		return opts, err
	}
	opts.paths = []string{path}
	return opts, nil
}
