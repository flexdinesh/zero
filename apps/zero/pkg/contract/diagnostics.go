package contract

// DiagnosticsMode is how the server runs: the per-user daemon, a foreground
// browser server, or a server on standard input and output (a sandbox).
type DiagnosticsMode string

const (
	DiagnosticsDaemon  DiagnosticsMode = "daemon"
	DiagnosticsBrowser DiagnosticsMode = "browser"
	DiagnosticsStdio   DiagnosticsMode = "stdio"
)

// Diagnostics is GET /api/diagnostics: what a problem report says about the
// server (decision 0152). Paths and log lines are redacted: Home stands as
// ~, and connection credentials and tokens are replaced. Home is the server
// user's home directory, so a client can redact its own text the same way.
// LogsKept is false for a server that keeps no log file; LogFile is then
// empty and the lines are empty. Exposure is a RemoteExposure kind, or empty
// when the server is not exposed beyond its own transport. Protocol is the
// daemon protocol, 0 outside the daemon.
type Diagnostics struct {
	Version       string          `json:"version"`
	Commit        string          `json:"commit"`
	BuildDate     string          `json:"buildDate"`
	OS            string          `json:"os"`
	Arch          string          `json:"arch"`
	InstallMethod string          `json:"installMethod"`
	Mode          DiagnosticsMode `json:"mode"`
	Protocol      int             `json:"protocol"`
	UptimeSeconds int             `json:"uptimeSeconds"`
	Roots         int             `json:"roots"`
	Exposure      string          `json:"exposure"`
	Home          string          `json:"home"`
	LogsKept      bool            `json:"logsKept"`
	LogFile       string          `json:"logFile"`
	LogLines      []string        `json:"logLines"`
	CrashLines    []string        `json:"crashLines"`
}
