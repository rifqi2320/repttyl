import { app, BrowserWindow, ipcMain } from "electron";
import started from "electron-squirrel-startup";
import { AgentClient, type Session, type TerminalError, type TerminalOutput, type Workspace } from "@repttyl/protocol-client";
import {
  createAgentConnection,
  listSSHHosts,
  resolveDefaultAgentBinary,
  type AgentTransport,
  type SSHHost,
} from "@repttyl/client-node";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

type ConnectRequest =
  | { mode: "ssh"; host: string }
  | { mode: "local"; agentBinary?: string };

type ConnectionState = {
  connected: boolean;
  mode?: "ssh" | "local";
  host?: string;
  agentVersion?: string;
  protocolVersion?: string;
  error?: string;
};

let mainWindow: BrowserWindow | undefined;
let client: AgentClient | undefined;
let state: ConnectionState = { connected: false };
let outputUnsubscribe: (() => void) | undefined;
let errorUnsubscribe: (() => void) | undefined;

if (started) {
  app.quit();
}

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "Repttyl",
  });

  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
};

void app.whenReady().then(() => {
  registerIPC();
  createWindow();
});

app.on("window-all-closed", () => {
  disconnect();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function registerIPC(): void {
  ipcMain.handle("repttyl:hosts:list", async (): Promise<SSHHost[]> => listSSHHosts());
  ipcMain.handle("repttyl:connection:state", async (): Promise<ConnectionState> => state);

  ipcMain.handle("repttyl:connection:connect", async (_event, request: ConnectRequest): Promise<ConnectionState> => {
    disconnect();

    const nextClient = new AgentClient(createAgentConnection(resolveTransport(request)));

    client = nextClient;
    bindTerminalEvents(nextClient);

    try {
      const hello = await nextClient.hello("0.1.1");
      state = {
        connected: true,
        mode: request.mode,
        host: request.mode === "ssh" ? request.host : undefined,
        agentVersion: hello.agent_version,
        protocolVersion: hello.protocol_version,
      };
      publishState();
      return state;
    } catch (error) {
      disconnect(error instanceof Error ? error.message : String(error));
      throw error;
    }
  });

  ipcMain.handle("repttyl:connection:disconnect", async (): Promise<ConnectionState> => {
    disconnect();
    return state;
  });

  ipcMain.handle("repttyl:workspace:list", async (): Promise<Workspace[]> => requireClient().listWorkspaces().then((r) => r.workspaces));
  ipcMain.handle("repttyl:workspace:create", async (_event, name: string): Promise<Workspace> => {
    return requireClient().createWorkspace(name).then((r) => r.workspace);
  });
  ipcMain.handle("repttyl:session:list", async (_event, workspaceID: string): Promise<Session[]> => {
    return requireClient().listSessions(workspaceID).then((r) => r.sessions);
  });
  ipcMain.handle(
    "repttyl:terminal:attach",
    async (_event, request: { workspaceID: string; session: string; cols: number; rows: number }): Promise<{ stream: string }> => {
      return requireClient().attachTerminal(request.workspaceID, request.cols, request.rows, request.session);
    },
  );
  ipcMain.handle("repttyl:terminal:input", async (_event, request: { stream: string; data: string }): Promise<void> => {
    requireClient().sendTerminalInput(request.stream, request.data);
  });
  ipcMain.handle("repttyl:terminal:resize", async (_event, request: { stream: string; cols: number; rows: number }): Promise<void> => {
    requireClient().resizeTerminal(request.stream, request.cols, request.rows);
  });
}

function resolveTransport(request: ConnectRequest): AgentTransport {
  if (request.mode === "ssh") {
    return { mode: "ssh", host: request.host };
  }

  return { mode: "local", agentBinary: request.agentBinary ?? resolveDefaultAgentBinary() };
}

function bindTerminalEvents(nextClient: AgentClient): void {
  outputUnsubscribe = nextClient.onTerminalOutput((message: TerminalOutput) => {
    sendToMainWindow("repttyl:terminal:output", message);
  });
  errorUnsubscribe = nextClient.onTerminalError((message: TerminalError) => {
    sendToMainWindow("repttyl:terminal:error", message);
  });
}

function requireClient(): AgentClient {
  if (!client) {
    throw new Error("Not connected");
  }
  return client;
}

function disconnect(error?: string): void {
  outputUnsubscribe?.();
  errorUnsubscribe?.();
  outputUnsubscribe = undefined;
  errorUnsubscribe = undefined;
  client?.close();
  client = undefined;
  state = { connected: false, error };
  publishState();
}

function publishState(): void {
  sendToMainWindow("repttyl:connection:state", state);
}

function sendToMainWindow(channel: string, ...args: unknown[]): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }

  window.webContents.send(channel, ...args);
}
