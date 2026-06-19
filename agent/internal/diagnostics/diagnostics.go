package diagnostics

import (
	"os"
	"os/exec"
	"runtime"

	"github.com/repttyl/repttyl/agent/internal/metadata"
	"github.com/repttyl/repttyl/agent/internal/version"
)

type ProbeResult struct {
	AgentVersion    string         `json:"agent_version"`
	ProtocolVersion string         `json:"protocol_version"`
	GOOS            string         `json:"goos"`
	GOARCH          string         `json:"goarch"`
	Home            string         `json:"home"`
	Paths           metadata.Paths `json:"paths"`
	SessionBackend  string         `json:"session_backend"`
	TmuxPath        string         `json:"tmux_path,omitempty"`
	TmuxAvailable   bool           `json:"tmux_available"`
	ScreenPath      string         `json:"screen_path,omitempty"`
	ScreenAvailable bool           `json:"screen_available"`
}

type DoctorResult struct {
	OK     bool        `json:"ok"`
	Probe  ProbeResult `json:"probe"`
	Errors []string    `json:"errors"`
}

func Probe(paths metadata.Paths) ProbeResult {
	home, _ := os.UserHomeDir()
	tmuxPath, err := exec.LookPath("tmux")
	screenPath, screenErr := exec.LookPath("screen")

	return ProbeResult{
		AgentVersion:    version.AgentVersion,
		ProtocolVersion: version.ProtocolVersion,
		GOOS:            runtime.GOOS,
		GOARCH:          runtime.GOARCH,
		Home:            home,
		Paths:           paths,
		SessionBackend:  sessionBackend(),
		TmuxPath:        tmuxPath,
		TmuxAvailable:   err == nil,
		ScreenPath:      screenPath,
		ScreenAvailable: screenErr == nil,
	}
}

func Doctor(paths metadata.Paths) DoctorResult {
	probe := Probe(paths)
	result := DoctorResult{
		OK:     true,
		Probe:  probe,
		Errors: []string{},
	}

	if probe.SessionBackend == "screen" && !probe.ScreenAvailable {
		result.OK = false
		result.Errors = append(result.Errors, "screen is not available on PATH")
	}
	if probe.SessionBackend != "screen" && !probe.TmuxAvailable {
		result.OK = false
		result.Errors = append(result.Errors, "tmux is not available on PATH")
	}

	for _, path := range []string{paths.StateRoot, paths.RuntimeRoot, paths.WorkspaceRoot} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			result.OK = false
			result.Errors = append(result.Errors, err.Error())
		}
	}

	return result
}

func sessionBackend() string {
	if os.Getenv("REPTTYL_SESSION_BACKEND") == "screen" {
		return "screen"
	}
	return "tmux"
}
