package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/flexdinesh/zero/internal/mcp"
	"github.com/flexdinesh/zero/internal/walkthrough"
)

// testMCPOptions keeps the server's stores, registry, and daemon socket
// private, works from root/sub, and never opens a browser or the app.
func testMCPOptions(t *testing.T, root string) mcpOptions {
	t.Helper()
	publish, _ := testPublishOptions(t, "")
	return mcpOptions{
		name:           "zero",
		feedbackDir:    filepath.Join(t.TempDir(), "feedback"),
		walkthroughDir: publish.walkthroughDir,
		controlDir:     publish.controlDir,
		socket:         publish.socket,
		getwd:          func() (string, error) { return filepath.Join(root, "sub"), nil },
		publish:        publish,
	}
}

// connectMCP serves opts's tools in memory and returns a client session.
func connectMCP(t *testing.T, opts mcpOptions) *sdk.ClientSession {
	t.Helper()
	ctx := context.Background()
	serverTransport, clientTransport := sdk.NewInMemoryTransports()
	var stderr bytes.Buffer
	server := mcp.NewServer(newMCPBackend(opts, &stderr), mcp.Options{Version: "test"})
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	session, err := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "test"}, nil).Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

// callMCP calls tool and returns its text and whether it failed.
func callMCP(t *testing.T, session *sdk.ClientSession, tool string, arguments map[string]any) (string, bool, *sdk.CallToolResult) {
	t.Helper()
	result, err := session.CallTool(context.Background(), &sdk.CallToolParams{Name: tool, Arguments: arguments})
	if err != nil {
		t.Fatalf("call %s: %v", tool, err)
	}
	text := ""
	if len(result.Content) > 0 {
		if content, ok := result.Content[0].(*sdk.TextContent); ok {
			text = content.Text
		}
	}
	return text, result.IsError, result
}

func TestMCPFeedbackTools(t *testing.T) {
	root, _ := publishRepo(t)
	opts := testMCPOptions(t, root)
	session := connectMCP(t, opts)

	text, failed, _ := callMCP(t, session, mcp.ToolFeedbackComment, map[string]any{"path": "doc.md", "lines": []int{2}, "message": "Is this line needed?", "name": "claude"})
	if failed || text != "started thread 1 at doc.md:2\n" {
		t.Fatalf("feedback_comment = %q, failed %v", text, failed)
	}
	text, _, _ = callMCP(t, session, mcp.ToolFeedbackShow, map[string]any{})
	if !strings.HasSuffix(text, "No threads awaiting you. Call feedback_show with all: true to list every thread.\n") {
		t.Errorf("feedback_show with only the agent's thread = %q", text)
	}

	userThread(t, feedbackOptions{feedbackDir: opts.feedbackDir}, root, []int{1, 1}, "Rename the **heading**.")
	text, failed, result := callMCP(t, session, mcp.ToolFeedbackShow, map[string]any{})
	id := strings.TrimPrefix(strings.SplitN(text, "\n", 2)[0], "# Feedback ")
	want := "\nReply: feedback_reply {\"id\": \"" + id + "\", \"thread\": <thread>, \"message\": \"<what you did>\", \"status\": \"resolved\" | \"wontfix\"}\n\n## Thread 2 · open · doc.md:1\n"
	if failed || !strings.Contains(text, want) || !strings.HasSuffix(text, "Rename the **heading**.\n") {
		t.Fatalf("feedback_show =\n%s\nwant it to contain\n%s", text, want)
	}
	structured, err := json.Marshal(result.StructuredContent)
	if err != nil || !strings.Contains(string(structured), `"id":"`+id+`"`) || strings.Count(string(structured), `"awaiting":`) != 1 {
		t.Errorf("feedback_show structured = %s, %v", structured, err)
	}

	text, failed, _ = callMCP(t, session, mcp.ToolFeedbackReply, map[string]any{"id": id, "thread": 2, "message": "Renamed it.", "status": "resolved"})
	if failed || text != "replied to thread 2 (resolved)\n" {
		t.Fatalf("feedback_reply = %q, failed %v", text, failed)
	}
	text, _, _ = callMCP(t, session, mcp.ToolFeedbackShow, map[string]any{"id": id, "all": true})
	if !strings.Contains(text, "## Thread 2 · resolved · doc.md:1\n") || !strings.Contains(text, "**agent (claude)** · ") {
		t.Errorf("feedback_show all =\n%s", text)
	}
	text, _, _ = callMCP(t, session, mcp.ToolFeedbackList, map[string]any{})
	if text != id+"  master  2 threads, 0 awaiting you\n" {
		t.Errorf("feedback_list = %q", text)
	}

	// Problems come back by field, for the agent to fix.
	for _, test := range []struct {
		arguments map[string]any
		want      string
	}{
		{map[string]any{"id": id, "thread": 9, "message": "Done."}, "invalid feedback:\n  thread: "},
		{map[string]any{"id": id, "thread": 2, "status": "done"}, `status must be resolved, wontfix, or open, not "done"`},
		{map[string]any{"id": id, "thread": 2}, "give a message, or a status"},
	} {
		if text, failed, _ := callMCP(t, session, mcp.ToolFeedbackReply, test.arguments); !failed || !strings.Contains(text, test.want) {
			t.Errorf("feedback_reply %v = %q, failed %v; want %q", test.arguments, text, failed, test.want)
		}
	}
}

func TestMCPProjectComesFromTheArgumentThenTheFlagThenTheWorkingDirectory(t *testing.T) {
	root, _ := publishRepo(t)
	other, _ := publishRepo(t)
	outside := filepath.Join(t.TempDir(), "missing")

	opts := testMCPOptions(t, root)
	opts.getwd = func() (string, error) { return outside, nil }
	session := connectMCP(t, opts)
	text, failed, _ := callMCP(t, session, mcp.ToolFeedbackShow, map[string]any{})
	if !failed || !strings.Contains(text, "pass project, the repository's absolute root (or start zero mcp with --project)") {
		t.Errorf("feedback_show from a missing directory = %q, failed %v", text, failed)
	}
	text, failed, _ = callMCP(t, session, mcp.ToolFeedbackShow, map[string]any{"project": filepath.Join(other, "sub")})
	if failed || text != "No feedback for branch master in "+other+" yet.\n" {
		t.Errorf("feedback_show with project = %q, failed %v", text, failed)
	}

	opts.project = root
	session = connectMCP(t, opts)
	text, failed, _ = callMCP(t, session, mcp.ToolWalkthroughList, map[string]any{})
	if failed || text != "No walkthroughs for "+root+" yet.\n" {
		t.Errorf("walkthrough_list with --project = %q, failed %v", text, failed)
	}
	text, failed, _ = callMCP(t, session, mcp.ToolWalkthroughList, map[string]any{"project": other})
	if failed || text != "No walkthroughs for "+other+" yet.\n" {
		t.Errorf("walkthrough_list with project over --project = %q, failed %v", text, failed)
	}
}

func TestMCPFeedbackAttachmentReturnsTheScreenshot(t *testing.T) {
	root, _ := publishRepo(t)
	opts := testMCPOptions(t, root)
	thread, shot := visualThread(t, feedbackOptions{feedbackDir: opts.feedbackDir}, root)
	session := connectMCP(t, opts)
	text, _, _ := callMCP(t, session, mcp.ToolFeedbackShow, map[string]any{})
	id := strings.TrimPrefix(strings.SplitN(text, "\n", 2)[0], "# Feedback ")
	attachment := thread.Visual.Attachment.ID
	if want := "Screenshot: feedback_attachment {\"id\": \"" + id + "\", \"attachment\": \"" + attachment + "\", \"crop\": 24}\n"; !strings.Contains(text, want) {
		t.Errorf("feedback_show =\n%s\nwant %q", text, want)
	}

	image := func(result *sdk.CallToolResult) []byte {
		t.Helper()
		if result.IsError || len(result.Content) != 2 {
			t.Fatalf("feedback_attachment = %+v", result)
		}
		content, ok := result.Content[1].(*sdk.ImageContent)
		if !ok || content.MIMEType != "image/png" {
			t.Fatalf("second content = %+v", result.Content[1])
		}
		return content.Data
	}
	text, _, result := callMCP(t, session, mcp.ToolFeedbackAttachment, map[string]any{"id": id, "attachment": attachment})
	if got := image(result); !bytes.Equal(got, shot) || text != "Screenshot "+attachment+" of "+id+": 612×288" {
		t.Errorf("whole screenshot: %q, %d bytes, want %d", text, len(got), len(shot))
	}
	text, _, result = callMCP(t, session, mcp.ToolFeedbackAttachment, map[string]any{"id": id, "attachment": attachment, "crop": 24})
	cropped, err := png.DecodeConfig(bytes.NewReader(image(result)))
	if err != nil || cropped.Width != 468 || cropped.Height != 144 || !strings.Contains(text, "region 96,96 420×96 plus 24 px margin") {
		t.Errorf("cropped: %q, %+v, %v", text, cropped, err)
	}

	text, failed, _ := callMCP(t, session, mcp.ToolFeedbackAttachment, map[string]any{"id": "fb-zzzzzz", "attachment": attachment})
	if !failed || !strings.Contains(text, "docker exec -i <container> /tmp/.zero/zero mcp") {
		t.Errorf("unknown feedback = %q, failed %v", text, failed)
	}
}

func TestMCPWalkthroughTools(t *testing.T) {
	root, hash := publishRepo(t)
	opts := testMCPOptions(t, root)
	session := connectMCP(t, opts)

	var draft map[string]any
	if err := json.Unmarshal([]byte(publishDraft(t, tourDraft(root, hash))), &draft); err != nil {
		t.Fatal(err)
	}
	text, failed, result := callMCP(t, session, mcp.ToolWalkthroughPublish, draft)
	if failed || text != "published tour (created) for "+root+"\nno running zero shows this project; run: zero "+root+", then open Walkthroughs\n" {
		t.Fatalf("walkthrough_publish = %q, failed %v", text, failed)
	}
	encoded, _ := json.Marshal(result.StructuredContent)
	var structured publishResult
	if err := json.Unmarshal(encoded, &structured); err != nil || structured != (publishResult{ID: "tour", Project: root, Created: true}) {
		t.Errorf("structured = %s, %v", encoded, err)
	}
	if _, err := walkthrough.NewStore(opts.walkthroughDir).Get(root, "tour"); err != nil {
		t.Errorf("stored walkthrough: %v", err)
	}

	rejected := map[string]any{"project": root, "id": "bad", "title": "", "steps": []any{}}
	text, failed, _ = callMCP(t, session, mcp.ToolWalkthroughPublish, rejected)
	if !failed || !strings.HasPrefix(text, "invalid walkthrough:\n  ") || strings.Count(text, "\n  ") < 2 {
		t.Errorf("rejected walkthrough_publish = %q, failed %v", text, failed)
	}

	text, _, _ = callMCP(t, session, mcp.ToolWalkthroughList, map[string]any{})
	if !strings.HasPrefix(text, "tour  Tour  2 steps, updated ") {
		t.Errorf("walkthrough_list = %q", text)
	}
	text, failed, _ = callMCP(t, session, mcp.ToolWalkthroughDelete, map[string]any{"id": "tour"})
	if failed || text != "deleted walkthrough tour from "+root+"\n" {
		t.Errorf("walkthrough_delete = %q, failed %v", text, failed)
	}
	text, failed, _ = callMCP(t, session, mcp.ToolWalkthroughDelete, map[string]any{"id": "tour"})
	if !failed || !strings.HasPrefix(text, `no walkthrough "tour" for `+root) {
		t.Errorf("walkthrough_delete again = %q, failed %v", text, failed)
	}
}

func TestWalkthroughListAndDeleteCommands(t *testing.T) {
	root, hash := publishRepo(t)
	publish, _ := testPublishOptions(t, "-")
	if _, stderr, err := runPublish(t, publish, publishDraft(t, tourDraft(root, hash))); err != nil {
		t.Fatalf("publish: %v\n%s", err, stderr)
	}
	opts := walkthroughsOptions{walkthroughDir: publish.walkthroughDir, getwd: func() (string, error) { return filepath.Join(root, "sub"), nil }}

	var stdout bytes.Buffer
	if err := printWalkthroughs(opts, &stdout); err != nil || !strings.HasPrefix(stdout.String(), "tour  Tour  2 steps, updated ") {
		t.Errorf("list = %q, %v", stdout.String(), err)
	}
	asJSON := opts
	asJSON.json = true
	stdout.Reset()
	if err := printWalkthroughs(asJSON, &stdout); err != nil || !strings.HasPrefix(stdout.String(), `[{"id":"tour","title":"Tour","stepCount":2,"updatedAt":"`) {
		t.Errorf("list --json = %q, %v", stdout.String(), err)
	}
	if got, err := deleteWalkthrough(opts, "tour"); err != nil || got != root {
		t.Errorf("delete = %q, %v", got, err)
	}
	if _, err := deleteWalkthrough(opts, "tour"); err == nil || err.Error() != `no walkthrough "tour" for `+root {
		t.Errorf("delete again = %v", err)
	}
	stdout.Reset()
	if err := printWalkthroughs(opts, &stdout); err != nil || stdout.String() != "No walkthroughs for "+root+" yet.\n" {
		t.Errorf("list after delete = %q, %v", stdout.String(), err)
	}

	command := newWalkthroughCommand(publishWalkthrough)
	var names []string
	for _, sub := range command.Commands() {
		names = append(names, sub.Name())
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"delete", "list", "publish", "schema"}) {
		t.Errorf("walkthrough subcommands = %v", names)
	}
}

func TestMCPConfig(t *testing.T) {
	executable := func() (string, error) { return "/opt/my tools/zero", nil }
	for _, test := range []struct {
		opts mcpConfigOptions
		want string
	}{
		{mcpConfigOptions{}, "{\n  \"mcpServers\": {\n    \"zero\": {\n      \"command\": \"/opt/my tools/zero\",\n      \"args\": [\n        \"mcp\"\n      ]\n    }\n  }\n}\n"},
		{mcpConfigOptions{agent: "cursor", container: "dev"}, "{\n  \"mcpServers\": {\n    \"zero\": {\n      \"command\": \"docker\",\n      \"args\": [\n        \"exec\",\n        \"-i\",\n        \"dev\",\n        \"/tmp/.zero/zero\",\n        \"mcp\"\n      ]\n    }\n  }\n}\n"},
		{mcpConfigOptions{agent: "claude"}, "claude mcp add --scope user zero -- '/opt/my tools/zero' mcp\n"},
		{mcpConfigOptions{agent: "claude", container: "dev"}, "claude mcp add --scope user zero -- docker exec -i dev /tmp/.zero/zero mcp\n"},
		{mcpConfigOptions{agent: "codex"}, "[mcp_servers.zero]\ncommand = \"/opt/my tools/zero\"\nargs = [\"mcp\"]\n"},
	} {
		if got, err := mcpConfig(test.opts, executable); err != nil || got != test.want {
			t.Errorf("mcpConfig(%+v) =\n%s\nwant\n%s (%v)", test.opts, got, test.want, err)
		}
	}
	if _, err := mcpConfig(mcpConfigOptions{agent: "vim"}, executable); err == nil || err.Error() != `--agent must be claude, codex, or cursor, not "vim"` {
		t.Errorf("unknown agent: %v", err)
	}
}

// TestMCPServesOverStandardIO runs `zero mcp` as an agent does: a child
// process speaking MCP on its standard input and output, so anything else
// written to standard output would break the session.
func TestMCPServesOverStandardIO(t *testing.T) {
	root, _ := publishRepo(t)
	runtimeDir, err := os.MkdirTemp("", "zmcp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(runtimeDir) })
	command := exec.Command(os.Args[0], "mcp", "--project", filepath.Join(root, "sub"))
	command.Env = append(os.Environ(), "ZERO_CMD_TEST_EXEC=1", "XDG_CONFIG_HOME="+t.TempDir(), "XDG_CACHE_HOME="+t.TempDir(), "XDG_STATE_HOME="+t.TempDir(), "XDG_RUNTIME_DIR="+runtimeDir)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	ctx := context.Background()
	session, err := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "test"}, nil).Connect(ctx, &sdk.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatalf("connect: %v\n%s", err, stderr.String())
	}
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != 9 {
		t.Fatalf("tools/list = %+v, %v\n%s", tools, err, stderr.String())
	}
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: mcp.ToolFeedbackComment, Arguments: map[string]any{"path": "doc.md", "lines": []int{1, 2}, "message": "Split this?"}})
	if err != nil || result.IsError {
		t.Fatalf("feedback_comment = %+v, %v\n%s", result, err, stderr.String())
	}
	result, err = session.CallTool(ctx, &sdk.CallToolParams{Name: mcp.ToolFeedbackList, Arguments: map[string]any{}})
	if err != nil || result.IsError || len(result.Content) == 0 {
		t.Fatalf("feedback_list = %+v, %v", result, err)
	}
	if text, ok := result.Content[0].(*sdk.TextContent); !ok || !strings.HasSuffix(text.Text, "  master  1 thread, 0 awaiting you\n") {
		t.Errorf("feedback_list = %+v", result.Content[0])
	}
	if err := session.Close(); err != nil {
		t.Errorf("close: %v\n%s", err, stderr.String())
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q", stderr.String())
	}
}

// TestMCPAnnouncesToTheDaemon checks that MCP writes reach open windows as
// the CLI's do: through the running daemon.
func TestMCPAnnouncesToTheDaemon(t *testing.T) {
	if daemonSupported() != nil {
		t.Skip("no daemon on this platform")
	}
	root, hash := publishRepo(t)
	opts := testMCPOptions(t, root)
	fake := serveFakeDaemon(t)
	opts.socket = fake.socket
	session := connectMCP(t, opts)

	if text, failed, _ := callMCP(t, session, mcp.ToolFeedbackComment, map[string]any{"path": "doc.md", "message": "File-level."}); failed {
		t.Fatalf("feedback_comment = %q", text)
	}
	if got := <-fake.requests; !strings.HasPrefix(got, `POST /_daemon/feedback {"project":"`+root+`","id":"fb-`) || !strings.HasSuffix(got, `","author":"agent"}`) {
		t.Errorf("daemon request after comment = %s", got)
	}

	var draft map[string]any
	if err := json.Unmarshal([]byte(publishDraft(t, tourDraft(root, hash))), &draft); err != nil {
		t.Fatal(err)
	}
	if text, failed, _ := callMCP(t, session, mcp.ToolWalkthroughPublish, draft); failed {
		t.Fatalf("walkthrough_publish = %q", text)
	}
	if got := <-fake.requests; got != `POST /_daemon/walkthroughs {"project":"`+root+`","id":"tour","created":true}` {
		t.Errorf("daemon request after publish = %s", got)
	}
}
