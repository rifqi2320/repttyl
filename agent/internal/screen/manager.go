package screen

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/repttyl/repttyl/agent/internal/metadata"
	"github.com/repttyl/repttyl/agent/internal/session"
	"github.com/repttyl/repttyl/agent/internal/terminal"
)

const SessionName = session.Name

type Manager struct {
	binary string
	shell  string
}

func New() *Manager {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return &Manager{binary: "screen", shell: shell}
}

func (m *Manager) CheckAvailable() error {
	_, err := exec.LookPath(m.binary)
	return err
}

func (m *Manager) Status(ctx context.Context, workspace metadata.Workspace) string {
	if err := m.CheckAvailable(); err != nil {
		return "unavailable"
	}
	if err := m.hasSession(ctx, workspace); err != nil {
		return "stopped"
	}
	return "running"
}

func (m *Manager) ListSessions(ctx context.Context, workspace metadata.Workspace) []session.Session {
	return []session.Session{
		{
			Name:   SessionName,
			Status: m.Status(ctx, workspace),
		},
	}
}

func (m *Manager) EnsureSession(ctx context.Context, workspace metadata.Workspace) error {
	if err := m.CheckAvailable(); err != nil {
		return err
	}
	if err := os.MkdirAll(workspace.RuntimePath, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(workspace.Path, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(m.screenDir(workspace), 0o700); err != nil {
		return err
	}
	if err := os.Chmod(m.screenDir(workspace), 0o700); err != nil {
		return err
	}
	if err := m.hasSession(ctx, workspace); err == nil {
		return nil
	}

	cmd := exec.CommandContext(
		ctx,
		m.binary,
		"-dmS",
		m.screenName(workspace),
		"-c",
		"/dev/null",
		"-T",
		"xterm-256color",
		m.shell,
	)
	cmd.Dir = workspace.Path
	cmd.Env = m.env(workspace)
	if output, err := cmd.CombinedOutput(); err != nil {
		return commandError(err, output)
	}
	return m.waitForSession(ctx, workspace)
}

func (m *Manager) Attach(
	ctx context.Context,
	workspace metadata.Workspace,
	sessionName string,
	cols int,
	rows int,
	onOutput func([]byte),
	onClose func(error),
) (*terminal.Attachment, error) {
	return terminal.AttachCommand(
		ctx,
		m.binary,
		[]string{"-x", m.screenName(workspace)},
		m.env(workspace),
		workspace.Path,
		cols,
		rows,
		onOutput,
		onClose,
	)
}

func (m *Manager) KillSession(ctx context.Context, workspace metadata.Workspace, sessionName string) error {
	if sessionName == "" {
		sessionName = SessionName
	}
	if sessionName != SessionName {
		return errors.New("unknown screen session")
	}

	cmd := exec.CommandContext(ctx, m.binary, "-S", m.screenName(workspace), "-X", "quit")
	cmd.Env = m.env(workspace)
	output, err := cmd.CombinedOutput()
	if err := commandError(err, output); err != nil {
		return err
	}
	_ = os.RemoveAll(m.screenDir(workspace))
	return nil
}

func (m *Manager) NormalizeSessionName(sessionName string) string {
	if sessionName == "" {
		return SessionName
	}
	return sessionName
}

func (m *Manager) ErrorCode() string {
	return "SCREEN_ERROR"
}

func (m *Manager) hasSession(ctx context.Context, workspace metadata.Workspace) error {
	cmd := exec.CommandContext(ctx, m.binary, "-ls", m.screenName(workspace))
	cmd.Env = m.env(workspace)
	output, err := cmd.CombinedOutput()
	return commandError(err, output)
}

func (m *Manager) waitForSession(ctx context.Context, workspace metadata.Workspace) error {
	var lastErr error
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := m.hasSession(ctx, workspace); err == nil {
			return nil
		} else {
			lastErr = err
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	return lastErr
}

func (m *Manager) screenName(workspace metadata.Workspace) string {
	return "repttyl_" + workspace.ID
}

func (m *Manager) screenDir(workspace metadata.Workspace) string {
	sum := sha256.Sum256([]byte(workspace.RuntimePath))
	return filepath.Join(os.TempDir(), "repttyl-screen-"+hex.EncodeToString(sum[:8]))
}

func (m *Manager) env(workspace metadata.Workspace) []string {
	return append(os.Environ(), "SCREENDIR="+m.screenDir(workspace), "TERM=xterm-256color")
}

func commandError(err error, output []byte) error {
	if err == nil {
		return nil
	}
	message := strings.TrimSpace(string(output))
	if message == "" {
		return err
	}
	return fmt.Errorf("%w: %s", err, message)
}
