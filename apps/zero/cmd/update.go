package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/flexdinesh/zero/internal/selfupdate"
	"github.com/flexdinesh/zero/internal/version"
	"github.com/spf13/cobra"
)

// `zero update` (decision 0147): an install.sh install re-runs install.sh
// from the latest release's tag, so the desktop app, the ownership record,
// and the daemon stop stay its job. Other installs get instructions.

const (
	installScript    = "https://raw.githubusercontent.com/flexdinesh/zero/main/scripts/install.sh"
	installDevScript = "https://raw.githubusercontent.com/flexdinesh/zero/main/scripts/install-dev.sh"
	// updateNoticeAnnotation marks the commands that show the update notice.
	updateNoticeAnnotation = "zero.updateNotice"
	// refreshTimeout bounds the notice's background look for a release.
	refreshTimeout = 3 * time.Second
)

// errNotUpdated is returned after instructions are printed for an install
// `zero update` cannot update.
var errNotUpdated = errors.New("zero was not updated")

type updateOptions struct {
	cliName cliName
	check   bool
	cliOnly bool
	refresh bool
}

// updateDeps are the effects `zero update` and its notice use; tests replace
// them.
type updateDeps struct {
	current   string
	detect    func() selfupdate.Method
	latest    func(context.Context) (string, error)
	download  func(ctx context.Context, url, dst string) error
	run       func(ctx context.Context, script string, args []string, stdin io.Reader, stdout, stderr io.Writer) error
	checkPath func() (string, error)
	now       func() time.Time
	getenv    func(string) string
	terminal  func(io.Writer) bool
	spawn     func() error
}

func defaultUpdateDeps() updateDeps {
	releases := selfupdate.Releases{UserAgent: "zero/" + version.Number()}
	return updateDeps{
		current:   version.Number(),
		detect:    detectInstall,
		latest:    releases.Latest,
		download:  downloadFile,
		run:       runInstallScript,
		checkPath: selfupdate.DefaultCheckPath,
		now:       time.Now,
		getenv:    os.Getenv,
		terminal:  isTerminal,
		spawn:     spawnRefresh,
	}
}

func newUpdateCommand() *cobra.Command {
	var opts updateOptions
	command := &cobra.Command{
		Use:           "update",
		Short:         "Update zero to the latest release",
		Long:          "Update zero to the latest release.\nAn install.sh install runs install.sh again, from the latest release; other installs print how to update.\nSet ZERO_NO_UPDATE_CHECK=1 to hide the daily update notice.",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(command *cobra.Command, _ []string) error {
			opts.cliName = cliName(command.Root().Name())
			return runUpdate(command.Context(), opts, command.InOrStdin(), command.OutOrStdout(), command.ErrOrStderr(), defaultUpdateDeps())
		},
	}
	command.Flags().BoolVar(&opts.check, "check", false, "only report whether a newer release exists")
	command.Flags().BoolVar(&opts.cliOnly, "cli-only", false, "update the CLI alone, leaving the desktop app as it is")
	command.Flags().BoolVar(&opts.refresh, "refresh", false, "refresh the update notice's cache")
	_ = command.Flags().MarkHidden("refresh")
	return command
}

func runUpdate(ctx context.Context, opts updateOptions, stdin io.Reader, stdout, stderr io.Writer, deps updateDeps) error {
	if opts.refresh {
		refreshCheck(ctx, deps)
		return nil
	}
	name := opts.cliName
	method := deps.detect()
	switch method.Kind {
	case selfupdate.KindScript:
	case selfupdate.KindDev:
		_, _ = fmt.Fprintf(stdout, "zero %s was built from source. Build a branch or commit again with:\n  curl -fsSL %s | sh -s -- --ref <branch-or-commit>%s\nor install the latest release with:\n  %s\n",
			deps.current, installDevScript, name.nameArg(), name.installCommand())
		return notUpdated(opts)
	case selfupdate.KindBundled:
		_, _ = fmt.Fprintln(stdout, "this zero is bundled inside the desktop app; run `zero update` with the zero on your PATH")
		return notUpdated(opts)
	default:
		_, _ = fmt.Fprintln(stdout, methodAdvice(method, name))
		return notUpdated(opts)
	}

	latest, err := deps.latest(ctx)
	if err != nil {
		return err
	}
	if path, err := deps.checkPath(); err == nil {
		_ = selfupdate.WriteCheck(path, selfupdate.Check{CheckedAt: deps.now(), Latest: latest})
	}
	if !selfupdate.Newer(latest, deps.current) {
		_, _ = fmt.Fprintf(stdout, "zero %s is up to date\n", deps.current)
		return nil
	}
	if opts.check {
		_, _ = fmt.Fprintf(stdout, "zero %s is available (current %s); run `%s update`\n", latest, deps.current, name)
		return nil
	}

	directory, err := os.MkdirTemp("", "zero-update-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(directory) }()
	script := filepath.Join(directory, "install.sh")
	url := selfupdate.InstallScriptURL(latest)
	_, _ = fmt.Fprintf(stdout, "updating zero %s to %s with %s\n", deps.current, latest, url)
	if err := deps.download(ctx, url, script); err != nil {
		return fmt.Errorf("download install.sh for zero %s: %w", latest, err)
	}
	var args []string
	if opts.cliOnly || !method.Desktop {
		args = append(args, "--cli-only")
	}
	if err := deps.run(ctx, script, args, stdin, stdout, stderr); err != nil {
		if method.Desktop && !opts.cliOnly {
			return fmt.Errorf("install.sh failed: %w\nif the zero desktop app is running, quit it and run `%s update` again, or update the CLI alone with `%s update --cli-only`", err, name, name)
		}
		return fmt.Errorf("install.sh failed: %w", err)
	}
	return nil
}

// notUpdated: --check only reports, so it succeeds.
func notUpdated(opts updateOptions) error {
	if opts.check {
		return nil
	}
	return errNotUpdated
}

// methodAdvice says how to update an install `zero update` does not own.
func methodAdvice(method selfupdate.Method, name cliName) string {
	switch method.Kind {
	case selfupdate.KindManaged:
		return fmt.Sprintf("zero was installed by %s; update it with %s", method.Manager, method.Manager)
	case selfupdate.KindGoInstall:
		return "zero was built with go install, which zero does not support; install the latest release with:\n  " + name.installCommand()
	default:
		return "zero was not installed by install.sh, so it cannot update itself; install the latest release with:\n  " + name.installCommand()
	}
}

// installCommand is the stable install command for this CLI name.
func (name cliName) installCommand() string {
	command := "curl -fsSL " + installScript + " | sh"
	if args := name.nameArg(); args != "" {
		command += " -s --" + args
	}
	return command
}

// nameArg is the installer's --name argument for a non-canonical name.
func (name cliName) nameArg() string {
	if name.String() == "zero" {
		return ""
	}
	return " --name " + name.String()
}

// updateNotice prints a one-line notice when the cache knows a newer release,
// and starts a background refresh when the cache is stale. It never waits on
// the network.
func updateNotice(command *cobra.Command, deps updateDeps) {
	if !showsUpdateNotice(command) {
		return
	}
	stderr := command.ErrOrStderr()
	if !deps.terminal(stderr) || deps.getenv("CI") != "" || deps.getenv("ZERO_NO_UPDATE_CHECK") != "" {
		return
	}
	if _, release := selfupdate.ParseRelease(deps.current); !release {
		return
	}
	path, err := deps.checkPath()
	if err != nil {
		return
	}
	check := selfupdate.ReadCheck(path)
	now := deps.now()
	if check.Stale(now) && selfupdate.MarkAttempt(path, now) == nil {
		_ = deps.spawn()
	}
	if !selfupdate.Newer(check.Latest, deps.current) {
		return
	}
	name := cliName(command.Root().Name())
	method := deps.detect()
	switch method.Kind {
	case selfupdate.KindDev, selfupdate.KindBundled:
		return
	case selfupdate.KindScript:
		_, _ = fmt.Fprintf(stderr, "zero %s is available (current %s); run `%s update`\n", check.Latest, deps.current, name)
	case selfupdate.KindManaged:
		_, _ = fmt.Fprintf(stderr, "zero %s is available (current %s); update it with %s\n", check.Latest, deps.current, method.Manager)
	default:
		_, _ = fmt.Fprintf(stderr, "zero %s is available (current %s); run `%s update` for how to update\n", check.Latest, deps.current, name)
	}
}

// showsUpdateNotice: the command, or the nearest ancestor below the root
// that is annotated, asks for the notice; the root asks for itself only.
func showsUpdateNotice(command *cobra.Command) bool {
	for current := command; current != nil; current = current.Parent() {
		if _, ok := current.Annotations[updateNoticeAnnotation]; ok {
			return true
		}
		if current.Parent() != nil && current.Parent().Parent() == nil {
			return false
		}
	}
	return false
}

// withUpdateNotice annotates command to show the update notice.
func withUpdateNotice(command *cobra.Command) *cobra.Command {
	if command.Annotations == nil {
		command.Annotations = map[string]string{}
	}
	command.Annotations[updateNoticeAnnotation] = "show"
	return command
}

func refreshCheck(ctx context.Context, deps updateDeps) {
	path, err := deps.checkPath()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, refreshTimeout)
	defer cancel()
	latest, err := deps.latest(ctx)
	if err != nil {
		return
	}
	_ = selfupdate.WriteCheck(path, selfupdate.Check{CheckedAt: deps.now(), Latest: latest})
}

// detectInstall inspects the running binary and install.sh's record.
func detectInstall() selfupdate.Method {
	environment := selfupdate.Environment{
		Version:       version.Number(),
		InstallMethod: version.InstallMethod,
		GoInstall:     version.Version == "dev" && version.Number() != "dev",
	}
	if executable, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			environment.Executable = resolved
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		environment.Home = home
		environment.ConfigDir = selfupdate.ConfigDir(runtime.GOOS, os.Getenv, home)
	}
	return selfupdate.Detect(environment)
}

// spawnRefresh starts `zero update --refresh` detached, holding nothing of
// this process.
func spawnRefresh() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	process := exec.Command(executable, "update", "--refresh")
	process.Dir = "/"
	process.Env = append(os.Environ(), "ZERO_NO_UPDATE_CHECK=1")
	process.Stdin, process.Stdout, process.Stderr = null, null, null
	process.SysProcAttr = daemonProcAttr()
	closeInheritedOnExec()
	if err := process.Start(); err != nil {
		return err
	}
	return process.Process.Release()
}

func downloadFile(ctx context.Context, url, dst string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "zero/"+version.Number())
	client := http.Client{Timeout: 60 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, response.Status)
	}
	file, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, io.LimitReader(response.Body, 4<<20)); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func runInstallScript(ctx context.Context, script string, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	process := exec.CommandContext(ctx, "sh", append([]string{script}, args...)...)
	process.Stdin, process.Stdout, process.Stderr = stdin, stdout, stderr
	return process.Run()
}
