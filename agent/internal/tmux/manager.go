package tmux

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/repttyl/repttyl/agent/internal/metadata"
)

const SessionName = "main"

var lockedPrefixKeys = []string{
	"s",
	"w",
	"c",
	"\"",
	"%",
	"x",
	"d",
	"$",
	",",
	"(",
	")",
	"n",
	"p",
	"l",
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	":",
}

type Manager struct {
	binary string
	shell  string
}

func New() *Manager {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return &Manager{binary: "tmux", shell: shell}
}

func (m *Manager) CheckAvailable() error {
	_, err := exec.LookPath(m.binary)
	return err
}

func (m *Manager) SocketPath(workspace metadata.Workspace) string {
	return filepath.Join(workspace.RuntimePath, "tmux.sock")
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
	if err := m.hasSession(ctx, workspace); err == nil {
		return m.configureSession(ctx, workspace)
	}

	cmd := exec.CommandContext(
		ctx,
		m.binary,
		"-S",
		m.SocketPath(workspace),
		"new-session",
		"-d",
		"-s",
		SessionName,
		"-c",
		workspace.Path,
		m.shell,
	)
	if err := cmd.Run(); err != nil {
		return err
	}
	return m.configureSession(ctx, workspace)
}

func (m *Manager) KillSession(ctx context.Context, workspace metadata.Workspace, session string) error {
	if session == "" {
		session = SessionName
	}
	if session != SessionName {
		return errors.New("unknown tmux session")
	}

	cmd := exec.CommandContext(
		ctx,
		m.binary,
		"-S",
		m.SocketPath(workspace),
		"kill-session",
		"-t",
		session,
	)
	return cmd.Run()
}

func (m *Manager) hasSession(ctx context.Context, workspace metadata.Workspace) error {
	cmd := exec.CommandContext(
		ctx,
		m.binary,
		"-S",
		m.SocketPath(workspace),
		"has-session",
		"-t",
		SessionName,
	)
	return cmd.Run()
}

func (m *Manager) configureSession(ctx context.Context, workspace metadata.Workspace) error {
	if err := m.lockControls(ctx, workspace); err != nil {
		return err
	}
	return m.installHooks(ctx, workspace)
}

func (m *Manager) lockControls(ctx context.Context, workspace metadata.Workspace) error {
	commands := [][]string{
		{"set-option", "-gq", "status", "off"},
		{"set-option", "-gq", "prefix", "None"},
		{"unbind-key", "-q", "C-b"},
	}

	for _, key := range lockedPrefixKeys {
		commands = append(commands, []string{"unbind-key", "-q", "-T", "prefix", key})
	}

	for _, command := range commands {
		if err := m.run(ctx, workspace, command...); err != nil {
			return fmt.Errorf("configure tmux controls: %w", err)
		}
	}
	return nil
}

func (m *Manager) run(ctx context.Context, workspace metadata.Workspace, args ...string) error {
	cmdArgs := append([]string{"-S", m.SocketPath(workspace)}, args...)
	cmd := exec.CommandContext(ctx, m.binary, cmdArgs...)
	return cmd.Run()
}

func (m *Manager) installHooks(ctx context.Context, workspace metadata.Workspace) error {
	executable, err := os.Executable()
	if err != nil {
		executable = "repttyl"
	}

	command := strings.Join([]string{
		shellQuote(executable),
		"daemon",
		"notify",
		"--workspace-id",
		shellQuote(workspace.ID),
		"--event",
		"session-closed",
	}, " ")

	cmd := exec.CommandContext(
		ctx,
		m.binary,
		"-S",
		m.SocketPath(workspace),
		"set-hook",
		"-g",
		"session-closed",
		"run-shell -b "+shellQuote(command),
	)
	return cmd.Run()
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
