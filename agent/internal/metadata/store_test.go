package metadata

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestSlugify(t *testing.T) {
	tests := map[string]string{
		"api":             "api",
		"API Server":      "api-server",
		"  infra.shell  ": "infra.shell",
		"billing_worker!": "billing_worker",
		"release/canary":  "release-canary",
	}

	for input, expected := range tests {
		actual, err := Slugify(input)
		if err != nil {
			t.Fatalf("Slugify(%q) returned error: %v", input, err)
		}
		if actual != expected {
			t.Fatalf("Slugify(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestSlugifyRejectsEmptyNames(t *testing.T) {
	if _, err := Slugify(" !!! "); !errors.Is(err, ErrInvalidWorkspaceName) {
		t.Fatalf("expected ErrInvalidWorkspaceName, got %v", err)
	}
}

func TestStoreCreatePersistsWorkspace(t *testing.T) {
	root := t.TempDir()
	paths := Paths{
		StateRoot:     filepath.Join(root, "state"),
		RuntimeRoot:   filepath.Join(root, "run"),
		WorkspaceRoot: filepath.Join(root, "workspaces"),
		MetadataFile:  filepath.Join(root, "state", "workspaces.json"),
	}

	store, err := Open(paths)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}

	workspace, err := store.Create("API Server")
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if workspace.ID == "" {
		t.Fatal("workspace ID should be generated")
	}
	if workspace.Slug != "api-server" {
		t.Fatalf("workspace slug = %q, want api-server", workspace.Slug)
	}

	reopened, err := Open(paths)
	if err != nil {
		t.Fatalf("reopen returned error: %v", err)
	}

	workspaces := reopened.List()
	if len(workspaces) != 1 {
		t.Fatalf("len(workspaces) = %d, want 1", len(workspaces))
	}
	if workspaces[0].ID != workspace.ID {
		t.Fatalf("persisted workspace ID = %q, want %q", workspaces[0].ID, workspace.ID)
	}
}

func TestStoreCreateRejectsDuplicateSlug(t *testing.T) {
	root := t.TempDir()
	paths := Paths{
		StateRoot:     filepath.Join(root, "state"),
		RuntimeRoot:   filepath.Join(root, "run"),
		WorkspaceRoot: filepath.Join(root, "workspaces"),
		MetadataFile:  filepath.Join(root, "state", "workspaces.json"),
	}

	store, err := Open(paths)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	if _, err := store.Create("API Server"); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if _, err := store.Create("api-server"); !errors.Is(err, ErrWorkspaceExists) {
		t.Fatalf("expected ErrWorkspaceExists, got %v", err)
	}
}
