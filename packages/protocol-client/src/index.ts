export type RequestId = string | number;

export type WorkspaceStatus = "running" | "stopped" | "unavailable";

export type Workspace = {
  id: string;
  name: string;
  slug?: string;
  path: string;
  status?: WorkspaceStatus;
  runtime_path?: string;
  created_at?: string;
  last_used_at?: string;
};

export type AgentRequest =
  | { id: RequestId; op: "hello"; client_version: string }
  | { id: RequestId; op: "workspace.list" }
  | { id: RequestId; op: "workspace.create"; name: string }
  | { id: RequestId; op: "terminal.attach"; workspace_id: string; cols: number; rows: number }
  | { id: RequestId; op: "session.kill"; workspace_id: string; session: string }
  | { id: RequestId; op: "events.subscribe" };

export type StreamRequest =
  | { stream: string; op: "input"; data: string }
  | { stream: string; op: "resize"; cols: number; rows: number };

export type AgentMessage = AgentRequest | StreamRequest;

export type AgentError = {
  code: string;
  message: string;
};

export type AgentSuccessResponse = {
  id: RequestId;
  ok: true;
  [key: string]: unknown;
};

export type AgentErrorResponse = {
  id?: RequestId;
  ok: false;
  error: AgentError;
};

export type AgentResponse = AgentSuccessResponse | AgentErrorResponse;

export type TerminalOutput = {
  stream: string;
  op: "output";
  data: string;
};

export type TerminalError = {
  stream: string;
  op: "error";
  error: AgentError;
};

export type AgentEvent = {
  op: "workspace.status";
  workspace_id: string;
  status: WorkspaceStatus;
  reason?: string;
};

export type InboundAgentMessage = AgentResponse | TerminalOutput | TerminalError | AgentEvent | Record<string, unknown>;

export type AgentConnection = {
  send(message: AgentMessage): void;
  close(): void;
  onMessage(listener: (message: InboundAgentMessage) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
};

export type HelloResult = {
  agent_version: string;
  protocol_version: string;
};

export type WorkspaceListResult = {
  workspaces: Workspace[];
};

export type WorkspaceCreateResult = {
  workspace: Workspace;
};

export type TerminalAttachResult = {
  stream: string;
};

export type TerminalOutputListener = (output: TerminalOutput) => void;
export type TerminalErrorListener = (error: TerminalError) => void;

export class AgentProtocolError extends Error {
  readonly code: string;

  constructor(error: AgentError) {
    super(error.message);
    this.name = "AgentProtocolError";
    this.code = error.code;
  }
}

export class JsonLineDecoder {
  private buffer = "";

  push(chunk: string): InboundAgentMessage[] {
    this.buffer += chunk;
    const messages: InboundAgentMessage[] = [];

    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (rawLine.length === 0) {
        continue;
      }

      messages.push(JSON.parse(rawLine) as InboundAgentMessage);
    }

    return messages;
  }
}

export class AgentClient {
  private nextID = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly outputListeners = new Set<TerminalOutputListener>();
  private readonly terminalErrorListeners = new Set<TerminalErrorListener>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeClose: () => void;

  constructor(private readonly connection: AgentConnection) {
    this.unsubscribeMessage = connection.onMessage((message) => this.handleMessage(message));
    this.unsubscribeClose = connection.onClose((error) => this.rejectPending(error));
  }

  hello(clientVersion: string): Promise<HelloResult> {
    return this.request<HelloResult>({ id: this.allocateID(), op: "hello", client_version: clientVersion });
  }

  listWorkspaces(): Promise<WorkspaceListResult> {
    return this.request<WorkspaceListResult>({ id: this.allocateID(), op: "workspace.list" });
  }

  createWorkspace(name: string): Promise<WorkspaceCreateResult> {
    return this.request<WorkspaceCreateResult>({ id: this.allocateID(), op: "workspace.create", name });
  }

  attachTerminal(workspaceID: string, cols: number, rows: number): Promise<TerminalAttachResult> {
    return this.request<TerminalAttachResult>({
      id: this.allocateID(),
      op: "terminal.attach",
      workspace_id: workspaceID,
      cols,
      rows,
    });
  }

  killSession(workspaceID: string, session = "main"): Promise<void> {
    return this.request<Record<string, never>>({
      id: this.allocateID(),
      op: "session.kill",
      workspace_id: workspaceID,
      session,
    }).then(() => undefined);
  }

  sendTerminalInput(stream: string, data: string): void {
    this.connection.send({ stream, op: "input", data });
  }

  resizeTerminal(stream: string, cols: number, rows: number): void {
    this.connection.send({ stream, op: "resize", cols, rows });
  }

  onTerminalOutput(listener: TerminalOutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onTerminalError(listener: TerminalErrorListener): () => void {
    this.terminalErrorListeners.add(listener);
    return () => this.terminalErrorListeners.delete(listener);
  }

  close(): void {
    this.unsubscribeMessage();
    this.unsubscribeClose();
    this.connection.close();
    this.rejectPending(new Error("Agent client closed"));
  }

  private request<T extends object>(request: AgentRequest): Promise<T> {
    const id = String(request.id);

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as PendingResolve, reject });
      try {
        this.connection.send(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private allocateID(): number {
    const id = this.nextID;
    this.nextID += 1;
    return id;
  }

  private handleMessage(message: InboundAgentMessage): void {
    if (isTerminalOutput(message)) {
      for (const listener of this.outputListeners) {
        listener(message);
      }
      return;
    }

    if (isTerminalError(message)) {
      for (const listener of this.terminalErrorListeners) {
        listener(message);
      }
      return;
    }

    if (!isAgentResponse(message) || message.id === undefined) {
      return;
    }

    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);
    if (message.ok) {
      pending.resolve(withoutResponseEnvelope(message));
    } else {
      pending.reject(new AgentProtocolError(message.error));
    }
  }

  private rejectPending(error?: Error): void {
    const reason = error ?? new Error("Agent connection closed");
    for (const pending of this.pending.values()) {
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

export function encodeMessage(message: AgentMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function createHelloRequest(id: RequestId, clientVersion: string): AgentRequest {
  return { id, op: "hello", client_version: clientVersion };
}

function isAgentResponse(message: InboundAgentMessage): message is AgentResponse {
  return typeof message === "object" && message !== null && "ok" in message;
}

function isTerminalOutput(message: InboundAgentMessage): message is TerminalOutput {
  if (!isRecord(message)) {
    return false;
  }
  const record = message as Record<string, unknown>;

  return (
    record["op"] === "output" &&
    typeof record["stream"] === "string" &&
    typeof record["data"] === "string"
  );
}

function isTerminalError(message: InboundAgentMessage): message is TerminalError {
  if (!isRecord(message)) {
    return false;
  }
  const record = message as Record<string, unknown>;

  return (
    record["op"] === "error" &&
    typeof record["stream"] === "string" &&
    typeof record["error"] === "object"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function withoutResponseEnvelope(response: AgentSuccessResponse): Record<string, unknown> {
  const { id: _id, ok: _ok, ...payload } = response;
  return payload;
}

type PendingResolve = (value: Record<string, unknown>) => void;

type PendingRequest = {
  resolve: PendingResolve;
  reject: (reason?: unknown) => void;
};
