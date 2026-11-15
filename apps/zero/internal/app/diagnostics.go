package app

import (
	"os"
	goruntime "runtime"
	"time"

	"github.com/flexdinesh/zero/internal/version"
	"github.com/flexdinesh/zero/pkg/contract"
	"github.com/flexdinesh/zero/pkg/logfile"
)

// diagnosticsLines is how many of the newest log lines a report carries.
const diagnosticsLines = 200

// ServerInfo describes the running server for problem reports (decision
// 0151); its zero value is a foreground browser server that keeps no log.
type ServerInfo struct {
	// Mode is how the server runs; empty is DiagnosticsBrowser.
	Mode contract.DiagnosticsMode
	// Protocol is the daemon protocol; 0 outside the daemon.
	Protocol int
	// LogFile and CrashFile are the server's persistent log and crash
	// output; "" keeps none.
	LogFile, CrashFile string
	// InstallMethod names how zero was installed; nil reports none. It may
	// be slow, so it runs only when a report asks.
	InstallMethod func() string
	// Exposure names the exposure serving beyond the server's own transport,
	// or ""; nil means none.
	Exposure func() string
}

// Diagnostics answers what a problem report says about the server. It is
// safe for concurrent use.
type Diagnostics struct {
	state   *state
	started time.Time
	home    func() (string, error)
}

// Report describes the server now, with its newest log lines redacted. A
// log that cannot be read leaves its lines empty.
func (d *Diagnostics) Report() contract.Diagnostics {
	info := d.state.config.Server
	mode := info.Mode
	if mode == "" {
		mode = contract.DiagnosticsBrowser
	}
	home, _ := d.home()
	number, commit, date := version.Details()
	report := contract.Diagnostics{
		Version:       number,
		Commit:        commit,
		BuildDate:     date,
		OS:            goruntime.GOOS,
		Arch:          goruntime.GOARCH,
		Mode:          mode,
		Protocol:      info.Protocol,
		UptimeSeconds: int(time.Since(d.started).Seconds()),
		Roots:         len(d.state.config.Roots.List()),
		Home:          home,
		LogsKept:      info.LogFile != "",
		LogLines:      []string{},
		CrashLines:    []string{},
	}
	if info.InstallMethod != nil {
		report.InstallMethod = info.InstallMethod()
	}
	if info.Exposure != nil {
		report.Exposure = info.Exposure()
	}
	if info.LogFile != "" {
		report.LogFile = logfile.Redact(info.LogFile, home)
		if lines, err := logfile.Tail(info.LogFile, diagnosticsLines); err == nil && lines != nil {
			report.LogLines = logfile.RedactLines(lines, home)
		}
	}
	if info.CrashFile != "" {
		if lines, err := logfile.Tail(info.CrashFile, diagnosticsLines); err == nil && lines != nil {
			report.CrashLines = logfile.RedactLines(lines, home)
		}
	}
	return report
}

func newDiagnostics(shared *state) *Diagnostics {
	return &Diagnostics{state: shared, started: time.Now(), home: os.UserHomeDir}
}
