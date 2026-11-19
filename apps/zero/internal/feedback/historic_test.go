package feedback

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// storedThreads is a stored feedback file with each thread's JSON as written.
type storedThreads struct {
	ID         string            `json:"id"`
	Repository string            `json:"repository"`
	NextThread int               `json:"nextThread"`
	Threads    []json.RawMessage `json:"threads"`
}

func readStoredThreads(t *testing.T, name string) storedThreads {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var stored storedThreads
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	return stored
}

func compactJSON(t *testing.T, data []byte) string {
	t.Helper()
	var out bytes.Buffer
	if err := json.Compact(&out, data); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

// A feedback a zero before 0176 wrote keeps its ID, numbering, statuses, and
// replies through rewrites by this build, and its threads stay code threads.
func TestCodeOnlyFeedbackFromBefore0176SurvivesRewrites(t *testing.T) {
	service, _ := testService(t)
	fixtureFile := filepath.Join("..", "..", "..", "..", "testdata", "feedback", "code-only.json")
	fixture := readStoredThreads(t, fixtureFile)
	repository, id := fixture.Repository, fixture.ID
	if err := os.MkdirAll(service.store.repositoryDirectory(repository), 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(fixtureFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(service.store.file(repository, id), data, 0o600); err != nil {
		t.Fatal(err)
	}

	read, err := service.Get(repository, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Threads) != 2 || read.NextThread != 4 {
		t.Fatalf("read = %d threads, next %d; want 2, next 4", len(read.Threads), read.NextThread)
	}
	for i, want := range []struct {
		number, messages int
		status           string
	}{{1, 3, StatusResolved}, {3, 1, StatusOpen}} {
		thread := read.Threads[i]
		if thread.Number != want.number || thread.Status != want.status || len(thread.Messages) != want.messages || thread.Anchor == nil || thread.Visual != nil {
			t.Errorf("thread %d = #%d %s, %d messages, anchor %v, visual %v", i, thread.Number, thread.Status, len(thread.Messages), thread.Anchor, thread.Visual)
		}
	}

	if _, _, err := service.AddMessage(repository, id, "/home/user/markdown", NewMessage{Thread: 3, Author: AuthorAgent, Name: "codex", Body: "Added the flag."}); err != nil {
		t.Fatal(err)
	}
	_, added, err := service.AddThread(Target{Repository: repository, ID: id, Project: "/home/user/markdown"}, NewThread{Anchor: lineAnchor("code/main.go", 3, 3), Author: AuthorUser, Body: "And here."})
	if err != nil {
		t.Fatal(err)
	}
	if added.Number != 4 {
		t.Errorf("new thread = #%d, want #4: deleted thread 2's number stays used", added.Number)
	}

	rewritten := readStoredThreads(t, service.store.file(repository, id))
	if rewritten.ID != id || rewritten.NextThread != 5 || len(rewritten.Threads) != 3 {
		t.Fatalf("rewritten = %s, next %d, %d threads", rewritten.ID, rewritten.NextThread, len(rewritten.Threads))
	}
	// The untouched thread is written exactly as the old build wrote it.
	if got, want := compactJSON(t, rewritten.Threads[0]), compactJSON(t, fixture.Threads[0]); got != want {
		t.Errorf("untouched thread =\n%s\nwant\n%s", got, want)
	}
	// The replied thread keeps everything but its new message and time.
	var before, after map[string]json.RawMessage
	if err := json.Unmarshal(fixture.Threads[1], &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(rewritten.Threads[1], &after); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"number", "status", "anchor", "createdAt"} {
		if got, want := compactJSON(t, after[key]), compactJSON(t, before[key]); got != want {
			t.Errorf("replied thread's %s = %s, want %s", key, got, want)
		}
	}
	var beforeMessages, afterMessages []json.RawMessage
	if err := json.Unmarshal(before["messages"], &beforeMessages); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(after["messages"], &afterMessages); err != nil {
		t.Fatal(err)
	}
	if len(afterMessages) != 2 || compactJSON(t, afterMessages[0]) != compactJSON(t, beforeMessages[0]) {
		t.Errorf("replied thread's messages = %s", after["messages"])
	}
	for i, thread := range rewritten.Threads {
		var keys map[string]json.RawMessage
		if err := json.Unmarshal(thread, &keys); err != nil {
			t.Fatal(err)
		}
		if _, ok := keys["visual"]; ok {
			t.Errorf("thread %d gained a visual: %s", i, thread)
		}
		if _, ok := keys["anchor"]; !ok {
			t.Errorf("thread %d lost its anchor: %s", i, thread)
		}
	}
}
