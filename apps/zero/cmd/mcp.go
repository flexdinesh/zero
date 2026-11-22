package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/flexdinesh/zero/internal/app"
	"github.com/flexdinesh/zero/internal/mcp"
	"github.com/flexdinesh/zero/internal/version"
	"github.com/flexdinesh/zero/internal/walkthrough"
	"github.com/flexdinesh/zero/pkg/contract"
	"github.com/spf13/cobra"
)

// `zero mcp` (decision 0189) serves the agent tools of `zero feedback` and
// `zero walkthrough` over MCP on standard input and output. Like those
// commands it needs no server: it works on the store directly and tells a
// running daemon. The agent starts it on the machine that serves the
// project, where the code is (decision 0187): this one, a remote host, or
// inside a sandbox.

type mcpOptions struct {
	name cliName
	// project is --project: the default project, absolute; "" uses the
	// working directory's repository.
	project string
	// Test seams, not flags.
	feedbackDir    string
	walkthroughDir string
	controlDir     string
	socket         string
	getwd          func() (string, error)
	publish        publishOptions // its seams; depth and name are set here
}

func newMCPCommand() *cobra.Command {
	var opts mcpOptions
	command := &cobra.Command{
		Use:   "mcp",
		Short: "Serve zero's agent tools over MCP on standard input and output",
		Long: "Serve review feedback and walkthrough tools to an agent over the Model Context\n" +
			"Protocol, on standard input and output. Agents start it themselves; run\n" +
			"`zero mcp config` for the setup. No server is needed: open windows update live.",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, _ []string) error {
			opts.name = cliName(command.Root().Name())
			if opts.project != "" {
				project, err := mcpProject(opts.project)
				if err != nil {
					return err
				}
				opts.project = project
			}
			return serveMCP(command.Context(), opts, command.InOrStdin(), command.OutOrStdout(), command.ErrOrStderr())
		},
	}
	command.Flags().StringVar(&opts.project, "project", "", "the default project for tools called without one (default: the working directory's repository)")
	command.AddCommand(newMCPConfigCommand(nil))
	return command
}

// mcpProject checks --project before serving: an existing directory, made
// absolute against the working directory.
func mcpProject(dir string) (string, error) {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("--project %s must be an existing directory", dir)
	}
	return absolute, nil
}

// serveMCP serves the tools on stdin and stdout until the client closes
// stdin or ctx ends. Nothing else writes to stdout; messages go to stderr.
func serveMCP(ctx context.Context, opts mcpOptions, stdin io.Reader, stdout, stderr io.Writer) error {
	server := mcp.NewServer(newMCPBackend(opts, stderr), mcp.Options{Version: version.Number()})
	err := mcp.Serve(ctx, server, io.NopCloser(stdin), nopWriteCloser{stdout})
	if errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }

// mcpBackend runs each tool with the cores the CLI commands use.
type mcpBackend struct {
	opts   mcpOptions
	stderr io.Writer
}

func newMCPBackend(opts mcpOptions, stderr io.Writer) mcpBackend {
	opts.publish.cliName = opts.name
	opts.publish.depth = feedbackDepth
	if opts.walkthroughDir != "" {
		opts.publish.walkthroughDir = opts.walkthroughDir
	}
	if opts.controlDir != "" {
		opts.publish.controlDir = opts.controlDir
	}
	if opts.socket != "" {
		opts.publish.socket = opts.socket
	}
	return mcpBackend{opts: opts, stderr: stderr}
}

// workdir is where a tool called without a project looks: --project, else
// the working directory. Either may lead to feedback stored for another
// checkout, as the CLI's working directory does.
func (b mcpBackend) workdir() (string, error) {
	if b.opts.project != "" {
		return b.opts.project, nil
	}
	if b.opts.getwd != nil {
		return b.opts.getwd()
	}
	return os.Getwd()
}

func (b mcpBackend) feedbackOptions(project string) feedbackOptions {
	return feedbackOptions{cliName: b.opts.name, project: project, feedbackDir: b.opts.feedbackDir, socket: b.opts.socket, getwd: b.workdir}
}

func (b mcpBackend) walkthroughsOptions(project string) walkthroughsOptions {
	return walkthroughsOptions{project: project, walkthroughDir: b.opts.walkthroughDir, getwd: b.workdir}
}

func (b mcpBackend) FeedbackShow(ctx context.Context, request mcp.FeedbackShowRequest) (mcp.FeedbackShown, error) {
	opts := b.feedbackOptions(request.Project)
	_, stored, shown, err := readFeedback(ctx, opts, request.ID, request.All)
	if err != nil {
		return mcp.FeedbackShown{}, b.feedbackError(opts, request.ID, err)
	}
	return mcp.FeedbackShown{Markdown: renderFeedbackMarkdown(mcpHints{}, stored, shown.Threads, request.All), Feedback: shown}, nil
}

func (b mcpBackend) FeedbackList(_ context.Context, project string) (mcp.FeedbackListed, error) {
	opts := b.feedbackOptions(project)
	session, err := openFeedback(opts, "")
	if err != nil {
		return mcp.FeedbackListed{}, b.feedbackError(opts, "", errNoSession{err})
	}
	summaries, err := session.app.Feedback.List(contract.FeedbackListRequest{Project: session.root})
	if err != nil {
		return mcp.FeedbackListed{}, b.feedbackError(opts, "", err)
	}
	if len(summaries) == 0 {
		return mcp.FeedbackListed{Text: fmt.Sprintf("No feedback in %s yet.\n", session.root), Summaries: summaries}, nil
	}
	var out strings.Builder
	for _, summary := range summaries {
		branch := summary.Branch
		if branch == "" {
			branch = "(detached HEAD)"
		}
		fmt.Fprintf(&out, "%s  %s  %s, %d awaiting you\n", summary.ID, branch, count(summary.Threads, "thread"), summary.AwaitingAgent)
	}
	return mcp.FeedbackListed{Text: out.String(), Summaries: summaries}, nil
}

func (b mcpBackend) FeedbackReply(ctx context.Context, request mcp.FeedbackReplyRequest) (mcp.FeedbackPosted, error) {
	if request.Thread < 1 {
		return mcp.FeedbackPosted{}, fmt.Errorf("thread must be a number from 1, not %d", request.Thread)
	}
	var status contract.FeedbackStatus
	switch request.Status {
	case "":
	case "resolved":
		status = contract.FeedbackStatusResolved
	case "wontfix":
		status = contract.FeedbackStatusWontfix
	case "open":
		status = contract.FeedbackStatusOpen
	default:
		return mcp.FeedbackPosted{}, fmt.Errorf("status must be resolved, wontfix, or open, not %q", request.Status)
	}
	if request.Message == "" && status == "" {
		return mcp.FeedbackPosted{}, errors.New("give a message, or a status with or without one")
	}
	opts := b.feedbackOptions(request.Project)
	thread, err := postFeedbackReply(ctx, opts, request.ID, request.Thread, request.Message, status, request.Name, b.stderr)
	if err != nil {
		return mcp.FeedbackPosted{}, b.feedbackError(opts, request.ID, err)
	}
	return mcp.FeedbackPosted{Text: fmt.Sprintf("replied to thread %d%s\n", thread.Number, replyOutcome(status)), Thread: thread}, nil
}

func (b mcpBackend) FeedbackComment(ctx context.Context, request mcp.FeedbackCommentRequest) (mcp.FeedbackPosted, error) {
	var lines []int
	switch len(request.Lines) {
	case 0:
	case 1:
		lines = []int{request.Lines[0], request.Lines[0]}
	case 2:
		lines = request.Lines
	default:
		return mcp.FeedbackPosted{}, fmt.Errorf("lines must be [start, end] or [line], not %d numbers", len(request.Lines))
	}
	opts := b.feedbackOptions(request.Project)
	thread, err := startFeedbackThread(ctx, opts, request.ID, request.Path, lines, request.Message, request.Name, b.stderr)
	if err != nil {
		return mcp.FeedbackPosted{}, b.feedbackError(opts, request.ID, err)
	}
	return mcp.FeedbackPosted{Text: fmt.Sprintf("started thread %d at %s\n", thread.Number, threadLabel(thread)), Thread: thread}, nil
}

func (b mcpBackend) FeedbackAttachment(_ context.Context, request mcp.FeedbackAttachmentRequest) (mcp.Screenshot, error) {
	if request.Crop != nil && *request.Crop < 0 {
		return mcp.Screenshot{}, fmt.Errorf("crop must be a margin of 0 or more px, not %d", *request.Crop)
	}
	shot, err := readScreenshot(b.feedbackOptions(""), mcpHints{}, request.ID, request.Attachment)
	if err != nil {
		return mcp.Screenshot{}, err
	}
	metadata := shot.metadata
	if request.Crop == nil {
		return mcp.Screenshot{Text: fmt.Sprintf("Screenshot %s of %s: %d×%d", request.Attachment, request.ID, metadata.Width, metadata.Height), PNG: shot.data}, nil
	}
	cropped, bounds, err := cropPNG(shot.data, shot.visual.Rect, *request.Crop)
	if err != nil {
		return mcp.Screenshot{}, err
	}
	rect := shot.visual.Rect
	text := fmt.Sprintf("Screenshot %s of %s, cropped to %d×%d: region %d,%d %d×%d plus %d px margin, at %d,%d of %d×%d", request.Attachment, request.ID, bounds.Dx(), bounds.Dy(), rect.X, rect.Y, rect.Width, rect.Height, *request.Crop, bounds.Min.X, bounds.Min.Y, metadata.Width, metadata.Height)
	return mcp.Screenshot{Text: text, PNG: cropped}, nil
}

func (b mcpBackend) WalkthroughPublish(ctx context.Context, arguments []byte) (mcp.WalkthroughPublished, error) {
	if len(arguments) > walkthrough.MaxRequestBytes {
		return mcp.WalkthroughPublished{}, fmt.Errorf("a walkthrough is at most %d bytes", walkthrough.MaxRequestBytes)
	}
	draft, err := walkthrough.Decode(bytes.NewReader(arguments))
	if err != nil {
		return mcp.WalkthroughPublished{}, walkthroughError(err)
	}
	result, err := storeWalkthrough(ctx, b.opts.publish, draft, b.stderr)
	if err != nil {
		return mcp.WalkthroughPublished{}, walkthroughError(err)
	}
	return mcp.WalkthroughPublished{Text: publishText(result, draft.Open, b.opts.name, false), Result: result}, nil
}

func (b mcpBackend) WalkthroughList(_ context.Context, project string) (mcp.WalkthroughsListed, error) {
	root, summaries, err := listWalkthroughs(b.walkthroughsOptions(project))
	if err != nil {
		return mcp.WalkthroughsListed{}, b.projectHint(project, err)
	}
	return mcp.WalkthroughsListed{Text: walkthroughsText(root, summaries), Summaries: summaries}, nil
}

func (b mcpBackend) WalkthroughDelete(_ context.Context, project, id string) (mcp.WalkthroughDeleted, error) {
	root, err := deleteWalkthrough(b.walkthroughsOptions(project), id)
	if err != nil {
		return mcp.WalkthroughDeleted{}, b.projectHint(project, err)
	}
	return mcp.WalkthroughDeleted{Text: deletedText(id, root)}, nil
}

// feedbackError words a failed feedback operation for the agent: every
// problem by field, where the feedback is stored when not here, or how to
// name the project.
func (b mcpBackend) feedbackError(opts feedbackOptions, id string, err error) error {
	if opened, ok := sessionFailure(err); ok {
		return b.projectHint(opts.project, opened)
	}
	var rejection *app.FeedbackRejected
	shown := errors.New(app.AsError(err).Message)
	if errors.As(err, &rejection) {
		var out strings.Builder
		out.WriteString("invalid feedback:")
		for _, problem := range rejection.Problems {
			fmt.Fprintf(&out, "\n  %s: %s", problem.Field, problem.Message)
		}
		shown = errors.New(out.String())
	}
	return notHere(opts, mcpHints{}, id, "", shown, err)
}

// projectHint adds how to name the project to a failure to open the one a
// tool defaulted to.
func (b mcpBackend) projectHint(project string, err error) error {
	if project != "" {
		return err
	}
	return fmt.Errorf("%w; pass project, the repository's absolute root (or start zero mcp with --project)", err)
}

// walkthroughError lists a rejected draft's problems by field.
func walkthroughError(err error) error {
	var problems walkthrough.Problems
	if !errors.As(err, &problems) {
		return err
	}
	var out strings.Builder
	out.WriteString("invalid walkthrough:")
	for _, problem := range problems {
		fmt.Fprintf(&out, "\n  %s: %s", problem.Field, problem.Message)
	}
	return errors.New(out.String())
}

// mcpHints words feedback output's next steps as tool calls.
type mcpHints struct{}

func (mcpHints) replyHint(id string) string {
	return fmt.Sprintf(`%s {"id": %q, "thread": <thread>, "message": "<what you did>", "status": "resolved" | "wontfix"}`, mcp.ToolFeedbackReply, id)
}

func (mcpHints) showAllHint() string {
	return "Call " + mcp.ToolFeedbackShow + " with all: true to list every thread."
}

func (mcpHints) attachmentHint(id, attachment string) string {
	return fmt.Sprintf(`%s {"id": %q, "attachment": %q, "crop": 24}`, mcp.ToolFeedbackAttachment, id, attachment)
}

func (mcpHints) showAll(id string) string {
	return fmt.Sprintf(`%s {"id": %q, "all": true}`, mcp.ToolFeedbackShow, id)
}

func (mcpHints) elsewhere(message, _ string) error {
	return fmt.Errorf("%s\n  Feedback is stored on the machine that serves the project. Served remotely: run your agent and zero mcp there. In a sandbox, run zero mcp inside it: docker exec -i <container> /tmp/.zero/zero mcp", message)
}

// mcpConfigOptions choose the snippet `zero mcp config` prints.
type mcpConfigOptions struct {
	agent     string
	container string
}

// newMCPConfigCommand prints how an agent starts zero mcp. executable
// finds this zero's absolute path; nil uses the invoked command.
func newMCPConfigCommand(executable func() (string, error)) *cobra.Command {
	var opts mcpConfigOptions
	command := &cobra.Command{
		Use:   "config",
		Short: "Print the setup that starts zero mcp from an agent",
		Long: "Print the setup that starts zero mcp from an agent: a Claude Code command, a\n" +
			"Codex config.toml entry, or the mcpServers JSON most other agents read\n" +
			"(Cursor's mcp.json, the default). --container starts it inside a sandbox\n" +
			"attached with zero attach, for an agent on the sandbox's host.",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, _ []string) error {
			if executable == nil {
				executable = invokedExecutable
			}
			text, err := mcpConfig(opts, executable)
			if err != nil {
				return err
			}
			_, err = io.WriteString(command.OutOrStdout(), text)
			return err
		},
	}
	command.Flags().StringVar(&opts.agent, "agent", "", "claude, codex, or cursor (default: mcpServers JSON)")
	command.Flags().StringVar(&opts.container, "container", "", "a Docker container attached with zero attach: start zero mcp inside it")
	return command
}

// mcpConfig is the snippet for opts: the command that starts zero mcp, in
// the agent's format.
func mcpConfig(opts mcpConfigOptions, executable func() (string, error)) (string, error) {
	var argv []string
	if opts.container != "" {
		argv = []string{"docker", "exec", "-i", opts.container, "/tmp/.zero/zero", "mcp"}
	} else {
		self, err := executable()
		if err != nil {
			return "", fmt.Errorf("find zero's path: %w", err)
		}
		argv = []string{self, "mcp"}
	}
	switch opts.agent {
	case "claude":
		words := append([]string{"claude", "mcp", "add", "--scope", "user", "zero", "--"}, argv...)
		for index, word := range words {
			words[index] = shellWord(word)
		}
		return strings.Join(words, " ") + "\n", nil
	case "codex":
		args := make([]string, len(argv)-1)
		for index, arg := range argv[1:] {
			args[index] = tomlString(arg)
		}
		return fmt.Sprintf("[mcp_servers.zero]\ncommand = %s\nargs = [%s]\n", tomlString(argv[0]), strings.Join(args, ", ")), nil
	case "", "cursor":
		type server struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		}
		config := struct {
			MCPServers map[string]server `json:"mcpServers"`
		}{MCPServers: map[string]server{"zero": {Command: argv[0], Args: argv[1:]}}}
		var out bytes.Buffer
		encoder := json.NewEncoder(&out)
		encoder.SetEscapeHTML(false)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(config); err != nil {
			return "", err
		}
		return out.String(), nil
	default:
		return "", fmt.Errorf("--agent must be claude, codex, or cursor, not %q", opts.agent)
	}
}

// invokedExecutable is the absolute path this zero was started as, so the
// snippet names the command users run, not where a symlink leads.
func invokedExecutable() (string, error) {
	invoked := os.Args[0]
	if strings.ContainsRune(invoked, filepath.Separator) {
		return filepath.Abs(invoked)
	}
	if found, err := exec.LookPath(invoked); err == nil {
		return filepath.Abs(found)
	}
	return os.Executable()
}

// shellWord quotes word for a POSIX shell when it needs it.
func shellWord(word string) string {
	if word != "" && strings.Trim(word, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./:=@") == "" {
		return word
	}
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}

// tomlString is s as a TOML basic string.
func tomlString(s string) string {
	encoded, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(encoded)
}
