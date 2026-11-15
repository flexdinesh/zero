package selfupdate

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCheckStale(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		checked time.Time
		want    bool
	}{
		{time.Time{}, true},
		{now.Add(-CheckPeriod), true},
		{now.Add(-CheckPeriod + time.Minute), false},
		{now.Add(time.Hour), true}, // a clock moved back
	}
	for _, test := range tests {
		if got := (Check{CheckedAt: test.checked}).Stale(now); got != test.want {
			t.Errorf("Stale(checked %v) = %v, want %v", test.checked, got, test.want)
		}
	}
}

func TestCheckRoundTripAndMalformed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zero", "update-check.json")
	if got := ReadCheck(path); got != (Check{}) {
		t.Fatalf("missing cache = %+v", got)
	}
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	if err := WriteCheck(path, Check{CheckedAt: now, Latest: "0.2.1"}); err != nil {
		t.Fatal(err)
	}
	if got := ReadCheck(path); !got.CheckedAt.Equal(now) || got.Latest != "0.2.1" {
		t.Fatalf("ReadCheck() = %+v", got)
	}
	if err := os.WriteFile(path, []byte(`{"checkedAt":"2026-11-15T12:00:00Z","latest":"$(evil)"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ReadCheck(path); got.Latest != "" {
		t.Fatalf("invalid latest kept: %+v", got)
	}
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ReadCheck(path); got != (Check{}) {
		t.Fatalf("malformed cache = %+v", got)
	}
}

func TestMarkAttemptKeepsTheLastResult(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update-check.json")
	then := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	if err := WriteCheck(path, Check{CheckedAt: then, Latest: "0.2.1"}); err != nil {
		t.Fatal(err)
	}
	now := then.Add(CheckPeriod)
	if err := MarkAttempt(path, now); err != nil {
		t.Fatal(err)
	}
	if got := ReadCheck(path); !got.CheckedAt.Equal(now) || got.Latest != "0.2.1" {
		t.Fatalf("after MarkAttempt = %+v", got)
	}
}
