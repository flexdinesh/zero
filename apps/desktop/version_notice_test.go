package main

import (
	"sync"
	"testing"
	"time"

	"github.com/flexdinesh/zero/pkg/contract"
)

func TestVersionNoticeShowsOncePerConnectionAndServerBuild(t *testing.T) {
	var mu sync.Mutex
	var shown []string
	displayed := make(chan struct{}, 8)
	previous := displayNotice
	displayNotice = func(id, title, body string) error {
		mu.Lock()
		shown = append(shown, id+"|"+title+"|"+body)
		mu.Unlock()
		displayed <- struct{}{}
		return nil
	}
	t.Cleanup(func() { displayNotice = previous })
	h := &host{noticeTargets: map[string]string{}, versionNoticed: map[string]bool{}}

	older := contract.RemoteInfo{Protocol: 1, Version: "0.2.0", Name: "box"}
	h.versionNotice("r-aaaaaaaaaaaa", "box", older, "box runs zero 0.2.0")
	h.versionNotice("r-aaaaaaaaaaaa", "box", older, "box runs zero 0.2.0")
	// The server was updated, or another connection: each is told once.
	h.versionNotice("r-aaaaaaaaaaaa", "box", contract.RemoteInfo{Protocol: 1, Version: "0.2.1", Name: "box"}, "box runs zero 0.2.1")
	h.versionNotice("r-bbbbbbbbbbbb", "other", older, "other runs zero 0.2.0")

	for range 3 {
		select {
		case <-displayed:
		case <-time.After(5 * time.Second):
			t.Fatal("a notice was not shown")
		}
	}
	select {
	case <-displayed:
		t.Fatal("a repeated notice was shown")
	case <-time.After(100 * time.Millisecond):
	}
	mu.Lock()
	defer mu.Unlock()
	want := map[string]bool{
		"r-aaaaaaaaaaaa/version|box runs another zero|box runs zero 0.2.0":     true,
		"r-aaaaaaaaaaaa/version|box runs another zero|box runs zero 0.2.1":     true,
		"r-bbbbbbbbbbbb/version|other runs another zero|other runs zero 0.2.0": true,
	}
	for _, notice := range shown {
		if !want[notice] {
			t.Errorf("unexpected notice %q", notice)
		}
	}
	if got := h.noticeTargets["r-aaaaaaaaaaaa/version"]; got != "zero-app://r-aaaaaaaaaaaa/" {
		t.Errorf("click target = %q", got)
	}
}
