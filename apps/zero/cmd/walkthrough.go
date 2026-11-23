package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	goruntime "runtime"
	"strings"
	"time"

	"github.com/flexdinesh/zero/internal/app"
	"github.com/flexdinesh/zero/internal/browser"
	"github.com/flexdinesh/zero/internal/control"
	"github.com/flexdinesh/zero/internal/daemon"
	"github.com/flexdinesh/zero/internal/desktopapp"
	"github.com/flexdinesh/zero/internal/document"
	"github.com/flexdinesh/zero/internal/projects"
	"github.com/flexdinesh/zero/internal/walkthrough"
	"github.com/flexdinesh/zero/pkg/contract"
	"github.com/spf13/cobra"
)

// Publishing without a server (decision 0065): the CLI checks targets with
// the checks POST /api/walkthroughs applies and writes the same store.

const (
	// publishTimeout bounds target checks, as the server's status timeout does.
	publishTimeout = 20 * time.Second
	// viewerTimeout bounds each running server's walkthrough probe.
	viewerTimeout = 2 * time.Second
	// announceTimeout bounds telling the daemon about a publish.
	announceTimeout = time.Second
)

// errNotPublished is returned after a rejected draft's problems are printed.
var errNotPublished = errors.New("walkthrough not published")

type publishOptions struct {
	cliName cliName
	source  string // file path or "-" for stdin
	depth   int
	noOpen  bool
	json    bool
	// Test seams, not flags.
	walkthroughDir string             // "" uses walkthrough.DefaultDirectory()
	controlDir     string             // "" uses control.DefaultDirectory()
	socket         string             // "" uses daemon.DefaultSocket()
	openBrowser    func(string) error // nil uses browser.Open
	getenv         func(string) string
	installed      func(context.Context) (bool, error) // nil uses desktopapp.Installed
	openApp        func(context.Context, string) error // nil uses desktopapp.Open
	goos           string                              // "" uses runtime.GOOS
}

type publishRunner func(context.Context, publishOptions, io.Reader, io.Writer, io.Writer) error

func newWalkthroughCommand(publish publishRunner) *cobra.Command {
	command := &cobra.Command{
		Use:           "walkthrough",
		Short:         "Publish walkthroughs without a running server",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		// Runnable so NoArgs rejects unknown subcommands; bare, it prints help.
		RunE: func(command *cobra.Command, _ []string) error { return command.Help() },
	}
	var opts publishOptions
	publishCommand := &cobra.Command{
		Use:   "publish <file|->",
		Short: "Check and store a walkthrough; - reads standard input",
		Long: "Check a walkthrough's targets and store it where zero reads walkthroughs.\n" +
			"No server is needed: an open browser lists it within seconds.",
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, args []string) error {
			if opts.depth < 0 {
				return errors.New("--depth must be zero or greater")
			}
			opts.source = args[0]
			opts.cliName = cliName(command.Root().Name())
			return publish(command.Context(), opts, command.InOrStdin(), command.OutOrStdout(), command.ErrOrStderr())
		},
	}
	flags := publishCommand.Flags()
	flags.IntVar(&opts.depth, "depth", 5, "maximum directory depth of working-tree files within the project")
	flags.BoolVar(&opts.noOpen, "no-open", false, "do not open the desktop app or browser, even when the walkthrough asks to")
	flags.BoolVar(&opts.json, "json", false, "print the result as one JSON object")
	schemaCommand := &cobra.Command{
		Use:           "schema",
		Short:         "Print the walkthrough JSON Schema",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, _ []string) error {
			_, err := command.OutOrStdout().Write(walkthrough.Schema)
			return err
		},
	}
	var listOpts walkthroughsOptions
	listCommand := &cobra.Command{
		Use:           "list",
		Short:         "List a project's walkthroughs, most recently updated first",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, _ []string) error {
			return printWalkthroughs(listOpts, command.OutOrStdout())
		},
	}
	listCommand.Flags().StringVar(&listOpts.project, "project", "", "the project directory (default: the current directory's repository)")
	listCommand.Flags().BoolVar(&listOpts.json, "json", false, "print the walkthroughs as JSON")
	var deleteOpts walkthroughsOptions
	deleteCommand := &cobra.Command{
		Use:           "delete <id>",
		Short:         "Delete one of a project's walkthroughs",
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, args []string) error {
			root, err := deleteWalkthrough(deleteOpts, args[0])
			if err != nil {
				return err
			}
			_, err = io.WriteString(command.OutOrStdout(), deletedText(args[0], root))
			return err
		},
	}
	deleteCommand.Flags().StringVar(&deleteOpts.project, "project", "", "the project directory (default: the current directory's repository)")
	command.AddCommand(publishCommand, schemaCommand, listCommand, deleteCommand)
	return command
}

// walkthroughsOptions name the project whose stored walkthroughs list and
// delete read: --project, or else the current directory's repository.
type walkthroughsOptions struct {
	project string
	json    bool
	// Test seams, not flags.
	walkthroughDir string                 // "" uses walkthrough.DefaultDirectory()
	getwd          func() (string, error) // nil uses os.Getwd
}

// openWalkthroughs is the application layer over the project as its own
// root, reading the walkthrough store the server reads.
func openWalkthroughs(opts walkthroughsOptions) (string, *app.App, error) {
	dir := opts.project
	if dir == "" {
		getwd := opts.getwd
		if getwd == nil {
			getwd = os.Getwd
		}
		wd, err := getwd()
		if err != nil {
			return "", nil, err
		}
		dir = wd
	}
	root, err := repositoryRoot(dir)
	if err != nil {
		return "", nil, err
	}
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		return "", nil, err
	}
	application, err := app.New(app.Config{Roots: roots, Depth: feedbackDepth, Types: document.Builtins(), WalkthroughDirectory: opts.walkthroughDir})
	if err != nil {
		return "", nil, err
	}
	return root, application, nil
}

// listWalkthroughs returns the project's root and its walkthroughs.
func listWalkthroughs(opts walkthroughsOptions) (string, []contract.WalkthroughSummary, error) {
	root, application, err := openWalkthroughs(opts)
	if err != nil {
		return "", nil, err
	}
	summaries, err := application.Walkthroughs.List(root)
	if err != nil {
		return "", nil, errors.New(app.AsError(err).Message)
	}
	return root, summaries, nil
}

// deleteWalkthrough removes the project's walkthrough id and returns the
// project's root. Open windows drop it on their next list poll.
func deleteWalkthrough(opts walkthroughsOptions, id string) (string, error) {
	root, application, err := openWalkthroughs(opts)
	if err != nil {
		return "", err
	}
	if err := application.Walkthroughs.Delete(root, id); err != nil {
		if app.AsError(err).Code == contract.CodeWalkthroughUnavailable {
			return "", fmt.Errorf("no walkthrough %q for %s", id, root)
		}
		return "", errors.New(app.AsError(err).Message)
	}
	return root, nil
}

func printWalkthroughs(opts walkthroughsOptions, stdout io.Writer) error {
	root, summaries, err := listWalkthroughs(opts)
	if err != nil {
		return err
	}
	if opts.json {
		return writeJSONLine(stdout, summaries)
	}
	_, err = io.WriteString(stdout, walkthroughsText(root, summaries))
	return err
}

// walkthroughsText is one line per walkthrough: its id, title, steps, and
// when it was last published.
func walkthroughsText(root string, summaries []contract.WalkthroughSummary) string {
	if len(summaries) == 0 {
		return fmt.Sprintf("No walkthroughs for %s yet.\n", root)
	}
	var out strings.Builder
	for _, summary := range summaries {
		fmt.Fprintf(&out, "%s  %s  %s, updated %s\n", summary.ID, summary.Title, count(summary.StepCount, "step"), messageTime(summary.UpdatedAt))
	}
	return out.String()
}

func deletedText(id, root string) string {
	return fmt.Sprintf("deleted walkthrough %s from %s\n", id, root)
}

type publishResult struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	Created bool   `json:"created"`
	URL     string `json:"url,omitempty"`
	// DesktopURL is the connected desktop app's link when this machine serves
	// remotely and nothing here shows the walkthrough.
	DesktopURL string `json:"desktopUrl,omitempty"`
}

func publishWalkthrough(ctx context.Context, opts publishOptions, stdin io.Reader, stdout, stderr io.Writer) error {
	draft, err := readDraft(opts.source, stdin)
	if err != nil {
		return err
	}
	result, err := storeWalkthrough(ctx, opts, draft, stderr)
	var problems walkthrough.Problems
	if errors.As(err, &problems) {
		_, _ = fmt.Fprintln(stderr, "invalid walkthrough:")
		for _, problem := range problems {
			_, _ = fmt.Fprintf(stderr, "  %s: %s\n", problem.Field, problem.Message)
		}
		return errNotPublished
	}
	if err != nil {
		return err
	}
	if opts.json {
		encoder := json.NewEncoder(stdout)
		encoder.SetEscapeHTML(false)
		return encoder.Encode(result)
	}
	_, _ = io.WriteString(stdout, publishText(result, draft.Open, opts.cliName, linkTerminal(stdout, opts.env())))
	return nil
}

// env is the publish's environment lookup: the test seam's, or the process's.
func (opts publishOptions) env() func(string) string {
	if opts.getenv == nil {
		return os.Getenv
	}
	return opts.getenv
}

// storeWalkthrough checks and stores draft, tells a running daemon, finds
// what shows it, and opens that when the draft asks (decision 0065). A
// rejected draft fails with walkthrough.Problems.
func storeWalkthrough(ctx context.Context, opts publishOptions, draft walkthrough.Draft, stderr io.Writer) (publishResult, error) {
	directory := opts.walkthroughDir
	if directory == "" {
		var err error
		directory, err = walkthrough.DefaultDirectory()
		if err != nil {
			return publishResult{}, err
		}
	}
	publishCtx, cancel := context.WithTimeout(ctx, publishTimeout)
	defer cancel()
	service := walkthrough.NewService(walkthrough.NewStore(directory), standaloneTargets{depth: opts.depth, types: document.Builtins()})
	published, err := service.Publish(publishCtx, draft)
	var problems walkthrough.Problems
	if errors.As(err, &problems) {
		return publishResult{}, problems
	}
	if err != nil {
		return publishResult{}, fmt.Errorf("publish walkthrough: %w", err)
	}

	stored := published.Walkthrough
	getenv := opts.env()
	goos := opts.goos
	if goos == "" {
		goos = goruntime.GOOS
	}
	local := !noUI(goos, getenv)
	open := draft.Open && shouldOpenBrowser(opts.noOpen, goos, getenv)

	// The desktop app on this machine shows walkthroughs of projects the
	// daemon serves; without a UI here, only http servers can show them
	// (decision 0076).
	viewerQuery := url.Values{"project": {stored.Project}, "wt": {stored.ID}}
	// Viewer links name the repository too (decision 0188).
	if repo := projects.Identity(stored.Project); repo != "" {
		viewerQuery.Set("repo", repo)
	}
	viewer := ""
	announced := announceToDaemon(ctx, opts.socket, stored.Project, stored.ID, published.Created, stderr)
	if local && announced && desktopAppInstalled(ctx, opts) {
		viewer = "zero://local/view?" + viewerQuery.Encode()
		if open {
			openApp := opts.openApp
			if openApp == nil {
				openApp = desktopapp.Open
			}
			if err := openApp(ctx, viewer); err != nil {
				_, _ = fmt.Fprintf(stderr, "could not open the Zero app: %v\n", err)
				viewer = ""
			}
		}
	}
	if viewer == "" {
		controlDir := opts.controlDir
		if controlDir == "" {
			controlDir, err = control.DefaultDirectory()
			if err != nil {
				return publishResult{}, err
			}
		}
		var mismatches []string
		viewer, mismatches = findViewer(ctx, control.NewRegistry(controlDir), stored.Project, stored.ID)
		for _, origin := range mismatches {
			_, _ = fmt.Fprintf(stderr, "zero at %s serves this project but keeps walkthroughs elsewhere; POST to %s/api/walkthroughs\n", origin, origin)
		}
		if open && viewer != "" {
			openBrowser := opts.openBrowser
			if openBrowser == nil {
				openBrowser = browser.Open
			}
			if err := openBrowser(viewer); err != nil {
				_, _ = fmt.Fprintf(stderr, "could not open browser: %v\n", err)
			}
		}
	}

	// A machine serving remotely has no window of its own to open, but the
	// connected app can show this; the link names the connection, not its secret.
	desktop := ""
	if viewer == "" && announced {
		if id := remoteConnectionID(ctx, opts.socket); id != "" {
			desktop = "zero://" + id + "/view?" + viewerQuery.Encode()
		}
	}
	return publishResult{ID: stored.ID, Project: stored.Project, Created: published.Created, URL: viewer, DesktopURL: desktop}, nil
}

// publishText is publish's text output: what was stored, then where it
// shows or how to view it. tty writes links as OSC 8 hyperlinks.
func publishText(result publishResult, asked bool, name cliName, tty bool) string {
	var out strings.Builder
	outcome := "replaced"
	if result.Created {
		outcome = "created"
	}
	fmt.Fprintf(&out, "published %s (%s) for %s\n", result.ID, outcome, result.Project)
	switch {
	case result.DesktopURL != "":
		fmt.Fprintf(&out, "desktop: %s\n", hyperlink(result.DesktopURL, tty))
	case strings.HasPrefix(result.URL, "http://"):
		fmt.Fprintf(&out, "web: %s\n", hyperlink(result.URL, tty))
	case result.URL != "":
		fmt.Fprintf(&out, "desktop: %s\n", hyperlink(result.URL, tty))
	case asked:
		fmt.Fprintf(&out, "no running zero shows this project, so nothing opened; run: %s %s, then open Walkthroughs\n", name, result.Project)
	default:
		fmt.Fprintf(&out, "no running zero shows this project; run: %s %s, then open Walkthroughs\n", name, result.Project)
	}
	return out.String()
}

// announceToDaemon tells a running daemon about the publish so its control
// streams announce it, and reports whether it did. A daemon that is not
// running, unreachable, or not serving the project is ignored; one that
// serves the project but reads another store gets a warning.
func announceToDaemon(ctx context.Context, socket, project, id string, created bool, stderr io.Writer) bool {
	if daemonSupported() != nil {
		return false
	}
	if socket == "" {
		var err error
		if socket, err = daemon.DefaultSocket(); err != nil {
			return false
		}
	}
	ctx, cancel := context.WithTimeout(ctx, announceTimeout)
	defer cancel()
	err := daemon.NewClient(socket).AnnounceWalkthrough(ctx, project, id, created)
	var failure *daemon.ControlError
	if errors.As(err, &failure) && failure.Status == http.StatusNotFound && failure.Code == "walkthroughUnavailable" {
		_, _ = fmt.Fprintf(stderr, "zero daemon at %s serves this project but keeps walkthroughs elsewhere\n", socket)
	}
	return err == nil
}

// remoteConnectionID is the id of the running daemon's TCP listener, or "".
func remoteConnectionID(ctx context.Context, socket string) string {
	socket, err := resolveSocket(socket)
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, announceTimeout)
	defer cancel()
	status, err := daemon.NewClient(socket).RemoteStatus(ctx)
	if err != nil || !status.Listening {
		return ""
	}
	return status.ID
}

// desktopAppInstalled reports whether the desktop app handles zero:// URLs;
// a failed check counts as not installed.
func desktopAppInstalled(ctx context.Context, opts publishOptions) bool {
	installed := opts.installed
	if installed == nil {
		installed = desktopapp.Installed
	}
	ok, err := installed(ctx)
	return err == nil && ok
}

// readDraft reads one strict draft from a file, or standard input for -,
// within the size POST /api/walkthroughs accepts.
func readDraft(source string, stdin io.Reader) (walkthrough.Draft, error) {
	reader := stdin
	if source != "-" {
		file, err := os.Open(source)
		if err != nil {
			return walkthrough.Draft{}, err
		}
		defer func() { _ = file.Close() }()
		reader = file
	}
	contents, err := io.ReadAll(io.LimitReader(reader, walkthrough.MaxRequestBytes+1))
	if err != nil {
		return walkthrough.Draft{}, fmt.Errorf("read walkthrough: %w", err)
	}
	if len(contents) > walkthrough.MaxRequestBytes {
		return walkthrough.Draft{}, fmt.Errorf("a walkthrough is at most %d bytes", walkthrough.MaxRequestBytes)
	}
	return walkthrough.Decode(bytes.NewReader(contents))
}

// standaloneTargets resolves the draft's project as its own root, then runs
// the application layer's shared checks.
type standaloneTargets struct {
	depth int
	types *document.Registry
}

func (t standaloneTargets) Check(ctx context.Context, project string, steps []walkthrough.Step) (string, []walkthrough.Step, error) {
	root, err := projects.ResolveStandalone(project)
	if errors.Is(err, projects.ErrInsideRepository) {
		return "", nil, walkthrough.Problems{{Field: "project", Message: "is a folder inside a repository; use the repository root (git rev-parse --show-toplevel)"}}
	}
	if err != nil {
		return "", nil, walkthrough.Problems{{Field: "project", Message: "must be an existing absolute directory"}}
	}
	roots, err := projects.NewRootSet([]string{root})
	if err != nil {
		return "", nil, err
	}
	return app.NewWalkthroughTargets(roots, t.depth, t.types).Check(ctx, root, steps)
}

// findViewer asks each running registered server whether it shows the
// walkthrough. It returns the first one's view URL, and the origins of
// servers that serve the project but read another walkthrough store.
func findViewer(ctx context.Context, registry control.Registry, project, id string) (string, []string) {
	remotes, err := registry.List()
	if err != nil {
		return "", nil
	}
	client := &http.Client{
		Timeout: viewerTimeout,
		Transport: &http.Transport{
			Proxy:       nil,
			DialContext: (&net.Dialer{Timeout: viewerTimeout}).DialContext,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer client.CloseIdleConnections()
	var mismatches []string
	for _, remote := range remotes {
		if !remote.Running(ctx) {
			continue
		}
		origin := remote.Origin()
		switch probeWalkthrough(ctx, client, origin, project, id) {
		case http.StatusOK:
			query := url.Values{"project": {project}, "wt": {id}}
			if repo := projects.Identity(project); repo != "" {
				query.Set("repo", repo)
			}
			return origin + "/view?" + query.Encode(), mismatches
		case http.StatusNotFound:
			mismatches = append(mismatches, origin)
		}
	}
	return "", mismatches
}

// probeWalkthrough returns 200 when the server at origin shows the
// walkthrough, 404 when it serves the project without it, and 0 otherwise.
func probeWalkthrough(ctx context.Context, client *http.Client, origin, project, id string) int {
	query := url.Values{"project": {project}, "id": {id}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/api/walkthrough?"+query.Encode(), nil)
	if err != nil {
		return 0
	}
	response, err := client.Do(req)
	if err != nil {
		return 0
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusOK {
		return http.StatusOK
	}
	var body struct {
		Code string `json:"code"`
	}
	if response.StatusCode == http.StatusNotFound && json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&body) == nil && body.Code == "walkthroughUnavailable" {
		return http.StatusNotFound
	}
	return 0
}
