package metadata

import (
	"os"
	"path/filepath"
)

const (
	envStateRoot     = "REPTTYL_STATE_ROOT"
	envRuntimeRoot   = "REPTTYL_RUNTIME_ROOT"
	envWorkspaceRoot = "REPTTYL_WORKSPACE_ROOT"
)

type Paths struct {
	StateRoot     string `json:"state_root"`
	RuntimeRoot   string `json:"runtime_root"`
	WorkspaceRoot string `json:"workspace_root"`
	MetadataFile  string `json:"metadata_file"`
}

func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}

	stateRoot := fromEnv(envStateRoot, filepath.Join(home, ".local", "share", "repttyl", "state"))
	runtimeRoot := fromEnv(envRuntimeRoot, filepath.Join(home, ".cache", "repttyl", "run"))
	workspaceRoot := fromEnv(envWorkspaceRoot, filepath.Join(home, "repttyl-workspaces"))

	return Paths{
		StateRoot:     stateRoot,
		RuntimeRoot:   runtimeRoot,
		WorkspaceRoot: workspaceRoot,
		MetadataFile:  filepath.Join(stateRoot, "workspaces.json"),
	}, nil
}

func fromEnv(name string, fallback string) string {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	return value
}
