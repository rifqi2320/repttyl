import { app, BrowserWindow, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentClient, type AgentEvent, type Session, type TerminalError, type TerminalOutput, type Workspace } from "@repttyl/protocol-client";
import {
  createAgentConnection,
  listSSHHosts,
  resolveDefaultAgentBinary,
  type AgentTransport,
  type SSHHost,
} from "@repttyl/client-node";

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
  terminal: {
    backend: "tmux" | "screen";
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

type GitHubRelease = {
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
};

type GitHubRepository = {
  owner: string;
  repo: string;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const defaultRepository = "rifqi2320/repttyl";
const currentRemoteAgentVersion = "v0.1.2-rc.10";
const previousDefaultRemoteAgentVersions = new Set([
  "v0.1.2-rc.1",
  "v0.1.2-rc.2",
  "v0.1.2-rc.3",
  "v0.1.2-rc.4",
  "v0.1.2-rc.5",
  "v0.1.2-rc.6",
  "v0.1.2-rc.7",
  "v0.1.2-rc.8",
  "v0.1.2-rc.9",
]);

const defaultSettings: AppSettings = {
  updates: {
    checkOnStartup: true,
    includePrereleases: false,
    repository: defaultRepository,
  },
  remoteAgent: {
    autoInstall: true,
    repository: defaultRepository,
    version: currentRemoteAgentVersion,
  },
  terminal: {
    backend: "tmux",
  },
};

let mainWindow: BrowserWindow | undefined;
let client: AgentClient | undefined;
let state: ConnectionState = { connected: false };
let outputUnsubscribe: (() => void) | undefined;
let errorUnsubscribe: (() => void) | undefined;
let eventUnsubscribe: (() => void) | undefined;
let autoUpdateState: AutoUpdateState = {
  supported: false,
  status: "unsupported",
  message: "Auto-update is only available in packaged desktop builds.",
};
let autoUpdateEventsBound = false;

if (process.platform === "win32") {
  app.setAppUserModelId("com.rifqi2320.repttyl");
}

if (process.env.REPTTYL_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  for (const electronSwitch of [
    "disable-gpu",
    "disable-gpu-compositing",
    "disable-gpu-rasterization",
    "disable-accelerated-2d-canvas",
    "disable-vulkan",
  ]) {
    app.commandLine.appendSwitch(electronSwitch);
  }
  app.commandLine.appendSwitch("disable-features", "VaapiVideoDecoder,CanvasOopRasterization,Vulkan,VizDisplayCompositor");
}

if (process.env.REPTTYL_VNC === "1") {
  app.commandLine.appendSwitch("disable-dev-shm-usage");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("ozone-platform", "x11");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-features", "VaapiVideoDecoder,CanvasOopRasterization,Vulkan");
}

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: "#101317",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
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
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`renderer process gone: ${details.reason} (${details.exitCode})`);
  });
  if (process.env.REPTTYL_DEBUG_RENDERER === "1") {
    window.webContents.on("console-message", (_event, level, message, line, sourceID) => {
      console.log(`renderer console[${level}] ${sourceID}:${line}: ${message}`);
    });
  }
  window.webContents.on("did-finish-load", () => {
    if (process.env.REPTTYL_DEBUG_RENDERER === "1") {
      void window.webContents
        .executeJavaScript(
          `JSON.stringify({
            title: document.title,
            bodyText: document.body.innerText.slice(0, 300),
            bodyHTML: document.body.innerHTML.slice(0, 500),
            bodyBackground: getComputedStyle(document.body).backgroundColor,
            appBackground: getComputedStyle(document.getElementById("app") ?? document.body).backgroundColor
          })`,
        )
        .then((snapshot) => console.log(`renderer snapshot ${snapshot}`))
        .catch((error: unknown) => console.error("renderer snapshot failed", error));
    }
    if (process.env.REPTTYL_CAPTURE_PAGE === "1") {
      void window.webContents
        .capturePage()
        .then((image) => {
          const capturePath = "/tmp/repttyl-electron-capture.png";
          writeFileSync(capturePath, image.toPNG());
          console.log(`renderer capture ${capturePath}`);
        })
        .catch((error: unknown) => console.error("renderer capture failed", error));
    }
  });

  void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  if (process.env.REPTTYL_OPEN_DEVTOOLS === "1") {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.openDevTools({ mode: "detach" });
      }
    });
  }
};

void app.whenReady().then(() => {
  registerIPC();
  configureAutoUpdater(readSettings());
  createWindow();
  const settings = readSettings();
  if (settings.updates.checkOnStartup) {
    const delay = process.platform === "win32" && process.argv.includes("--squirrel-firstrun") ? 10_000 : 2_000;
    setTimeout(() => {
      void checkForUpdates(settings).then((result) => {
        if (result.updateAvailable) {
          checkElectronAutoUpdate();
        }
      });
    }, delay);
  }
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
    configureAutoUpdater(nextSettings);
    return nextSettings;
  });
  ipcMain.handle("repttyl:updates:check", async (): Promise<UpdateCheckResult> => checkForUpdates(readSettings()));
  ipcMain.handle("repttyl:auto-update:status", async (): Promise<AutoUpdateState> => autoUpdateState);
  ipcMain.handle("repttyl:auto-update:check", async (): Promise<AutoUpdateState> => checkElectronAutoUpdate());
  ipcMain.handle("repttyl:auto-update:install", async (): Promise<void> => {
    if (autoUpdateState.status !== "downloaded") {
      throw new Error("No downloaded update is ready to install.");
    }
    autoUpdater.quitAndInstall();
  });
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
      const hello = await nextClient.hello("0.1.2-rc.10");
      state = {
        connected: true,
        mode: request.mode,
        host: request.mode === "ssh" ? request.host : undefined,
        agentVersion: hello.agent_version,
        protocolVersion: hello.protocol_version,
      };
      publishState();
      void nextClient.subscribeEvents().catch(() => undefined);
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
  ipcMain.handle("repttyl:session:kill", async (_event, request: { workspaceID: string; session: string }): Promise<void> => {
    await requireClient().killSession(request.workspaceID, request.session);
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
            backend: settings.terminal.backend,
          }
        : false,
      backend: settings.terminal.backend,
    };
  }

  return { mode: "local", agentBinary: request.agentBinary ?? resolveDefaultAgentBinary(), backend: readSettings().terminal.backend };
}

function bindTerminalEvents(nextClient: AgentClient): void {
  outputUnsubscribe = nextClient.onTerminalOutput((message: TerminalOutput) => {
    sendToMainWindow("repttyl:terminal:output", message);
  });
  errorUnsubscribe = nextClient.onTerminalError((message: TerminalError) => {
    sendToMainWindow("repttyl:terminal:error", message);
  });
  eventUnsubscribe = nextClient.onAgentEvent((event: AgentEvent) => {
    sendToMainWindow("repttyl:agent:event", event);
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
  eventUnsubscribe?.();
  outputUnsubscribe = undefined;
  errorUnsubscribe = undefined;
  eventUnsubscribe = undefined;
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

function configureAutoUpdater(settings: AppSettings): void {
  bindAutoUpdaterEvents();

  if (process.platform === "linux") {
    setAutoUpdateState({
      supported: false,
      status: "unsupported",
      message: "Desktop auto-update is not enabled for Linux tarball builds. Use your package manager or the GitHub release.",
    });
    return;
  }

  if (!app.isPackaged && process.env.REPTTYL_FORCE_AUTO_UPDATE !== "1") {
    setAutoUpdateState({
      supported: false,
      status: "unsupported",
      message: "Auto-update runs only in packaged desktop builds.",
    });
    return;
  }

  const repository = parseGitHubRepository(settings.updates.repository);
  if (!repository) {
    setAutoUpdateState({
      supported: false,
      status: "unsupported",
      message: `Invalid GitHub repository: ${settings.updates.repository}`,
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.allowPrerelease = settings.updates.includePrereleases;
  autoUpdater.allowDowngrade = false;
  autoUpdater.channel = updateChannelForSettings(settings);
  autoUpdater.setFeedURL({
    provider: "github",
    owner: repository.owner,
    repo: repository.repo,
  });

  const feedURL = `github:${repository.owner}/${repository.repo}#${autoUpdater.channel}`;
  setAutoUpdateState({
    supported: true,
    status: "idle",
    message: "Auto-update is ready.",
    feedURL,
  });
}

function bindAutoUpdaterEvents(): void {
  if (autoUpdateEventsBound) {
    return;
  }
  autoUpdateEventsBound = true;

  autoUpdater.on("checking-for-update", () => {
    setAutoUpdateState({
      ...autoUpdateState,
      status: "checking",
      message: "Checking for desktop update...",
      error: undefined,
    });
  });
  autoUpdater.on("update-available", () => {
    setAutoUpdateState({
      ...autoUpdateState,
      status: "available",
      message: "Desktop update found. Downloading automatically...",
      error: undefined,
    });
  });
  autoUpdater.on("update-not-available", () => {
    setAutoUpdateState({
      ...autoUpdateState,
      status: "not-available",
      message: "Desktop app is up to date.",
      error: undefined,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setAutoUpdateState({
      ...autoUpdateState,
      status: "downloaded",
      message: "Desktop update downloaded. Restart to install.",
      releaseName: info.version,
      error: undefined,
    });
  });
  autoUpdater.on("error", (error) => {
    setAutoUpdateState({
      ...autoUpdateState,
      status: "error",
      message: "Desktop auto-update failed.",
      error: error.message,
    });
  });
}

function checkElectronAutoUpdate(): AutoUpdateState {
  if (!autoUpdateState.supported) {
    return autoUpdateState;
  }
  if (autoUpdateState.status === "checking" || autoUpdateState.status === "available") {
    return autoUpdateState;
  }
  try {
    void autoUpdater.checkForUpdates();
  } catch (error) {
    setAutoUpdateState({
      ...autoUpdateState,
      status: "error",
      message: "Desktop auto-update failed.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return autoUpdateState;
}

function parseGitHubRepository(value: string): GitHubRepository | undefined {
  const match = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    return undefined;
  }
  return { owner: match[1], repo: match[2] };
}

function updateChannelForSettings(settings: AppSettings): string {
  if (!settings.updates.includePrereleases) {
    return "latest";
  }

  const current = parseVersion(app.getVersion());
  const prereleaseChannel = current?.prerelease.find((part) => /^[A-Za-z][0-9A-Za-z-]*$/.test(part));
  return prereleaseChannel || "rc";
}

function setAutoUpdateState(nextState: AutoUpdateState): void {
  autoUpdateState = nextState;
  sendToMainWindow("repttyl:auto-update:status", autoUpdateState);
}

function readSettings(): AppSettings {
  try {
    const settings = mergeSettings(defaultSettings, JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<AppSettings>);
    return migrateSettings(settings);
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
    terminal: {
      ...base.terminal,
      ...patch.terminal,
    },
  };
}

function migrateSettings(settings: AppSettings): AppSettings {
  if (
    settings.remoteAgent.autoInstall &&
    settings.remoteAgent.repository === defaultRepository &&
    previousDefaultRemoteAgentVersions.has(settings.remoteAgent.version)
  ) {
    return {
      ...settings,
      remoteAgent: {
        ...settings.remoteAgent,
        version: currentRemoteAgentVersion,
      },
    };
  }

  return settings;
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
