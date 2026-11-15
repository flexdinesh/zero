package cmd

import "testing"

func TestLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{"localhost": true, "LOCALHOST": true, "127.0.0.1": true, "127.1.2.3": true, "::1": true, "10.0.0.5": false, "0.0.0.0": false, "::": false} {
		if got := loopbackHost(host); got != want {
			t.Errorf("loopbackHost(%q) = %t, want %t", host, got, want)
		}
	}
}

// Every URL the CLI opens names its project, so the page skips choosing one
// (decision 0153).
func TestProjectURLNamesTheProject(t *testing.T) {
	base := serverURL("127.0.0.1", 7971)
	if got, want := projectURL(base, "/home/dee/my project"), "http://127.0.0.1:7971/?project=%2Fhome%2Fdee%2Fmy+project"; got != want {
		t.Errorf("projectURL() = %q, want %q", got, want)
	}
	if got := projectURL(base, ""); got != base {
		t.Errorf("projectURL(no project) = %q, want %q", got, base)
	}
}

func TestHyperlinkFramesOnlyTerminals(t *testing.T) {
	const link = "zero://r-0123456789ab/"
	if got := hyperlink(link, false); got != link {
		t.Errorf("hyperlink(tty=false) = %q", got)
	}
	if got, want := hyperlink(link, true), "\x1b]8;;"+link+"\x1b\\"+link+"\x1b]8;;\x1b\\"; got != want {
		t.Errorf("hyperlink(tty=true) = %q, want %q", got, want)
	}
}
