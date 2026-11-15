package connection

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func TestInviteRoundTripsProjects(t *testing.T) {
	endpoint := TLS{Hosts: []string{"10.0.0.5", "2001:db8::1"}, Port: 7971, Credential: testCredential()}
	for _, project := range []string{
		"",
		"/",
		"/home/dee/workspace/arto",
		"/home/dee/my project",
		"/home/dee/it's $HOME & more",
		"/home/dee/naïve/日本",
		"/srv/back\\slash/100%",
	} {
		invite := Invite{Endpoint: endpoint, Project: project}
		for _, text := range []string{invite.Format(), invite.Shell()} {
			parsed, err := ParseInvite(text)
			if err != nil {
				t.Fatalf("ParseInvite(%q) = %v", text, err)
			}
			if parsed.Project != project || parsed.Endpoint.Port != 7971 || parsed.Endpoint.Credential != endpoint.Credential || strings.Join(parsed.Endpoint.Hosts, " ") != strings.Join(endpoint.Hosts, " ") {
				t.Errorf("ParseInvite(%q) = %+v, want project %q", text, parsed, project)
			}
		}
	}
}

func TestInviteWithoutProjectIsTheConnectionString(t *testing.T) {
	endpoint := TLS{Hosts: []string{"10.0.0.5"}, Port: 7971, Credential: testCredential()}
	invite := Invite{Endpoint: endpoint}
	if invite.Format() != endpoint.Format() || invite.Shell() != endpoint.Shell() {
		t.Errorf("Invite without a project = %q, want %q", invite.Format(), endpoint.Format())
	}
	if parsed, err := ParseInvite(endpoint.Format()); err != nil || parsed.Project != "" || parsed.Endpoint.Credential != endpoint.Credential {
		t.Errorf("ParseInvite(old string) = %+v, %v", parsed, err)
	}
}

// A pasted string with a project reaches argv unchanged.
func TestInviteShellWordReachesArgvUnchanged(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	invite := Invite{Endpoint: TLS{Hosts: []string{"2001:db8::1"}, Port: 7971, Credential: testCredential()}, Project: "/home/dee/it's $HOME & `x` (y) *"}
	out, err := exec.Command(sh, "-c", "printf %s "+invite.Shell()).Output()
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != invite.Format() {
		t.Errorf("sh read %q, want %q", out, invite.Format())
	}
}

func TestInviteToleratesTerminalWrapping(t *testing.T) {
	invite := Invite{Endpoint: TLS{Hosts: []string{"10.0.0.5"}, Port: 7971, Credential: testCredential()}, Project: "/home/dee/workspace/arto"}
	text := invite.Shell()
	wrapped := "  " + text[:30] + "\n  " + text[30:] + "\n"
	if parsed, err := ParseInvite(wrapped); err != nil || parsed.Project != invite.Project {
		t.Errorf("ParseInvite(wrapped) = %+v, %v", parsed, err)
	}
}

func TestParseInviteRejects(t *testing.T) {
	base := TLS{Hosts: []string{"10.0.0.5"}, Port: 7971, Credential: testCredential()}.Format()
	for _, text := range []string{
		"",
		base[:len(base)-2] + "/home",
		base + "//",
		base + "/home//dee",
		base + "/home/../etc",
		base + "/home/./dee",
		base + "/home/%2F",
		base + "/home/%00",
		base + "/home/%zz",
		base + "/home/dee/",
	} {
		if parsed, err := ParseInvite(text); !errors.Is(err, ErrInvalid) {
			t.Errorf("ParseInvite(%q) = %+v, %v, want ErrInvalid", text, parsed, err)
		}
	}
}

func TestInviteWebURLOpensTheProject(t *testing.T) {
	endpoint := TLS{Hosts: []string{"10.0.0.5"}, Port: 7971, Credential: testCredential()}
	got, err := Invite{Endpoint: endpoint, Project: "/home/dee/my project"}.WebURL()
	if err != nil {
		t.Fatal(err)
	}
	want := "https://10.0.0.5:7971/?token=" + endpoint.Credential.TokenText() + "&project=%2Fhome%2Fdee%2Fmy+project"
	if got != want {
		t.Errorf("WebURL() = %q, want %q", got, want)
	}
	if got, _ := (Invite{Endpoint: endpoint}).WebURL(); got != "https://10.0.0.5:7971/?token="+endpoint.Credential.TokenText() {
		t.Errorf("WebURL() without a project = %q", got)
	}
}
