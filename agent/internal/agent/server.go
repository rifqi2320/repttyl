package agent

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/repttyl/repttyl/agent/internal/daemon"
	"github.com/repttyl/repttyl/agent/internal/metadata"
	"github.com/repttyl/repttyl/agent/internal/protocol"
	"github.com/repttyl/repttyl/agent/internal/terminal"
	"github.com/repttyl/repttyl/agent/internal/tmux"
	"github.com/repttyl/repttyl/agent/internal/version"
)

type Server struct {
	in      io.Reader
	out     io.Writer
	store   *metadata.Store
	tmux    *tmux.Manager
	writeMu sync.Mutex

	streamMu sync.Mutex
	streams  map[string]activeStream

	eventMu       sync.Mutex
	eventClosers  []io.Closer
	eventCancel   context.CancelFunc
	eventCancelMu sync.Mutex
}

type activeStream struct {
	workspaceID string
	attachment  *terminal.Attachment
}

type WorkspaceView struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Slug   string `json:"slug"`
	Path   string `json:"path"`
	Status string `json:"status"`
}

func NewServer(in io.Reader, out io.Writer, store *metadata.Store, tmuxManager *tmux.Manager) *Server {
	return &Server{
		in:      in,
		out:     out,
		store:   store,
		tmux:    tmuxManager,
		streams: make(map[string]activeStream),
	}
}

func (s *Server) Serve(ctx context.Context) error {
	defer s.closeStreams()
	defer s.closeEventSubscriptions()

	scanner := bufio.NewScanner(s.in)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)

	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		var request protocol.Request
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			_ = s.sendError(nil, "INVALID_JSON", "Invalid JSON message")
			continue
		}
		s.handle(ctx, request)
	}

	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func (s *Server) handle(ctx context.Context, request protocol.Request) {
	switch request.Op {
	case "hello":
		s.handleHello(request)
	case "workspace.list":
		s.handleWorkspaceList(ctx, request)
	case "workspace.create":
		s.handleWorkspaceCreate(ctx, request)
	case "terminal.attach":
		s.handleTerminalAttach(ctx, request)
	case "session.list":
		s.handleSessionList(ctx, request)
	case "events.subscribe":
		s.handleEventsSubscribe(ctx, request)
	case "input":
		s.handleTerminalInput(request)
	case "resize":
		s.handleTerminalResize(request)
	case "session.kill":
		s.handleSessionKill(ctx, request)
	default:
		_ = s.sendError(request.ID, "UNKNOWN_OP", fmt.Sprintf("Unknown operation: %s", request.Op))
	}
}

func (s *Server) handleHello(request protocol.Request) {
	if !request.HasID() {
		_ = s.sendError(nil, "MISSING_ID", "hello requires an id")
		return
	}

	_ = s.sendSuccess(request.ID, map[string]any{
		"agent_version":    version.AgentVersion,
		"protocol_version": version.ProtocolVersion,
	})
}

func (s *Server) handleWorkspaceList(ctx context.Context, request protocol.Request) {
	if !request.HasID() {
		_ = s.sendError(nil, "MISSING_ID", "workspace.list requires an id")
		return
	}

	workspaces := s.store.List()
	views := make([]WorkspaceView, 0, len(workspaces))
	for _, workspace := range workspaces {
		views = append(views, WorkspaceView{
			ID:     workspace.ID,
			Name:   workspace.Name,
			Slug:   workspace.Slug,
			Path:   workspace.Path,
			Status: s.tmux.Status(ctx, workspace),
		})
	}

	_ = s.sendSuccess(request.ID, map[string]any{"workspaces": views})
}

func (s *Server) handleWorkspaceCreate(ctx context.Context, request protocol.Request) {
	if !request.HasID() {
		_ = s.sendError(nil, "MISSING_ID", "workspace.create requires an id")
		return
	}
	if request.Name == "" {
		_ = s.sendError(request.ID, "INVALID_WORKSPACE_NAME", "Workspace name is required")
		return
	}

	workspace, err := s.store.Create(request.Name)
	if err != nil {
		s.sendStoreError(request.ID, err)
		return
	}
	if err := s.tmux.EnsureSession(ctx, workspace); err != nil {
		_ = s.sendError(request.ID, "TMUX_ERROR", err.Error())
		return
	}

	_ = s.sendSuccess(request.ID, map[string]any{"workspace": workspace})
}

func (s *Server) handleTerminalAttach(ctx context.Context, request protocol.Request) {
	if !request.HasID() {
		_ = s.sendError(nil, "MISSING_ID", "terminal.attach requires an id")
		return
	}
	if request.WorkspaceID == "" {
		_ = s.sendError(request.ID, "WORKSPACE_NOT_FOUND", "Workspace id is required")
		return
	}

	workspace, ok := s.store.Get(request.WorkspaceID)
	if !ok {
		_ = s.sendError(request.ID, "WORKSPACE_NOT_FOUND", "Workspace not found")
		return
	}
	if err := s.tmux.EnsureSession(ctx, workspace); err != nil {
		_ = s.sendError(request.ID, "TMUX_ERROR", err.Error())
		return
	}
	session := tmux.NormalizeSessionName(request.Session)
	if session != tmux.SessionName {
		_ = s.sendError(request.ID, "SESSION_NOT_FOUND", "Session not found")
		return
	}

	streamID, err := newStreamID()
	if err != nil {
		_ = s.sendError(request.ID, "INTERNAL_ERROR", err.Error())
		return
	}

	closed := make(chan error, 1)
	attachment, err := terminal.Attach(
		ctx,
		s.tmux.SocketPath(workspace),
		session,
		request.Cols,
		request.Rows,
		func(output []byte) {
			_ = s.sendStream(streamID, "output", string(output))
		},
		func(err error) {
			select {
			case closed <- err:
			default:
			}
		},
	)
	if err != nil {
		_ = s.sendError(request.ID, "ATTACH_FAILED", err.Error())
		return
	}

	s.streamMu.Lock()
	s.streams[streamID] = activeStream{workspaceID: workspace.ID, attachment: attachment}
	s.streamMu.Unlock()
	if attachment.Closed() {
		s.removeStream(streamID)
		_ = s.sendError(request.ID, "ATTACH_FAILED", "Terminal attach closed before the stream was ready")
		return
	}

	_ = s.store.Touch(workspace.ID)
	_ = s.sendSuccess(request.ID, map[string]any{"stream": streamID})
	go s.watchStreamClose(streamID, attachment, closed)
}

func (s *Server) handleSessionList(ctx context.Context, request protocol.Request) {
	if !request.HasID() {
		_ = s.sendError(nil, "MISSING_ID", "session.list requires an id")
		return
	}
	if request.WorkspaceID == "" {
		_ = s.sendError(request.ID, "WORKSPACE_NOT_FOUND", "Workspace id is required")
		return
	}

	workspace, ok := s.store.Get(request.WorkspaceID)
	if !ok {
		_ = s.sendError(request.ID, "WORKSPACE_NOT_FOUND", "Workspace not found")
		return
	}

	_ = s.sendSuccess(request.ID, map[string]any{"sessions": s.tmux.ListSessions(ctx, workspace)})
}

func (s *Server) handleTerminalInput(request protocol.Request) {
	stream, ok := s.getStream(request.Stream)
	if !ok {
		_ = s.sendStreamError(request.Stream, "STREAM_NOT_FOUND", "Terminal stream not found")
		return
	}
	if err := stream.attachment.Write(request.Data); err != nil {
		s.removeStream(request.Stream)
		_ = s.sendStreamError(request.Stream, "WRITE_FAILED", err.Error())
	}
}

func (s *Server) handleTerminalResize(request protocol.Request) {
	stream, ok := s.getStream(request.Stream)
	if !ok {
		_ = s.sendStreamError(request.Stream, "STREAM_NOT_FOUND", "Terminal stream not found")
		return
	}
	if err := stream.attachment.Resize(request.Cols, request.Rows); err != nil {
		// Resize is advisory. A terminal can still be usable if a size update races
		// with attach/close, so do not tear down the stream for resize failures.
		_ = s.sendStreamError(request.Stream, "RESIZE_FAILED", err.Error())
	}
}

func (s *Server) handleEventsSubscribe(ctx context.Context, request protocol.Request) {
	if !request.HasID() {
		_ = s.sendError(nil, "MISSING_ID", "events.subscribe requires an id")
		return
	}

	if err := daemon.Start(s.store.Paths()); err != nil {
		_ = s.sendError(request.ID, "DAEMON_ERROR", err.Error())
		return
	}

	subscriptionCtx, cancel := context.WithCancel(ctx)
	closer, err := daemon.Subscribe(subscriptionCtx, s.store.Paths(), func(event daemon.Event) {
		_ = s.send(event)
	})
	if err != nil {
		cancel()
		_ = s.sendError(request.ID, "DAEMON_ERROR", err.Error())
		return
	}

	s.eventCancelMu.Lock()
	if s.eventCancel == nil {
		s.eventCancel = cancel
	} else {
		previousCancel := s.eventCancel
		s.eventCancel = func() {
			previousCancel()
			cancel()
		}
	}
	s.eventCancelMu.Unlock()

	s.eventMu.Lock()
	s.eventClosers = append(s.eventClosers, closer)
	s.eventMu.Unlock()

	_ = s.sendSuccess(request.ID, nil)
}

func (s *Server) handleSessionKill(ctx context.Context, request protocol.Request) {
	if !request.HasID() {
		_ = s.sendError(nil, "MISSING_ID", "session.kill requires an id")
		return
	}

	workspace, ok := s.store.Get(request.WorkspaceID)
	if !ok {
		_ = s.sendError(request.ID, "WORKSPACE_NOT_FOUND", "Workspace not found")
		return
	}

	s.closeWorkspaceStreams(workspace.ID)
	if err := s.tmux.KillSession(ctx, workspace, request.Session); err != nil {
		_ = s.sendError(request.ID, "TMUX_ERROR", err.Error())
		return
	}

	_ = s.sendSuccess(request.ID, nil)
}

func (s *Server) getStream(streamID string) (activeStream, bool) {
	s.streamMu.Lock()
	defer s.streamMu.Unlock()

	stream, ok := s.streams[streamID]
	return stream, ok
}

func (s *Server) removeStream(streamID string) {
	s.streamMu.Lock()
	stream, ok := s.streams[streamID]
	if ok {
		delete(s.streams, streamID)
	}
	s.streamMu.Unlock()

	if ok {
		_ = stream.attachment.Close()
	}
}

func (s *Server) forgetStream(streamID string) {
	s.streamMu.Lock()
	delete(s.streams, streamID)
	s.streamMu.Unlock()
}

func (s *Server) watchStreamClose(streamID string, attachment *terminal.Attachment, closed <-chan error) {
	select {
	case err := <-closed:
		s.forgetStream(streamID)
		if err != nil {
			_ = s.sendStreamError(streamID, "TERMINAL_CLOSED", err.Error())
		}
	case <-attachment.Done():
		select {
		case err := <-closed:
			s.forgetStream(streamID)
			if err != nil {
				_ = s.sendStreamError(streamID, "TERMINAL_CLOSED", err.Error())
			}
		default:
		}
	}
}

func (s *Server) closeWorkspaceStreams(workspaceID string) {
	s.streamMu.Lock()
	streams := make([]activeStream, 0)
	for streamID, stream := range s.streams {
		if stream.workspaceID == workspaceID {
			streams = append(streams, stream)
			delete(s.streams, streamID)
		}
	}
	s.streamMu.Unlock()

	for _, stream := range streams {
		_ = stream.attachment.Close()
	}
}

func (s *Server) closeStreams() {
	s.streamMu.Lock()
	streams := make([]activeStream, 0, len(s.streams))
	for streamID, stream := range s.streams {
		streams = append(streams, stream)
		delete(s.streams, streamID)
	}
	s.streamMu.Unlock()

	for _, stream := range streams {
		_ = stream.attachment.Close()
	}
}

func (s *Server) closeEventSubscriptions() {
	s.eventCancelMu.Lock()
	if s.eventCancel != nil {
		s.eventCancel()
		s.eventCancel = nil
	}
	s.eventCancelMu.Unlock()

	s.eventMu.Lock()
	closers := s.eventClosers
	s.eventClosers = nil
	s.eventMu.Unlock()

	for _, closer := range closers {
		_ = closer.Close()
	}
}

func (s *Server) sendStoreError(id json.RawMessage, err error) {
	switch {
	case errors.Is(err, metadata.ErrInvalidWorkspaceName):
		_ = s.sendError(id, "INVALID_WORKSPACE_NAME", "Invalid workspace name")
	case errors.Is(err, metadata.ErrWorkspaceExists):
		_ = s.sendError(id, "WORKSPACE_EXISTS", "Workspace already exists")
	default:
		_ = s.sendError(id, "METADATA_ERROR", err.Error())
	}
}

func (s *Server) sendSuccess(id json.RawMessage, fields map[string]any) error {
	response := map[string]any{
		"id": id,
		"ok": true,
	}
	for key, value := range fields {
		response[key] = value
	}
	return s.send(response)
}

func (s *Server) sendError(id json.RawMessage, code string, message string) error {
	return s.send(protocol.ErrorResponse{
		ID: id,
		OK: false,
		Error: protocol.Error{
			Code:    code,
			Message: message,
		},
	})
}

func (s *Server) sendStream(streamID string, op string, data string) error {
	return s.send(map[string]any{
		"stream": streamID,
		"op":     op,
		"data":   data,
	})
}

func (s *Server) sendStreamError(streamID string, code string, message string) error {
	return s.send(map[string]any{
		"stream": streamID,
		"op":     "error",
		"error": protocol.Error{
			Code:    code,
			Message: message,
		},
	})
}

func (s *Server) send(value any) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	encoder := json.NewEncoder(s.out)
	return encoder.Encode(value)
}

func newStreamID() (string, error) {
	bytes := make([]byte, 8)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "term_" + hex.EncodeToString(bytes), nil
}
