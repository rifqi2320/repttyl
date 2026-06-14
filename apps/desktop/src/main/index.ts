import { app, BrowserWindow, ipcMain, shell } from "electron";
import started from "electron-squirrel-startup";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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

type GitHubRelease = {
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const defaultSettings: AppSettings = {
  updates: {
    checkOnStartup: true,
    includePrereleases: false,
    repository: "rifqi2320/repttyl",
  },
  remoteAgent: {
    autoInstall: true,
    repository: "rifqi2320/repttyl",
    version: "v0.1.1",
  },
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
  ipcMain.handle("repttyl:settings:get", async (): Promise<AppSettings> => readSettings());
  ipcMain.handle("repttyl:settings:update", async (_event, patch: Partial<AppSettings>): Promise<AppSettings> => {
    const nextSettings = mergeSettings(readSettings(), patch);
    writeSettings(nextSettings);
    return nextSettings;
  });
  ipcMain.handle("repttyl:updates:check", async (): Promise<UpdateCheckResult> => checkForUpdates(readSettings()));
  ipcMain.handle("repttyl:external:open", async (_event, url: string): Promise<void> => {
    if (!url.startsWith("https://github.com/")) {
      throw new Error("Only GitHub release links can be opened from Repttyl.");
    }
    await shell.openExternal(url);
  });

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
    const settings = readSettings();
    return {
      mode: "ssh",
      host: request.host,
      remoteInstall: settings.remoteAgent.autoInstall
        ? {
            repository: settings.remoteAgent.repository,
            version: settings.remoteAgent.version,
          }
        : false,
    };
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

function readSettings(): AppSettings {
  try {
    return mergeSettings(defaultSettings, JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<AppSettings>);
  } catch {
    return defaultSettings;
  }
}

function writeSettings(settings: AppSettings): void {
  const filePath = settingsPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`);
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    updates: {
      ...base.updates,
      ...patch.updates,
    },
    remoteAgent: {
      ...base.remoteAgent,
      ...patch.remoteAgent,
    },
  };
}

async function checkForUpdates(settings: AppSettings): Promise<UpdateCheckResult> {
  const checkedAt = new Date().toISOString();
  const currentVersion = app.getVersion();
  try {
    const releases = await fetchReleases(settings.updates.repository);
    const latest = releases
      .filter((release) => release.tag_name && !release.draft)
      .filter((release) => settings.updates.includePrereleases || !release.prerelease)
      .map((release) => ({ release, parsed: parseVersion(release.tag_name ?? "") }))
      .filter((item): item is { release: GitHubRelease; parsed: ParsedVersion } => Boolean(item.parsed))
      .sort((a, b) => compareVersions(b.parsed, a.parsed))[0];

    if (!latest) {
      return {
        checkedAt,
        currentVersion,
        repository: settings.updates.repository,
        includePrereleases: settings.updates.includePrereleases,
        updateAvailable: false,
        error: "No matching GitHub releases found.",
      };
    }

    const current = parseVersion(currentVersion);
    const updateAvailable = current ? compareVersions(latest.parsed, current) > 0 : true;
    return {
      checkedAt,
      currentVersion,
      repository: settings.updates.repository,
      includePrereleases: settings.updates.includePrereleases,
      updateAvailable,
      latest: {
        version: latest.release.tag_name ?? "",
        name: latest.release.name || latest.release.tag_name || "",
        url: latest.release.html_url || `https://github.com/${settings.updates.repository}/releases`,
        prerelease: Boolean(latest.release.prerelease),
        publishedAt: latest.release.published_at || "",
      },
    };
  } catch (error) {
    return {
      checkedAt,
      currentVersion,
      repository: settings.updates.repository,
      includePrereleases: settings.updates.includePrereleases,
      updateAvailable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchReleases(repository: string): Promise<GitHubRelease[]> {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `repttyl-desktop/${app.getVersion()}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as GitHubRelease[];
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] - b[key];
    }
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) {
    return 0;
  }
  if (a.prerelease.length === 0) {
    return 1;
  }
  if (b.prerelease.length === 0) {
    return -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    if (left === right) {
      continue;
    }
    const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== undefined) {
      return -1;
    }
    if (rightNumber !== undefined) {
      return 1;
    }
    return left.localeCompare(right);
  }
  return 0;
}
