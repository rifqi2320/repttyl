package metadata

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalidWorkspaceName = errors.New("invalid workspace name")
	ErrWorkspaceExists      = errors.New("workspace already exists")
	ErrWorkspaceNotFound    = errors.New("workspace not found")
)

var (
	invalidSlugChars = regexp.MustCompile(`[^a-z0-9._-]+`)
	repeatedDash     = regexp.MustCompile(`-+`)
)

type Workspace struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	Path        string    `json:"path"`
	RuntimePath string    `json:"runtime_path"`
	CreatedAt   time.Time `json:"created_at"`
	LastUsedAt  time.Time `json:"last_used_at"`
}

type fileData struct {
	Workspaces []Workspace `json:"workspaces"`
}

type Store struct {
	mu    sync.Mutex
	paths Paths
	data  fileData
}

func Open(paths Paths) (*Store, error) {
	if err := os.MkdirAll(paths.StateRoot, 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(paths.RuntimeRoot, "workspaces"), 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(paths.WorkspaceRoot, 0o755); err != nil {
		return nil, err
	}

	store := &Store{paths: paths}
	if err := store.load(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *Store) Paths() Paths {
	return s.paths
}

func (s *Store) List() []Workspace {
	s.mu.Lock()
	defer s.mu.Unlock()

	workspaces := make([]Workspace, len(s.data.Workspaces))
	copy(workspaces, s.data.Workspaces)
	return workspaces
}

func (s *Store) Get(id string) (Workspace, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, workspace := range s.data.Workspaces {
		if workspace.ID == id {
			return workspace, true
		}
	}
	return Workspace{}, false
}

func (s *Store) Create(name string) (Workspace, error) {
	slug, err := Slugify(name)
	if err != nil {
		return Workspace{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, workspace := range s.data.Workspaces {
		if workspace.Slug == slug {
			return Workspace{}, ErrWorkspaceExists
		}
	}

	id, err := newWorkspaceID()
	if err != nil {
		return Workspace{}, err
	}

	now := time.Now().UTC()
	workspace := Workspace{
		ID:          id,
		Name:        strings.TrimSpace(name),
		Slug:        slug,
		Path:        filepath.Join(s.paths.WorkspaceRoot, slug),
		RuntimePath: filepath.Join(s.paths.RuntimeRoot, "workspaces", id),
		CreatedAt:   now,
		LastUsedAt:  now,
	}

	if err := os.MkdirAll(workspace.Path, 0o755); err != nil {
		return Workspace{}, err
	}
	if err := os.MkdirAll(workspace.RuntimePath, 0o700); err != nil {
		return Workspace{}, err
	}

	s.data.Workspaces = append(s.data.Workspaces, workspace)
	if err := s.saveLocked(); err != nil {
		return Workspace{}, err
	}
	return workspace, nil
}

func (s *Store) Touch(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.Workspaces {
		if s.data.Workspaces[i].ID == id {
			s.data.Workspaces[i].LastUsedAt = time.Now().UTC()
			return s.saveLocked()
		}
	}
	return ErrWorkspaceNotFound
}

func Slugify(name string) (string, error) {
	slug := strings.ToLower(strings.TrimSpace(name))
	slug = invalidSlugChars.ReplaceAllString(slug, "-")
	slug = repeatedDash.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, ".-_")

	if slug == "" || len(slug) > 63 {
		return "", ErrInvalidWorkspaceName
	}
	return slug, nil
}

func (s *Store) load() error {
	bytes, err := os.ReadFile(s.paths.MetadataFile)
	if errors.Is(err, os.ErrNotExist) {
		s.data = fileData{Workspaces: []Workspace{}}
		return nil
	}
	if err != nil {
		return err
	}
	if len(bytes) == 0 {
		s.data = fileData{Workspaces: []Workspace{}}
		return nil
	}
	return json.Unmarshal(bytes, &s.data)
}

func (s *Store) saveLocked() error {
	tempFile := fmt.Sprintf("%s.tmp", s.paths.MetadataFile)

	file, err := os.OpenFile(tempFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(s.data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(tempFile, s.paths.MetadataFile)
}

func newWorkspaceID() (string, error) {
	bytes := make([]byte, 8)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "ws_" + hex.EncodeToString(bytes), nil
}
