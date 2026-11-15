package cmd

import (
	"encoding/base64"
	"strings"
	"testing"
)

func envOf(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

// copiedText decodes what an OSC 52 sequence asks the terminal to copy.
func copiedText(t *testing.T, sequence string) string {
	t.Helper()
	payload, ok := strings.CutPrefix(sequence, "\x1b]52;c;")
	if !ok {
		t.Fatalf("not an OSC 52 sequence: %q", sequence)
	}
	payload, ok = strings.CutSuffix(payload, "\a")
	if !ok {
		t.Fatalf("OSC 52 sequence not ended by BEL: %q", sequence)
	}
	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(decoded)
}

const copyText = "zero connect zero1:127.0.0.1:7970/abc"

func TestOSC52InAPlainTerminalCopiesTheText(t *testing.T) {
	sequence := osc52(copyText, envOf(nil))
	if got := copiedText(t, sequence); got != copyText {
		t.Errorf("copied = %q, want %q", got, copyText)
	}
}

// tmux gets the sequence raw (set-clipboard on) and through DCS passthrough
// (allow-passthrough on), ESC doubled inside.
func TestOSC52InTmuxWritesRawAndPassthrough(t *testing.T) {
	raw := osc52(copyText, envOf(nil))
	sequence := osc52(copyText, envOf(map[string]string{"TMUX": "/tmp/tmux-1000/default,1,0"}))
	wrapped, ok := strings.CutPrefix(sequence, raw)
	if !ok {
		t.Fatalf("tmux sequence %q does not start with the raw one", sequence)
	}
	inner, ok := strings.CutPrefix(wrapped, "\x1bPtmux;")
	if !ok {
		t.Fatalf("no tmux passthrough in %q", wrapped)
	}
	inner, ok = strings.CutSuffix(inner, "\x1b\\")
	if !ok {
		t.Fatalf("passthrough not ended by ST: %q", wrapped)
	}
	if got := strings.ReplaceAll(inner, "\x1b\x1b", "\x1b"); got != raw {
		t.Errorf("passthrough carries %q, want %q", got, raw)
	}
}

// GNU screen gets the sequence in DCS chunks under its 768-byte limit.
func TestOSC52InScreenWritesBoundedChunks(t *testing.T) {
	text := strings.Repeat(copyText, 10)
	raw := osc52(text, envOf(nil))
	sequence := osc52(text, envOf(map[string]string{"STY": "1234.pts-0.host"}))
	var joined strings.Builder
	chunks := strings.Split(sequence, "\x1b\\")
	if chunks[len(chunks)-1] != "" {
		t.Fatalf("screen sequence not ended by ST: %q", sequence)
	}
	for _, chunk := range chunks[:len(chunks)-1] {
		body, ok := strings.CutPrefix(chunk, "\x1bP")
		if !ok {
			t.Fatalf("chunk %q is not a DCS", chunk)
		}
		if len(chunk) > 768 {
			t.Errorf("chunk is %d bytes, over screen's limit", len(chunk))
		}
		joined.WriteString(body)
	}
	if len(chunks) < 3 {
		t.Errorf("long text sent in %d chunks", len(chunks)-1)
	}
	if joined.String() != raw {
		t.Errorf("chunks rejoin to %q, want %q", joined.String(), raw)
	}
}
