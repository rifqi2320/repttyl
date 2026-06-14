package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/repttyl/repttyl/agent/internal/metadata"
	"github.com/repttyl/repttyl/agent/internal/tmux"
)

func TestServerHello(t *testing.T) {
	store := newTestStore(t)
	input := strings.NewReader(`{"id":1,"op":"hello","client_version":"test"}` + "\n")
	output := &bytes.Buffer{}

	server := NewServer(input, output, store, tmux.New())
	if err := server.Serve(context.Background()); err != nil {
		t.Fatalf("Serve returned error: %v", err)
	}

	var response map[string]any
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if response["ok"] != true {
		t.Fatalf("ok = %v, want true", response["ok"])
	}
	if response["agent_version"] == "" {
		t.Fatal("agent_version should be present")
	}
}

func TestServerWorkspaceList(t *testing.T) {
	store := newTestStore(t)
	if _, err := store.Create("default"); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	input := strings.NewReader(`{"id":2,"op":"workspace.list"}` + "\n")
	output := &bytes.Buffer{}

	server := NewServer(input, output, store, tmux.New())
	if err := server.Serve(context.Background()); err != nil {
		t.Fatalf("Serve returned error: %v", err)
	}

	var response struct {
		OK         bool            `json:"ok"`
		Workspaces []WorkspaceView `json:"workspaces"`
	}
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if !response.OK {
		t.Fatal("ok = false, want true")
	}
	if len(response.Workspaces) != 1 {
		t.Fatalf("len(workspaces) = %d, want 1", len(response.Workspaces))
	}
	if response.Workspaces[0].Name != "default" {
		t.Fatalf("workspace name = %q, want default", response.Workspaces[0].Name)
	}
}

func newTestStore(t *testing.T) *metadata.Store {
	t.Helper()

	root := t.TempDir()
	paths := metadata.Paths{
		StateRoot:     filepath.Join(root, "state"),
		RuntimeRoot:   filepath.Join(root, "run"),
		WorkspaceRoot: filepath.Join(root, "workspaces"),
		MetadataFile:  filepath.Join(root, "state", "workspaces.json"),
	}

	store, err := metadata.Open(paths)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	return store
}
