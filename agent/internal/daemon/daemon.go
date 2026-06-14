package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/repttyl/repttyl/agent/internal/metadata"
)

var ErrNotRunning = errors.New("daemon is not running")

type Status struct {
	Running bool   `json:"running"`
	PID     int    `json:"pid,omitempty"`
	Socket  string `json:"socket"`
}

type Event struct {
	Op          string `json:"op"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	Status      string `json:"status,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

type request struct {
	Op          string `json:"op"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	Event       string `json:"event,omitempty"`
}

type response struct {
	OK      bool   `json:"ok"`
	Running bool   `json:"running,omitempty"`
	PID     int    `json:"pid,omitempty"`
	Error   string `json:"error,omitempty"`
}

type server struct {
	paths metadata.Paths

	listener *net.UnixListener
	done     chan struct{}
	stopOnce sync.Once

	mu          sync.Mutex
	subscribers map[*json.Encoder]io.Closer
}

func SocketPath(paths metadata.Paths) string {
	return filepath.Join(paths.RuntimeRoot, "daemon.sock")
}

func PIDPath(paths metadata.Paths) string {
	return filepath.Join(paths.RuntimeRoot, "daemon.pid")
}

func Start(paths metadata.Paths) error {
	status, err := GetStatus(paths)
	if err == nil && status.Running {
		return nil
	}

	if err := os.MkdirAll(paths.RuntimeRoot, 0o700); err != nil {
		return err
	}

	executable, err := os.Executable()
	if err != nil {
		return err
	}

	logPath := filepath.Join(paths.RuntimeRoot, "daemon.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}

	cmd := exec.Command(executable, "daemon", "run")
	cmd.Env = os.Environ()
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return err
	}
	if err := cmd.Process.Release(); err != nil {
		_ = logFile.Close()
		return err
	}
	_ = logFile.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status, err := GetStatus(paths)
		if err == nil && status.Running {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("daemon did not start")
}

func Run(ctx context.Context, paths metadata.Paths) error {
	if err := os.MkdirAll(paths.RuntimeRoot, 0o700); err != nil {
		return err
	}

	socketPath := SocketPath(paths)
	_ = os.Remove(socketPath)

	addr := net.UnixAddr{Name: socketPath, Net: "unix"}
	listener, err := net.ListenUnix("unix", &addr)
	if err != nil {
		return err
	}

	if err := os.WriteFile(PIDPath(paths), []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o600); err != nil {
		_ = listener.Close()
		return err
	}

	s := &server{
		paths:       paths,
		listener:    listener,
		done:        make(chan struct{}),
		subscribers: make(map[*json.Encoder]io.Closer),
	}

	defer func() {
		s.close()
		_ = os.Remove(socketPath)
		_ = os.Remove(PIDPath(paths))
	}()

	go func() {
		<-ctx.Done()
		s.close()
	}()

	for {
		conn, err := listener.AcceptUnix()
		if err != nil {
			select {
			case <-s.done:
				return nil
			default:
				return err
			}
		}
		go s.handle(conn)
	}
}

func GetStatus(paths metadata.Paths) (Status, error) {
	conn, err := dial(paths)
	if err != nil {
		return Status{Running: false, Socket: SocketPath(paths)}, ErrNotRunning
	}
	defer conn.Close()

	if err := json.NewEncoder(conn).Encode(request{Op: "status"}); err != nil {
		return Status{Running: false, Socket: SocketPath(paths)}, err
	}

	var resp response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return Status{Running: false, Socket: SocketPath(paths)}, err
	}
	if !resp.OK {
		return Status{Running: false, Socket: SocketPath(paths)}, errors.New(resp.Error)
	}
	return Status{Running: resp.Running, PID: resp.PID, Socket: SocketPath(paths)}, nil
}

func Stop(paths metadata.Paths) error {
	conn, err := dial(paths)
	if err != nil {
		return ErrNotRunning
	}
	defer conn.Close()

	if err := json.NewEncoder(conn).Encode(request{Op: "stop"}); err != nil {
		return err
	}
	var resp response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return err
	}
	if !resp.OK {
		return errors.New(resp.Error)
	}
	return nil
}

func Notify(paths metadata.Paths, workspaceID string, event string) error {
	conn, err := dial(paths)
	if err != nil {
		return ErrNotRunning
	}
	defer conn.Close()

	if err := json.NewEncoder(conn).Encode(request{
		Op:          "notify",
		WorkspaceID: workspaceID,
		Event:       event,
	}); err != nil {
		return err
	}

	var resp response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return err
	}
	if !resp.OK {
		return errors.New(resp.Error)
	}
	return nil
}

func Subscribe(ctx context.Context, paths metadata.Paths, onEvent func(Event)) (io.Closer, error) {
	conn, err := dial(paths)
	if err != nil {
		return nil, ErrNotRunning
	}

	if err := json.NewEncoder(conn).Encode(request{Op: "subscribe"}); err != nil {
		_ = conn.Close()
		return nil, err
	}

	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		_ = conn.Close()
		return nil, err
	}

	var resp response
	if err := json.Unmarshal(line, &resp); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if !resp.OK {
		_ = conn.Close()
		return nil, errors.New(resp.Error)
	}

	go func() {
		defer conn.Close()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			select {
			case <-ctx.Done():
				return
			default:
			}

			var event Event
			if err := json.Unmarshal(scanner.Bytes(), &event); err == nil {
				onEvent(event)
			}
		}
	}()

	return conn, nil
}

func dial(paths metadata.Paths) (net.Conn, error) {
	return net.DialTimeout("unix", SocketPath(paths), 300*time.Millisecond)
}

func (s *server) handle(conn net.Conn) {
	var req request
	decoder := json.NewDecoder(conn)
	if err := decoder.Decode(&req); err != nil {
		_ = conn.Close()
		return
	}

	switch req.Op {
	case "status":
		_ = json.NewEncoder(conn).Encode(response{OK: true, Running: true, PID: os.Getpid()})
		_ = conn.Close()
	case "stop":
		_ = json.NewEncoder(conn).Encode(response{OK: true})
		_ = conn.Close()
		s.close()
	case "notify":
		event, err := eventFromNotification(req)
		if err != nil {
			_ = json.NewEncoder(conn).Encode(response{OK: false, Error: err.Error()})
			_ = conn.Close()
			return
		}
		s.broadcast(event)
		_ = json.NewEncoder(conn).Encode(response{OK: true})
		_ = conn.Close()
	case "subscribe":
		encoder := json.NewEncoder(conn)
		if err := encoder.Encode(response{OK: true}); err != nil {
			_ = conn.Close()
			return
		}

		s.mu.Lock()
		s.subscribers[encoder] = conn
		s.mu.Unlock()

		go func() {
			<-s.done
			_ = conn.Close()
		}()
		_, _ = io.Copy(io.Discard, conn)
		s.removeSubscriber(encoder)
	default:
		_ = json.NewEncoder(conn).Encode(response{OK: false, Error: "unknown daemon operation"})
		_ = conn.Close()
	}
}

func eventFromNotification(req request) (Event, error) {
	if req.WorkspaceID == "" {
		return Event{}, errors.New("workspace id is required")
	}

	switch req.Event {
	case "session-closed":
		return Event{
			Op:          "workspace.status",
			WorkspaceID: req.WorkspaceID,
			Status:      "stopped",
			Reason:      req.Event,
		}, nil
	default:
		return Event{}, fmt.Errorf("unknown event: %s", req.Event)
	}
}

func (s *server) broadcast(event Event) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for encoder, closer := range s.subscribers {
		if err := encoder.Encode(event); err != nil {
			_ = closer.Close()
			delete(s.subscribers, encoder)
		}
	}
}

func (s *server) removeSubscriber(encoder *json.Encoder) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if closer, ok := s.subscribers[encoder]; ok {
		_ = closer.Close()
		delete(s.subscribers, encoder)
	}
}

func (s *server) close() {
	s.stopOnce.Do(func() {
		close(s.done)
		_ = s.listener.Close()

		s.mu.Lock()
		defer s.mu.Unlock()
		for encoder, closer := range s.subscribers {
			_ = closer.Close()
			delete(s.subscribers, encoder)
		}
	})
}
