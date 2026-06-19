package session

import (
	"context"

	"github.com/repttyl/repttyl/agent/internal/metadata"
	"github.com/repttyl/repttyl/agent/internal/terminal"
)

const Name = "main"

type Backend string

const (
	BackendTmux   Backend = "tmux"
	BackendScreen Backend = "screen"
)

type Session struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

type Manager interface {
	CheckAvailable() error
	Status(ctx context.Context, workspace metadata.Workspace) string
	ListSessions(ctx context.Context, workspace metadata.Workspace) []Session
	EnsureSession(ctx context.Context, workspace metadata.Workspace) error
	Attach(ctx context.Context, workspace metadata.Workspace, session string, cols int, rows int, onOutput func([]byte), onClose func(error)) (*terminal.Attachment, error)
	KillSession(ctx context.Context, workspace metadata.Workspace, session string) error
	NormalizeSessionName(session string) string
	ErrorCode() string
}
