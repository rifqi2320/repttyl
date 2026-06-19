package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCLICommandMode(t *testing.T) {
	bin := buildCLI(t)
	env := testEnv(t)

	version := runCLI(t, bin, env, "version", "--json")
	assertJSONField(t, version.stdout, "agent_version", "0.1.2-rc.10")
	assertJSONField(t, version.stdout, "protocol_version", "0.1")

	probe := runCLI(t, bin, env, "probe", "--json")
	_, tmuxErr := exec.LookPath("tmux")
	assertJSONField(t, probe.stdout, "tmux_available", tmuxErr == nil)

	doctor := runCLI(t, bin, env, "doctor", "--json")
	assertJSONField(t, doctor.stdout, "ok", tmuxErr == nil)

	daemonStatus := runCLI(t, bin, env, "daemon", "status", "--json")
	assertJSONField(t, daemonStatus.stdout, "running", false)

	list := runCLI(t, bin, env, "workspace", "list", "--json")
	var listed struct {
		Workspaces []any `json:"workspaces"`
	}
	if err := json.Unmarshal([]byte(list.stdout), &listed); err != nil {
		t.Fatalf("workspace list output is not JSON: %v\n%s", err, list.stdout)
	}
	if len(listed.Workspaces) != 0 {
		t.Fatalf("workspace list returned %d workspaces, want 0", len(listed.Workspaces))
	}
}

func TestCLIRejectsInvalidUsage(t *testing.T) {
	bin := buildCLI(t)
	env := testEnv(t)

	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "missing command", args: []string{}, want: "missing command"},
		{name: "version requires json", args: []string{"version"}, want: "usage: repttyl version --json"},
		{name: "doctor requires json", args: []string{"doctor"}, want: "usage: repttyl doctor --json"},
		{name: "probe requires json", args: []string{"probe"}, want: "usage: repttyl probe --json"},
		{name: "workspace list requires json", args: []string{"workspace", "list"}, want: "usage: repttyl workspace list --json"},
		{name: "daemon status requires json", args: []string{"daemon", "status"}, want: "usage: repttyl daemon status --json"},
		{name: "unknown command", args: []string{"unknown"}, want: "unknown command: unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := runCLIExpectError(t, bin, env, tt.args...)
			if !strings.Contains(result.stderr, tt.want) {
				t.Fatalf("stderr = %q, want substring %q", result.stderr, tt.want)
			}
		})
	}
}

func TestCLIAgentProtocolEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not available on PATH")
	}

	bin := buildCLI(t)
	env := testEnv(t)
	agent := startAgent(t, bin, env)
	defer agent.close(t)

	agent.send(t, `{"id":1,"op":"hello","client_version":"cli-integration-test"}`)
	hello := agent.readID(t, "1")
	requireOK(t, hello, true)
	requireField(t, hello, "agent_version", "0.1.2-rc.10")

	agent.send(t, `{"id":2,"op":"workspace.list"}`)
	initialList := agent.readID(t, "2")
	requireOK(t, initialList, true)
	requireArrayLen(t, initialList, "workspaces", 0)

	agent.send(t, `{"id":3,"op":"workspace.create","name":"API Server"}`)
	created := agent.readID(t, "3")
	requireOK(t, created, true)
	workspace := requireObject(t, created, "workspace")
	workspaceID := requireString(t, workspace, "id")
	workspacePath := requireString(t, workspace, "path")
	runtimePath := requireString(t, workspace, "runtime_path")
	requireField(t, workspace, "name", "API Server")
	requireField(t, workspace, "slug", "api-server")
	requireTmuxOption(t, filepath.Join(runtimePath, "tmux.sock"), "status", "off")
	requireTmuxOption(t, filepath.Join(runtimePath, "tmux.sock"), "prefix", "None")
	requireTmuxOption(t, filepath.Join(runtimePath, "tmux.sock"), "default-terminal", expectedTmuxDefaultTerminal())
	requireTmuxOption(t, filepath.Join(runtimePath, "tmux.sock"), "terminal-overrides", "xterm-256color:Tc")

	agent.send(t, `{"id":4,"op":"workspace.create","name":"api-server"}`)
	duplicate := agent.readID(t, "4")
	requireErrorCode(t, duplicate, "WORKSPACE_EXISTS")

	agent.send(t, `{"id":5,"op":"workspace.create","name":"!!!"}`)
	invalidName := agent.readID(t, "5")
	requireErrorCode(t, invalidName, "INVALID_WORKSPACE_NAME")

	agent.send(t, fmt.Sprintf(`{"id":11,"op":"session.list","workspace_id":%q}`, workspaceID))
	sessionList := agent.readID(t, "11")
	requireOK(t, sessionList, true)
	sessions := requireArray(t, sessionList, "sessions")
	if len(sessions) != 1 {
		t.Fatalf("session count = %d, want 1", len(sessions))
	}
	sessionView, ok := sessions[0].(map[string]any)
	if !ok {
		t.Fatalf("session row = %#v, want object", sessions[0])
	}
	requireField(t, sessionView, "name", "main")
	requireField(t, sessionView, "status", "running")

	agent.send(t, fmt.Sprintf(`{"id":6,"op":"terminal.attach","workspace_id":%q,"cols":100,"rows":30}`, workspaceID))
	attached := agent.readID(t, "6")
	requireOK(t, attached, true)
	streamID := requireString(t, attached, "stream")

	marker := "repttyl-cli-e2e-ok"
	agent.send(t, fmt.Sprintf(`{"stream":%q,"op":"input","data":%q}`, streamID, fmt.Sprintf("printf '%s\\n'\n", marker)))
	agent.readUntilOutputContains(t, streamID, marker)

	commandMarker := "REPTTYL_COMMAND_TEST_DONE"
	command := "mkdir -p command-test-dir; i=1; : > command-test-dir/numbers.txt; while [ \"$i\" -le 10 ]; do printf '%s\\n' \"$i\" >> command-test-dir/numbers.txt; i=$((i + 1)); done; printf '%s\\n' REPTTYL_COMMAND_TEST_DONE\n"
	agent.send(t, fmt.Sprintf(`{"stream":%q,"op":"input","data":%q}`, streamID, command))
	agent.readUntilOutputContains(t, streamID, commandMarker)
	requireFileContent(t, filepath.Join(workspacePath, "command-test-dir", "numbers.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n")

	agent.send(t, fmt.Sprintf(`{"stream":%q,"op":"resize","cols":120,"rows":40}`, streamID))

	agent.send(t, fmt.Sprintf(`{"id":7,"op":"session.kill","workspace_id":%q,"session":"main"}`, workspaceID))
	killed := agent.readID(t, "7")
	requireOK(t, killed, true)

	agent.send(t, `{"id":8,"op":"workspace.list"}`)
	finalList := agent.readID(t, "8")
	requireOK(t, finalList, true)
	workspaces := requireArray(t, finalList, "workspaces")
	if len(workspaces) != 1 {
		t.Fatalf("final workspace count = %d, want 1", len(workspaces))
	}
	workspaceView, ok := workspaces[0].(map[string]any)
	if !ok {
		t.Fatalf("workspace row = %#v, want object", workspaces[0])
	}
	status := requireString(t, workspaceView, "status")
	if status != "stopped" {
		t.Fatalf("workspace status = %q, want stopped", status)
	}
}

func TestCLIAgentScreenBackendEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("screen"); err != nil {
		t.Skip("screen is not available on PATH")
	}

	bin := buildCLI(t)
	env := append(testEnv(t), "REPTTYL_SESSION_BACKEND=screen")
	agent := startAgent(t, bin, env)
	defer agent.close(t)

	agent.send(t, `{"id":1,"op":"workspace.create","name":"screen-backend"}`)
	created := agent.readID(t, "1")
	requireOK(t, created, true)
	workspace := requireObject(t, created, "workspace")
	workspaceID := requireString(t, workspace, "id")
	workspacePath := requireString(t, workspace, "path")

	agent.send(t, fmt.Sprintf(`{"id":2,"op":"session.list","workspace_id":%q}`, workspaceID))
	sessionList := agent.readID(t, "2")
	requireOK(t, sessionList, true)
	sessions := requireArray(t, sessionList, "sessions")
	if len(sessions) != 1 {
		t.Fatalf("session count = %d, want 1", len(sessions))
	}
	sessionView, ok := sessions[0].(map[string]any)
	if !ok {
		t.Fatalf("session row = %#v, want object", sessions[0])
	}
	requireField(t, sessionView, "name", "main")
	requireField(t, sessionView, "status", "running")

	agent.send(t, fmt.Sprintf(`{"id":3,"op":"terminal.attach","workspace_id":%q,"cols":100,"rows":30}`, workspaceID))
	attached := agent.readID(t, "3")
	requireOK(t, attached, true)
	streamID := requireString(t, attached, "stream")

	marker := "repttyl-screen-e2e-ok"
	agent.send(t, fmt.Sprintf(`{"stream":%q,"op":"input","data":%q}`, streamID, fmt.Sprintf("printf '%s\\n'\n", marker)))
	agent.readUntilOutputContains(t, streamID, marker)

	commandMarker := "REPTTYL_SCREEN_COMMAND_TEST_DONE"
	command := "mkdir -p command-test-dir; printf '%s\\n' screen > command-test-dir/backend.txt; printf '%s\\n' REPTTYL_SCREEN_COMMAND_TEST_DONE\n"
	agent.send(t, fmt.Sprintf(`{"stream":%q,"op":"input","data":%q}`, streamID, command))
	agent.readUntilOutputContains(t, streamID, commandMarker)
	requireFileContent(t, filepath.Join(workspacePath, "command-test-dir", "backend.txt"), "screen\n")

	agent.send(t, fmt.Sprintf(`{"stream":%q,"op":"resize","cols":120,"rows":40}`, streamID))

	agent.send(t, fmt.Sprintf(`{"id":4,"op":"session.kill","workspace_id":%q,"session":"main"}`, workspaceID))
	killed := agent.readID(t, "4")
	requireOK(t, killed, true)

	agent.send(t, `{"id":5,"op":"workspace.list"}`)
	finalList := agent.readID(t, "5")
	requireOK(t, finalList, true)
	workspaces := requireArray(t, finalList, "workspaces")
	if len(workspaces) != 1 {
		t.Fatalf("workspace count = %d, want 1", len(workspaces))
	}
	workspaceView, ok := workspaces[0].(map[string]any)
	if !ok {
		t.Fatalf("workspace row = %#v, want object", workspaces[0])
	}
	status := requireString(t, workspaceView, "status")
	if status != "stopped" {
		t.Fatalf("workspace status = %q, want stopped", status)
	}
}

func TestCLIAgentWorkspaceMetadataEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not available on PATH")
	}

	bin := buildCLI(t)
	env := testEnv(t)
	agent := startAgent(t, bin, env)
	agentClosed := false
	defer func() {
		if !agentClosed {
			agent.close(t)
		}
	}()

	tests := []struct {
		id   int
		name string
		slug string
	}{
		{id: 1, name: "api", slug: "api"},
		{id: 2, name: "Infra Shell", slug: "infra-shell"},
		{id: 3, name: "billing_worker!", slug: "billing_worker"},
		{id: 4, name: "release/canary", slug: "release-canary"},
	}

	createdIDs := make([]string, 0, len(tests))
	for _, tt := range tests {
		agent.send(t, fmt.Sprintf(`{"id":%d,"op":"workspace.create","name":%q}`, tt.id, tt.name))
		response := agent.readID(t, fmt.Sprint(tt.id))
		requireOK(t, response, true)
		workspace := requireObject(t, response, "workspace")
		createdIDs = append(createdIDs, requireString(t, workspace, "id"))
		requireField(t, workspace, "name", tt.name)
		requireField(t, workspace, "slug", tt.slug)
	}

	agent.send(t, `{"id":20,"op":"workspace.create","name":"infra-shell"}`)
	duplicate := agent.readID(t, "20")
	requireErrorCode(t, duplicate, "WORKSPACE_EXISTS")

	agent.send(t, `{"id":21,"op":"workspace.create","name":" !!! "}`)
	invalid := agent.readID(t, "21")
	requireErrorCode(t, invalid, "INVALID_WORKSPACE_NAME")

	agent.send(t, `{"id":22,"op":"workspace.list"}`)
	listBeforeRestart := agent.readID(t, "22")
	requireOK(t, listBeforeRestart, true)
	requireArrayLen(t, listBeforeRestart, "workspaces", len(tests))

	for i, workspaceID := range createdIDs {
		agent.send(t, fmt.Sprintf(`{"id":%d,"op":"session.kill","workspace_id":%q,"session":"main"}`, 30+i, workspaceID))
		requireOK(t, agent.readID(t, fmt.Sprint(30+i)), true)
	}
	agent.close(t)
	agentClosed = true

	listFromFreshCLI := runCLI(t, bin, env, "workspace", "list", "--json")
	var listed struct {
		Workspaces []struct {
			Name   string `json:"name"`
			Slug   string `json:"slug"`
			Status string `json:"status"`
		} `json:"workspaces"`
	}
	if err := json.Unmarshal([]byte(listFromFreshCLI.stdout), &listed); err != nil {
		t.Fatalf("workspace list output is not JSON: %v\n%s", err, listFromFreshCLI.stdout)
	}
	if len(listed.Workspaces) != len(tests) {
		t.Fatalf("persisted workspace count = %d, want %d", len(listed.Workspaces), len(tests))
	}
	for i, tt := range tests {
		if listed.Workspaces[i].Name != tt.name || listed.Workspaces[i].Slug != tt.slug {
			t.Fatalf("persisted workspace[%d] = %#v, want name %q slug %q", i, listed.Workspaces[i], tt.name, tt.slug)
		}
		if listed.Workspaces[i].Status != "stopped" {
			t.Fatalf("persisted workspace[%d] status = %q, want stopped", i, listed.Workspaces[i].Status)
		}
	}
}

func TestCLIAgentProtocolErrors(t *testing.T) {
	bin := buildCLI(t)
	env := testEnv(t)
	agent := startAgent(t, bin, env)
	defer agent.close(t)

	agent.send(t, `{not-json}`)
	invalidJSON := agent.read(t)
	requireErrorCode(t, invalidJSON, "INVALID_JSON")

	agent.send(t, `{"id":9,"op":"unknown.op"}`)
	unknown := agent.readID(t, "9")
	requireErrorCode(t, unknown, "UNKNOWN_OP")

	agent.send(t, `{"id":10,"op":"terminal.attach","workspace_id":"ws_missing","cols":80,"rows":24}`)
	missingWorkspace := agent.readID(t, "10")
	requireErrorCode(t, missingWorkspace, "WORKSPACE_NOT_FOUND")

	agent.send(t, `{"stream":"term_missing","op":"input","data":"hello"}`)
	missingStream := agent.read(t)
	requireField(t, missingStream, "op", "error")
	requireErrorCode(t, missingStream, "STREAM_NOT_FOUND")
}

func TestCLIAgentRemovesClosedTerminalStreams(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not available on PATH")
	}

	bin := buildCLI(t)
	env := testEnv(t)
	agent := startAgent(t, bin, env)
	defer agent.close(t)

	agent.send(t, `{"id":1,"op":"workspace.create","name":"closed-stream"}`)
	created := agent.readID(t, "1")
	requireOK(t, created, true)
	workspace := requireObject(t, created, "workspace")
	workspaceID := requireString(t, workspace, "id")
	runtimePath := requireString(t, workspace, "runtime_path")

	agent.send(t, fmt.Sprintf(`{"id":2,"op":"terminal.attach","workspace_id":%q,"cols":100,"rows":30}`, workspaceID))
	attached := agent.readID(t, "2")
	requireOK(t, attached, true)
	streamID := requireString(t, attached, "stream")

	socketPath := filepath.Join(runtimePath, "tmux.sock")
	if err := exec.Command("tmux", "-S", socketPath, "kill-server").Run(); err != nil {
		t.Fatalf("kill tmux server: %v", err)
	}

	agent.readStreamErrorCode(t, streamID, "TERMINAL_CLOSED")

	agent.send(t, fmt.Sprintf(`{"stream":%q,"op":"resize","cols":120,"rows":40}`, streamID))
	agent.readStreamErrorCode(t, streamID, "STREAM_NOT_FOUND")

	agent.send(t, fmt.Sprintf(`{"stream":%q,"op":"input","data":"echo should-not-write\n"}`, streamID))
	agent.readStreamErrorCode(t, streamID, "STREAM_NOT_FOUND")
}

func TestCLIAgentDaemonEvents(t *testing.T) {
	bin := buildCLI(t)
	env := testEnv(t)
	agent := startAgent(t, bin, env)
	defer agent.close(t)
	defer runCLI(t, bin, env, "daemon", "stop")

	agent.send(t, `{"id":1,"op":"events.subscribe"}`)
	subscribed := agent.readID(t, "1")
	requireOK(t, subscribed, true)

	workspaceID := "ws_test"
	runCLI(t, bin, env, "daemon", "notify", "--workspace-id", workspaceID, "--event", "session-closed")

	event := agent.readOp(t, "workspace.status")
	requireField(t, event, "workspace_id", workspaceID)
	requireField(t, event, "status", "stopped")
	requireField(t, event, "reason", "session-closed")
}

type cliResult struct {
	stdout string
	stderr string
}

func buildCLI(t *testing.T) string {
	t.Helper()

	bin := filepath.Join(t.TempDir(), "repttyl")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Env = os.Environ()

	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output

	if err := cmd.Run(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, output.String())
	}
	return bin
}

func testEnv(t *testing.T) []string {
	t.Helper()

	root := t.TempDir()
	return []string{
		"REPTTYL_STATE_ROOT=" + filepath.Join(root, "state"),
		"REPTTYL_RUNTIME_ROOT=" + filepath.Join(root, "run"),
		"REPTTYL_WORKSPACE_ROOT=" + filepath.Join(root, "workspaces"),
		"SHELL=/bin/sh",
		"TERM=xterm-256color",
	}
}

func runCLI(t *testing.T, bin string, env []string, args ...string) cliResult {
	t.Helper()

	result, err := runCLIWithError(bin, env, args...)
	if err != nil {
		t.Fatalf("repttyl %s failed: %v\nstdout:\n%s\nstderr:\n%s", strings.Join(args, " "), err, result.stdout, result.stderr)
	}
	return result
}

func runCLIExpectError(t *testing.T, bin string, env []string, args ...string) cliResult {
	t.Helper()

	result, err := runCLIWithError(bin, env, args...)
	if err == nil {
		t.Fatalf("repttyl %s succeeded unexpectedly\nstdout:\n%s\nstderr:\n%s", strings.Join(args, " "), result.stdout, result.stderr)
	}
	return result
}

func runCLIWithError(bin string, env []string, args ...string) (cliResult, error) {
	cmd := exec.Command(bin, args...)
	cmd.Env = append(os.Environ(), env...)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	return cliResult{stdout: stdout.String(), stderr: stderr.String()}, err
}

func requireTmuxOption(t *testing.T, socketPath string, option string, want string) {
	t.Helper()

	cmd := exec.Command("tmux", "-S", socketPath, "show-option", "-gqv", option)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("tmux show-option %s failed: %v\n%s", option, err, string(output))
	}
	got := strings.TrimSpace(string(output))
	if got != want {
		t.Fatalf("tmux option %s = %q, want %q", option, got, want)
	}
}

func expectedTmuxDefaultTerminal() string {
	for _, term := range []string{"tmux-256color", "screen-256color", "xterm-256color"} {
		if exec.Command("infocmp", term).Run() == nil {
			return term
		}
	}
	return "screen"
}

func requireFileContent(t *testing.T, path string, want string) {
	t.Helper()

	deadline := time.Now().Add(5 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		content, err := os.ReadFile(path)
		if err == nil && string(content) == want {
			return
		}
		if err != nil {
			lastErr = err
		} else {
			lastErr = fmt.Errorf("content = %q, want %q", string(content), want)
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("file %s was not written as expected: %v", path, lastErr)
}

type runningAgent struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  <-chan string
	cancel context.CancelFunc
}

func startAgent(t *testing.T, bin string, env []string) *runningAgent {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	cmd := exec.CommandContext(ctx, bin, "agent", "--stdio")
	cmd.Env = append(os.Environ(), env...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		t.Fatalf("StdinPipe failed: %v", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatalf("StdoutPipe failed: %v", err)
	}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("agent start failed: %v\nstderr:\n%s", err, stderr.String())
	}

	lines := make(chan string, 128)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()

	return &runningAgent{
		cmd:    cmd,
		stdin:  stdin,
		lines:  lines,
		cancel: cancel,
	}
}

func (a *runningAgent) send(t *testing.T, line string) {
	t.Helper()

	if _, err := fmt.Fprintln(a.stdin, line); err != nil {
		t.Fatalf("failed to write agent request: %v", err)
	}
}

func (a *runningAgent) read(t *testing.T) map[string]any {
	t.Helper()

	select {
	case line, ok := <-a.lines:
		if !ok {
			t.Fatal("agent stdout closed before a response was received")
		}
		var message map[string]any
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			t.Fatalf("agent response is not JSON: %v\n%s", err, line)
		}
		return message
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for agent response")
	}
	return nil
}

func (a *runningAgent) readID(t *testing.T, id string) map[string]any {
	t.Helper()

	deadline := time.After(5 * time.Second)
	for {
		select {
		case line, ok := <-a.lines:
			if !ok {
				t.Fatalf("agent stdout closed before response id %s was received", id)
			}
			var message map[string]any
			if err := json.Unmarshal([]byte(line), &message); err != nil {
				t.Fatalf("agent response is not JSON: %v\n%s", err, line)
			}
			if fmt.Sprint(message["id"]) == id {
				return message
			}
		case <-deadline:
			t.Fatalf("timed out waiting for agent response id %s", id)
		}
	}
}

func (a *runningAgent) readOp(t *testing.T, op string) map[string]any {
	t.Helper()

	deadline := time.After(5 * time.Second)
	for {
		select {
		case line, ok := <-a.lines:
			if !ok {
				t.Fatalf("agent stdout closed before op %s was received", op)
			}
			var message map[string]any
			if err := json.Unmarshal([]byte(line), &message); err != nil {
				t.Fatalf("agent response is not JSON: %v\n%s", err, line)
			}
			if message["op"] == op {
				return message
			}
		case <-deadline:
			t.Fatalf("timed out waiting for op %s", op)
		}
	}
}

func (a *runningAgent) readUntilOutputContains(t *testing.T, streamID string, substring string) {
	t.Helper()

	deadline := time.After(8 * time.Second)
	var seen strings.Builder
	for {
		select {
		case line, ok := <-a.lines:
			if !ok {
				t.Fatal("agent stdout closed before terminal output was received")
			}
			var message map[string]any
			if err := json.Unmarshal([]byte(line), &message); err != nil {
				t.Fatalf("agent stream message is not JSON: %v\n%s", err, line)
			}
			if message["stream"] == streamID && message["op"] == "output" {
				data := fmt.Sprint(message["data"])
				seen.WriteString(data)
				if strings.Contains(seen.String(), substring) {
					return
				}
			}
		case <-deadline:
			t.Fatalf("timed out waiting for terminal output containing %q; saw %q", substring, seen.String())
		}
	}
}

func (a *runningAgent) readStreamErrorCode(t *testing.T, streamID string, codes ...string) {
	t.Helper()

	allowed := make(map[string]bool, len(codes))
	for _, code := range codes {
		allowed[code] = true
	}

	deadline := time.After(8 * time.Second)
	for {
		select {
		case line, ok := <-a.lines:
			if !ok {
				t.Fatal("agent stdout closed before terminal error was received")
			}
			var message map[string]any
			if err := json.Unmarshal([]byte(line), &message); err != nil {
				t.Fatalf("agent stream message is not JSON: %v\n%s", err, line)
			}
			if message["stream"] != streamID || message["op"] != "error" {
				continue
			}
			errorObject, ok := message["error"].(map[string]any)
			if !ok {
				t.Fatalf("stream error = %#v, want object", message["error"])
			}
			code := fmt.Sprint(errorObject["code"])
			if !allowed[code] {
				t.Fatalf("stream error code = %q, want one of %v", code, codes)
			}
			return
		case <-deadline:
			t.Fatalf("timed out waiting for terminal error with code %v", codes)
		}
	}
}

func (a *runningAgent) close(t *testing.T) {
	t.Helper()

	_ = a.stdin.Close()
	a.cancel()
	if err := a.cmd.Wait(); err != nil && a.cmd.ProcessState == nil {
		t.Fatalf("agent wait failed: %v", err)
	}
}

func assertJSONField(t *testing.T, raw string, key string, want any) {
	t.Helper()

	var data map[string]any
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, raw)
	}
	requireField(t, data, key, want)
}

func requireOK(t *testing.T, message map[string]any, want bool) {
	t.Helper()
	requireField(t, message, "ok", want)
}

func requireField(t *testing.T, message map[string]any, key string, want any) {
	t.Helper()

	got, ok := message[key]
	if !ok {
		t.Fatalf("missing field %q in %#v", key, message)
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("%s = %#v, want %#v in %#v", key, got, want, message)
	}
}

func requireString(t *testing.T, message map[string]any, key string) string {
	t.Helper()

	value, ok := message[key]
	if !ok {
		t.Fatalf("missing field %q in %#v", key, message)
	}
	text, ok := value.(string)
	if !ok {
		t.Fatalf("%s = %#v, want string", key, value)
	}
	return text
}

func requireObject(t *testing.T, message map[string]any, key string) map[string]any {
	t.Helper()

	value, ok := message[key]
	if !ok {
		t.Fatalf("missing field %q in %#v", key, message)
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s = %#v, want object", key, value)
	}
	return object
}

func requireArray(t *testing.T, message map[string]any, key string) []any {
	t.Helper()

	value, ok := message[key]
	if !ok {
		t.Fatalf("missing field %q in %#v", key, message)
	}
	array, ok := value.([]any)
	if !ok {
		t.Fatalf("%s = %#v, want array", key, value)
	}
	return array
}

func requireArrayLen(t *testing.T, message map[string]any, key string, want int) {
	t.Helper()

	array := requireArray(t, message, key)
	if len(array) != want {
		t.Fatalf("len(%s) = %d, want %d", key, len(array), want)
	}
}

func requireErrorCode(t *testing.T, message map[string]any, want string) {
	t.Helper()

	errorObject := requireObject(t, message, "error")
	requireField(t, errorObject, "code", want)
}
