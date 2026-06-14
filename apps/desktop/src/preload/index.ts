import { contextBridge, ipcRenderer } from "electron";
import type { Session, TerminalError, TerminalOutput, Workspace } from "@repttyl/protocol-client";
import type { SSHHost } from "@repttyl/client-node";

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

type AppSettings = {
  updates: {
    checkOnStartup: boolean;
    includePrereleases: boolean;
    repository: string;
  };
  remoteAgent: {
    autoInstall: boolean;
    repository: string;
    version: string;
  };
};

type UpdateCheckResult = {
  checkedAt: string;
  currentVersion: string;
  repository: string;
  includePrereleases: boolean;
  updateAvailable: boolean;
  latest?: {
    version: string;
    name: string;
    url: string;
    prerelease: boolean;
    publishedAt: string;
  };
  error?: string;
};

type AutoUpdateState = {
  supported: boolean;
  status: "unsupported" | "idle" | "checking" | "available" | "not-available" | "downloaded" | "error";
  message: string;
  feedURL?: string;
  releaseName?: string;
  error?: string;
};

type TerminalAttachRequest = {
  workspaceID: string;
  session: string;
  cols: number;
  rows: number;
};

const api = {
  listHosts: (): Promise<SSHHost[]> => ipcRenderer.invoke("repttyl:hosts:list"),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("repttyl:settings:get"),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke("repttyl:settings:update", patch),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("repttyl:updates:check"),
  getAutoUpdateStatus: (): Promise<AutoUpdateState> => ipcRenderer.invoke("repttyl:auto-update:status"),
  checkAutoUpdate: (): Promise<AutoUpdateState> => ipcRenderer.invoke("repttyl:auto-update:check"),
  installAutoUpdate: (): Promise<void> => ipcRenderer.invoke("repttyl:auto-update:install"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("repttyl:external:open", url),
  getConnectionState: (): Promise<ConnectionState> => ipcRenderer.invoke("repttyl:connection:state"),
  connect: (request: ConnectRequest): Promise<ConnectionState> => ipcRenderer.invoke("repttyl:connection:connect", request),
  disconnect: (): Promise<ConnectionState> => ipcRenderer.invoke("repttyl:connection:disconnect"),
  listWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke("repttyl:workspace:list"),
  createWorkspace: (name: string): Promise<Workspace> => ipcRenderer.invoke("repttyl:workspace:create", name),
  listSessions: (workspaceID: string): Promise<Session[]> => ipcRenderer.invoke("repttyl:session:list", workspaceID),
  attachTerminal: (request: TerminalAttachRequest): Promise<{ stream: string }> => ipcRenderer.invoke("repttyl:terminal:attach", request),
  sendTerminalInput: (stream: string, data: string): Promise<void> => ipcRenderer.invoke("repttyl:terminal:input", { stream, data }),
  resizeTerminal: (stream: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("repttyl:terminal:resize", { stream, cols, rows }),
  onTerminalOutput: (listener: (message: TerminalOutput) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: TerminalOutput) => listener(message);
    ipcRenderer.on("repttyl:terminal:output", wrapped);
    return () => ipcRenderer.off("repttyl:terminal:output", wrapped);
  },
  onTerminalError: (listener: (message: TerminalError) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: TerminalError) => listener(message);
    ipcRenderer.on("repttyl:terminal:error", wrapped);
    return () => ipcRenderer.off("repttyl:terminal:error", wrapped);
  },
  onConnectionState: (listener: (state: ConnectionState) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: ConnectionState) => listener(state);
    ipcRenderer.on("repttyl:connection:state", wrapped);
    return () => ipcRenderer.off("repttyl:connection:state", wrapped);
  },
  onAutoUpdateStatus: (listener: (state: AutoUpdateState) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: AutoUpdateState) => listener(state);
    ipcRenderer.on("repttyl:auto-update:status", wrapped);
    return () => ipcRenderer.off("repttyl:auto-update:status", wrapped);
  },
};

contextBridge.exposeInMainWorld("repttyl", api);

export type RepttylDesktopAPI = typeof api;
