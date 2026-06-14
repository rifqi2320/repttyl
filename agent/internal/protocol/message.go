package protocol

import "encoding/json"

type Request struct {
	ID            json.RawMessage `json:"id,omitempty"`
	Op            string          `json:"op"`
	Stream        string          `json:"stream,omitempty"`
	ClientVersion string          `json:"client_version,omitempty"`
	Name          string          `json:"name,omitempty"`
	WorkspaceID   string          `json:"workspace_id,omitempty"`
	Session       string          `json:"session,omitempty"`
	Cols          int             `json:"cols,omitempty"`
	Rows          int             `json:"rows,omitempty"`
	Data          string          `json:"data,omitempty"`
}

func (r Request) HasID() bool {
	return len(r.ID) > 0
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ErrorResponse struct {
	ID    json.RawMessage `json:"id,omitempty"`
	OK    bool            `json:"ok"`
	Error Error           `json:"error"`
}
