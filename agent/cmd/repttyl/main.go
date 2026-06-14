package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/repttyl/repttyl/agent/internal/agent"
	"github.com/repttyl/repttyl/agent/internal/daemon"
	"github.com/repttyl/repttyl/agent/internal/diagnostics"
	"github.com/repttyl/repttyl/agent/internal/metadata"
	"github.com/repttyl/repttyl/agent/internal/tmux"
	"github.com/repttyl/repttyl/agent/internal/version"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) error {
	if len(args) == 0 {
		printUsage(stderr)
		return errors.New("missing command")
	}

	paths, err := metadata.DefaultPaths()
	if err != nil {
		return err
	}

	switch args[0] {
	case "agent":
		if len(args) != 2 || args[1] != "--stdio" {
			return errors.New("usage: repttyl agent --stdio")
		}
		store, err := metadata.Open(paths)
		if err != nil {
			return err
		}
		server := agent.NewServer(stdin, stdout, store, tmux.New())
		return server.Serve(context.Background())
	case "version":
		if !isJSONOnly(args[1:]) {
			return errors.New("usage: repttyl version --json")
		}
		return writeJSON(stdout, map[string]string{
			"agent_version":    version.AgentVersion,
			"protocol_version": version.ProtocolVersion,
		})
	case "doctor":
		if !isJSONOnly(args[1:]) {
			return errors.New("usage: repttyl doctor --json")
		}
		return writeJSON(stdout, diagnostics.Doctor(paths))
	case "probe":
		if !isJSONOnly(args[1:]) {
			return errors.New("usage: repttyl probe --json")
		}
		return writeJSON(stdout, diagnostics.Probe(paths))
	case "workspace":
		return runWorkspace(args[1:], stdout, paths)
	case "daemon":
		return runDaemon(args[1:], stdout, paths)
	default:
		printUsage(stderr)
		return fmt.Errorf("unknown command: %s", args[0])
	}
}

func runWorkspace(args []string, stdout io.Writer, paths metadata.Paths) error {
	if len(args) != 2 || args[0] != "list" || args[1] != "--json" {
		return errors.New("usage: repttyl workspace list --json")
	}

	store, err := metadata.Open(paths)
	if err != nil {
		return err
	}

	manager := tmux.New()
	type workspaceView struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Slug   string `json:"slug"`
		Path   string `json:"path"`
		Status string `json:"status"`
	}

	workspaces := store.List()
	views := make([]workspaceView, 0, len(workspaces))
	for _, workspace := range workspaces {
		views = append(views, workspaceView{
			ID:     workspace.ID,
			Name:   workspace.Name,
			Slug:   workspace.Slug,
			Path:   workspace.Path,
			Status: manager.Status(context.Background(), workspace),
		})
	}

	return writeJSON(stdout, map[string]any{"workspaces": views})
}

func runDaemon(args []string, stdout io.Writer, paths metadata.Paths) error {
	if len(args) == 0 {
		return errors.New("usage: repttyl daemon start|stop|status|notify")
	}

	switch args[0] {
	case "run":
		if len(args) != 1 {
			return errors.New("usage: repttyl daemon run")
		}
		return daemon.Run(context.Background(), paths)
	case "start":
		if len(args) != 1 {
			return errors.New("usage: repttyl daemon start")
		}
		return daemon.Start(paths)
	case "stop":
		if len(args) != 1 {
			return errors.New("usage: repttyl daemon stop")
		}
		err := daemon.Stop(paths)
		if errors.Is(err, daemon.ErrNotRunning) {
			return nil
		}
		return err
	case "status":
		if !isJSONOnly(args[1:]) {
			return errors.New("usage: repttyl daemon status --json")
		}
		status, err := daemon.GetStatus(paths)
		if errors.Is(err, daemon.ErrNotRunning) {
			status = daemon.Status{Running: false, Socket: daemon.SocketPath(paths)}
		} else if err != nil {
			return err
		}
		return writeJSON(stdout, status)
	case "notify":
		workspaceID, event, err := parseDaemonNotifyArgs(args[1:])
		if err != nil {
			return err
		}
		err = daemon.Notify(paths, workspaceID, event)
		if errors.Is(err, daemon.ErrNotRunning) {
			return nil
		}
		return err
	default:
		return fmt.Errorf("unknown daemon command: %s", args[0])
	}
}

func parseDaemonNotifyArgs(args []string) (string, string, error) {
	var workspaceID string
	var event string

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--workspace-id":
			if i+1 >= len(args) {
				return "", "", errors.New("usage: repttyl daemon notify --workspace-id <id> --event <event>")
			}
			workspaceID = args[i+1]
			i++
		case "--event":
			if i+1 >= len(args) {
				return "", "", errors.New("usage: repttyl daemon notify --workspace-id <id> --event <event>")
			}
			event = args[i+1]
			i++
		default:
			return "", "", fmt.Errorf("unknown daemon notify argument: %s", args[i])
		}
	}

	if workspaceID == "" || event == "" {
		return "", "", errors.New("usage: repttyl daemon notify --workspace-id <id> --event <event>")
	}
	return workspaceID, event, nil
}

func writeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func isJSONOnly(args []string) bool {
	return len(args) == 1 && args[0] == "--json"
}

func printUsage(writer io.Writer) {
	fmt.Fprintln(writer, "usage:")
	fmt.Fprintln(writer, "  repttyl agent --stdio")
	fmt.Fprintln(writer, "  repttyl version --json")
	fmt.Fprintln(writer, "  repttyl doctor --json")
	fmt.Fprintln(writer, "  repttyl probe --json")
	fmt.Fprintln(writer, "  repttyl workspace list --json")
	fmt.Fprintln(writer, "  repttyl daemon start")
	fmt.Fprintln(writer, "  repttyl daemon stop")
	fmt.Fprintln(writer, "  repttyl daemon status --json")
}
