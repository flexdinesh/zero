package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/flexdinesh/zero/internal/walkthrough"
	"github.com/flexdinesh/zero/pkg/contract"
)

// fakeBackend records what the tools asked and answers with fixed values.
type fakeBackend struct {
	show      FeedbackShowRequest
	reply     FeedbackReplyRequest
	comment   FeedbackCommentRequest
	shot      FeedbackAttachmentRequest
	draft     []byte
	listed    string
	deleted   [2]string
	publishOK bool
}

func (f *fakeBackend) FeedbackShow(_ context.Context, request FeedbackShowRequest) (FeedbackShown, error) {
	f.show = request
	if request.ID == "fb-gone00" {
		return FeedbackShown{}, errors.New("no feedback fb-gone00")
	}
	return FeedbackShown{Markdown: "# Feedback fb-3k2q8m\n", Feedback: contract.Feedback{ID: "fb-3k2q8m", Threads: []contract.FeedbackThread{}}}, nil
}

func (f *fakeBackend) FeedbackList(_ context.Context, project string) (FeedbackListed, error) {
	f.listed = project
	return FeedbackListed{Text: "fb-3k2q8m  main  1 thread, 1 awaiting you\n", Summaries: []contract.FeedbackSummary{{ID: "fb-3k2q8m"}}}, nil
}

func (f *fakeBackend) FeedbackReply(_ context.Context, request FeedbackReplyRequest) (FeedbackPosted, error) {
	f.reply = request
	return FeedbackPosted{Text: "replied to thread 2 (resolved)\n", Thread: contract.FeedbackThread{Number: 2}}, nil
}

func (f *fakeBackend) FeedbackComment(_ context.Context, request FeedbackCommentRequest) (FeedbackPosted, error) {
	f.comment = request
	return FeedbackPosted{Text: "started thread 3 at a.go:4\n", Thread: contract.FeedbackThread{Number: 3}}, nil
}

func (f *fakeBackend) FeedbackAttachment(_ context.Context, request FeedbackAttachmentRequest) (Screenshot, error) {
	f.shot = request
	return Screenshot{Text: "Screenshot at-7hq2mx4kpa", PNG: []byte("\x89PNG")}, nil
}

func (f *fakeBackend) WalkthroughPublish(_ context.Context, draft []byte) (WalkthroughPublished, error) {
	f.draft = draft
	if !f.publishOK {
		return WalkthroughPublished{}, errors.New("invalid walkthrough:\n  steps: must have at least one step\n  title: is required")
	}
	return WalkthroughPublished{Text: "published tour (created) for /p\n", Result: map[string]string{"id": "tour"}}, nil
}

func (f *fakeBackend) WalkthroughList(_ context.Context, project string) (WalkthroughsListed, error) {
	f.listed = project
	return WalkthroughsListed{Text: "No walkthroughs for /p yet.\n", Summaries: []contract.WalkthroughSummary{}}, nil
}

func (f *fakeBackend) WalkthroughDelete(_ context.Context, project, id string) (WalkthroughDeleted, error) {
	f.deleted = [2]string{project, id}
	return WalkthroughDeleted{Text: "deleted walkthrough tour from /p\n"}, nil
}

// connect serves backend in memory and returns a connected client session.
func connect(t *testing.T, backend Backend) *sdk.ClientSession {
	t.Helper()
	ctx := context.Background()
	serverTransport, clientTransport := sdk.NewInMemoryTransports()
	server := NewServer(backend, Options{Version: "test"})
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "test"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func call(t *testing.T, session *sdk.ClientSession, name string, arguments any) *sdk.CallToolResult {
	t.Helper()
	result, err := session.CallTool(context.Background(), &sdk.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		t.Fatalf("call %s: %v", name, err)
	}
	return result
}

// firstText is a result's first content block's text.
func firstText(t *testing.T, result *sdk.CallToolResult) string {
	t.Helper()
	if len(result.Content) == 0 {
		t.Fatal("result has no content")
	}
	text, ok := result.Content[0].(*sdk.TextContent)
	if !ok {
		t.Fatalf("first content is %T, not text", result.Content[0])
	}
	return text.Text
}

func TestServerListsEveryTool(t *testing.T) {
	session := connect(t, &fakeBackend{})
	result, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range result.Tools {
		names = append(names, tool.Name)
		if tool.Description == "" {
			t.Errorf("tool %s has no description", tool.Name)
		}
	}
	want := []string{ToolFeedbackAttachment, ToolFeedbackComment, ToolFeedbackList, ToolFeedbackReply, ToolFeedbackShow, ToolWalkthroughDelete, ToolWalkthroughList, ToolWalkthroughPublish, ToolWalkthroughSchema}
	slices.Sort(names)
	if !slices.Equal(names, want) {
		t.Errorf("tools = %v, want %v", names, want)
	}
	initialized := session.InitializeResult()
	if initialized == nil || initialized.ServerInfo.Name != "zero" || initialized.Capabilities.Logging != nil || initialized.Capabilities.Tools == nil {
		t.Errorf("initialize result = %+v", initialized)
	}
}

func TestWalkthroughPublishSchemaIsTheDraftSchema(t *testing.T) {
	session := connect(t, &fakeBackend{})
	result, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var want, got any
	if err := json.Unmarshal(walkthrough.Schema, &want); err != nil {
		t.Fatal(err)
	}
	for _, tool := range result.Tools {
		if tool.Name != ToolWalkthroughPublish {
			continue
		}
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatal(err)
		}
	}
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if string(wantJSON) != string(gotJSON) {
		t.Errorf("walkthrough_publish input schema differs from walkthrough.Schema")
	}
	if text := firstText(t, call(t, session, ToolWalkthroughSchema, map[string]any{})); text != string(walkthrough.Schema) {
		t.Errorf("walkthrough_schema = %.80q…", text)
	}
}

func TestFeedbackToolsPassArgumentsAndShapeResults(t *testing.T) {
	backend := &fakeBackend{}
	session := connect(t, backend)

	shown := call(t, session, ToolFeedbackShow, map[string]any{"project": "/p", "id": "fb-3k2q8m", "all": true})
	if shown.IsError || firstText(t, shown) != "# Feedback fb-3k2q8m\n" || backend.show != (FeedbackShowRequest{Project: "/p", ID: "fb-3k2q8m", All: true}) {
		t.Errorf("feedback_show = %+v, asked %+v", shown, backend.show)
	}
	structured, err := json.Marshal(shown.StructuredContent)
	if err != nil || !strings.Contains(string(structured), `"id":"fb-3k2q8m"`) {
		t.Errorf("feedback_show structured = %s, %v", structured, err)
	}

	failed := call(t, session, ToolFeedbackShow, map[string]any{"id": "fb-gone00"})
	if !failed.IsError || firstText(t, failed) != "no feedback fb-gone00" {
		t.Errorf("feedback_show error = %+v", failed)
	}

	replied := call(t, session, ToolFeedbackReply, map[string]any{"id": "fb-3k2q8m", "thread": 2, "message": "Done.", "status": "resolved", "name": "claude"})
	if replied.IsError || firstText(t, replied) != "replied to thread 2 (resolved)\n" || backend.reply != (FeedbackReplyRequest{ID: "fb-3k2q8m", Thread: 2, Message: "Done.", Status: "resolved", Name: "claude"}) {
		t.Errorf("feedback_reply = %+v, asked %+v", replied, backend.reply)
	}
	// The input schema requires id and thread.
	if missing := call(t, session, ToolFeedbackReply, map[string]any{"message": "Done."}); !missing.IsError {
		t.Errorf("feedback_reply without id and thread = %+v", missing)
	}

	commented := call(t, session, ToolFeedbackComment, map[string]any{"path": "a.go", "lines": []int{4, 6}, "message": "Why?"})
	if commented.IsError || firstText(t, commented) != "started thread 3 at a.go:4\n" || backend.comment.Path != "a.go" || !slices.Equal(backend.comment.Lines, []int{4, 6}) {
		t.Errorf("feedback_comment = %+v, asked %+v", commented, backend.comment)
	}

	listed := call(t, session, ToolFeedbackList, map[string]any{})
	if listed.IsError || backend.listed != "" || !strings.HasPrefix(firstText(t, listed), "fb-3k2q8m  main") {
		t.Errorf("feedback_list = %+v", listed)
	}
}

func TestFeedbackAttachmentReturnsAnImage(t *testing.T) {
	backend := &fakeBackend{}
	session := connect(t, backend)
	result := call(t, session, ToolFeedbackAttachment, map[string]any{"id": "fb-3k2q8m", "attachment": "at-7hq2mx4kpa", "crop": 24})
	if result.IsError || len(result.Content) != 2 {
		t.Fatalf("feedback_attachment = %+v", result)
	}
	image, ok := result.Content[1].(*sdk.ImageContent)
	if !ok || image.MIMEType != "image/png" || string(image.Data) != "\x89PNG" {
		t.Errorf("image content = %+v", result.Content[1])
	}
	if backend.shot.Crop == nil || *backend.shot.Crop != 24 {
		t.Errorf("crop asked = %v", backend.shot.Crop)
	}
	whole := call(t, session, ToolFeedbackAttachment, map[string]any{"id": "fb-3k2q8m", "attachment": "at-7hq2mx4kpa"})
	if whole.IsError || backend.shot.Crop != nil {
		t.Errorf("without crop: %+v, crop %v", whole, backend.shot.Crop)
	}
}

func TestWalkthroughToolsPassTheDraftAndListEveryProblem(t *testing.T) {
	backend := &fakeBackend{}
	session := connect(t, backend)
	draft := map[string]any{"project": "/p", "id": "tour", "unknown": true}

	// The backend's strict decoder judges the draft, so every problem shows,
	// not only the SDK's first schema error.
	rejected := call(t, session, ToolWalkthroughPublish, draft)
	if !rejected.IsError || firstText(t, rejected) != "invalid walkthrough:\n  steps: must have at least one step\n  title: is required" {
		t.Errorf("rejected publish = %+v", rejected)
	}
	var sent map[string]any
	if err := json.Unmarshal(backend.draft, &sent); err != nil || sent["unknown"] != true || sent["project"] != "/p" {
		t.Errorf("backend got draft %s, %v", backend.draft, err)
	}

	backend.publishOK = true
	published := call(t, session, ToolWalkthroughPublish, draft)
	encoded, _ := json.Marshal(published.StructuredContent)
	if published.IsError || firstText(t, published) != "published tour (created) for /p\n" || string(encoded) != `{"id":"tour"}` {
		t.Errorf("publish = %+v", published)
	}

	if listed := call(t, session, ToolWalkthroughList, map[string]any{"project": "/p"}); listed.IsError || backend.listed != "/p" {
		t.Errorf("walkthrough_list = %+v", listed)
	}
	if deleted := call(t, session, ToolWalkthroughDelete, map[string]any{"id": "tour"}); deleted.IsError || backend.deleted != [2]string{"", "tour"} {
		t.Errorf("walkthrough_delete = %+v, asked %v", deleted, backend.deleted)
	}
}
