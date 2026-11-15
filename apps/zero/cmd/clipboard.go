package cmd

import (
	"encoding/base64"
	"strings"
)

// screenChunk bounds each DCS piece sent through GNU screen, well under its
// 768-byte limit.
const screenChunk = 76

// osc52 is what to write to a terminal so it copies text to the clipboard
// (decision 0150). Plain terminals, SSH sessions, and Zellij take the OSC 52
// sequence as is. tmux takes it raw with `set-clipboard on` and wrapped in
// DCS passthrough with `allow-passthrough on`, so it gets both. GNU screen
// takes it in DCS chunks. Nothing reports whether the copy happened.
func osc52(text string, getenv func(string) string) string {
	raw := "\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte(text)) + "\a"
	switch {
	case getenv("TMUX") != "":
		return raw + "\x1bPtmux;" + strings.ReplaceAll(raw, "\x1b", "\x1b\x1b") + "\x1b\\"
	case getenv("STY") != "":
		var wrapped strings.Builder
		for start := 0; start < len(raw); start += screenChunk {
			end := min(start+screenChunk, len(raw))
			wrapped.WriteString("\x1bP" + raw[start:end] + "\x1b\\")
		}
		return wrapped.String()
	default:
		return raw
	}
}
