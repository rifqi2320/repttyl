import { Terminal } from "@xterm/xterm";
import type {
  AgentEvent,
  Session,
  TerminalError,
  TerminalOutput,
  Workspace,
  WorkspaceStatus,
} from "@repttyl/protocol-client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type SSHHost = Awaited<ReturnType<typeof window.repttyl.listHosts>>[number];
type ConnectionState = Awaited<ReturnType<typeof window.repttyl.getConnectionState>>;
type AppSettings = Awaited<ReturnType<typeof window.repttyl.getSettings>>;
type UpdateCheckResult = Awaited<ReturnType<typeof window.repttyl.checkForUpdates>>;
type AutoUpdateState = Awaited<ReturnType<typeof window.repttyl.getAutoUpdateStatus>>;
type RepttylToast = {
  text: string;
  level: "info" | "error";
};

type AppState = {
  activeView: "workspace" | "settings";
  hosts: SSHHost[];
  connection: ConnectionState;
  settings?: AppSettings;
  updateCheck?: UpdateCheckResult;
  autoUpdate?: AutoUpdateState;
  workspaces: Workspace[];
  sessions: Session[];
  selectedWorkspace?: Workspace;
  selectedSession?: Session;
  stream?: string;
  streamSessionName?: string;
  busy: boolean;
  updateChecking: boolean;
  autoUpdateChecking: boolean;
  settingsStatus?: string;
  hostError?: string;
  toast?: RepttylToast;
};

const state: AppState = {
  activeView: "workspace",
  hosts: [],
  connection: { connected: false },
  workspaces: [],
  sessions: [],
  busy: false,
  updateChecking: false,
  autoUpdateChecking: false,
};
let renderedSettingsKey = "";
let toastTimer: ReturnType<typeof window.setTimeout> | undefined;
let intentionalDisconnect = false;

const app = document.getElementById("app");
if (!app) {
  throw new Error("Missing app root");
}

app.innerHTML = `
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <section class="shell">
    <aside class="rail">
      <div class="brand">
        <div class="mark">R</div>
        <div>
          <h1>Repttyl</h1>
          <p>Remote shells</p>
        </div>
      </div>
      <nav class="view-nav" aria-label="Primary">
        <button id="showWorkspace" class="nav-button selected" title="Workspace">Workspace</button>
        <button id="showSettings" class="nav-button" title="Settings">Settings</button>
      </nav>
      <div class="host-panel">
        <label for="manualHost">Host</label>
        <div class="manual-host">
          <input id="manualHost" type="text" placeholder="user@host or SSH alias" />
          <button id="connectManual" title="Connect">Connect</button>
        </div>
        <div id="hostError" class="field-error" hidden></div>
        <button id="connectLocal" class="secondary" title="Connect local agent">Local</button>
      </div>
      <div class="list-head">
        <span>SSH Config</span>
        <button id="refreshHosts" class="icon" title="Refresh hosts">Refresh</button>
      </div>
      <div id="hosts" class="host-list"></div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div>
          <div class="connection-stack">
            <div id="stateLabel" class="state-label">Disconnected</div>
            <div id="stateDetail" class="state-detail">Select a host to start.</div>
          </div>
        </div>
        <div class="top-actions">
          <button id="killSession" class="secondary danger" title="Kill selected session">Kill Session</button>
          <button id="disconnect" class="danger" title="Disconnect">Disconnect</button>
        </div>
      </header>

      <div id="updateBanner" class="update-banner" hidden></div>

      <section id="workspaceView" class="workspace-view">
        <section class="browser">
          <div class="column">
            <div class="column-head">
              <div>
                <h2>Workspaces</h2>
                <p>Pick a workspace to browse active sessions.</p>
              </div>
              <div class="inline-actions">
                <button id="refreshWorkspaces" class="icon" title="Refresh workspaces">↻</button>
                <button id="createWorkspace" class="icon" title="New workspace">＋</button>
              </div>
            </div>
            <div id="workspaces" class="rows"></div>
          </div>
          <div class="column">
            <div class="column-head">
              <h2>Sessions</h2>
            </div>
            <div id="sessions" class="rows"></div>
          </div>
        </section>

        <section class="terminal-wrap">
          <div class="terminal-head">
            <div id="terminalTitle">Terminal</div>
            <div id="terminalMeta">No session attached</div>
          </div>
          <div id="terminal"></div>
        </section>
      </section>

      <section id="settingsView" class="settings-view" hidden>
        <div class="settings-header">
          <div>
            <h2>Settings</h2>
            <p>Application behavior, update checks, and remote agent bootstrap.</p>
          </div>
          <div class="settings-save">
            <button id="saveSettings" title="Save settings">Save</button>
            <div id="settingsSaveStatus" class="settings-status"></div>
          </div>
        </div>

        <div class="settings-grid">
          <section class="settings-section">
            <div>
              <h3>Update Checks</h3>
              <p>Check GitHub releases and surface available desktop updates when the app opens.</p>
            </div>
            <label class="setting-row">
              <span>
                <strong>Check on startup</strong>
                <small>Run once when the desktop app opens.</small>
              </span>
              <input id="settingCheckOnStartup" type="checkbox" />
            </label>
            <label class="setting-row">
              <span>
                <strong>Include release candidates</strong>
                <small>Consider prereleases such as <code>v0.1.2-rc.11</code>.</small>
              </span>
              <input id="settingIncludePrereleases" type="checkbox" />
            </label>
            <label class="field-row" for="settingUpdateRepository">
              <span>GitHub repository</span>
              <input id="settingUpdateRepository" type="text" spellcheck="false" />
            </label>
            <div class="settings-actions">
              <button id="checkUpdatesNow" class="secondary" title="Check updates now">Check now</button>
              <div id="updateStatus" class="settings-status"></div>
            </div>
          </section>

          <section class="settings-section">
            <div>
              <h3>Remote Agent Bootstrap</h3>
              <p>Control how SSH hosts get the Go agent when <code>repttyl</code> is not already installed.</p>
            </div>
            <label class="setting-row">
              <span>
                <strong>Auto-install remote agent</strong>
                <small>Download the release archive into <code>~/.local/bin/repttyl</code> over SSH.</small>
              </span>
              <input id="settingRemoteAutoInstall" type="checkbox" />
            </label>
            <label class="field-row" for="settingRemoteRepository">
              <span>Agent release repository</span>
              <input id="settingRemoteRepository" type="text" spellcheck="false" />
            </label>
            <label class="field-row" for="settingRemoteVersion">
              <span>Agent release tag</span>
              <input id="settingRemoteVersion" type="text" spellcheck="false" />
            </label>
            <div class="field-row">
              <span>Session backend</span>
              <div id="settingTerminalBackend" class="backend-control" role="radiogroup" aria-label="Session backend">
                <label class="backend-option">
                  <input type="radio" name="settingTerminalBackend" value="tmux" />
                  <span>tmux</span>
                </label>
                <label class="backend-option">
                  <input type="radio" name="settingTerminalBackend" value="screen" />
                  <span>screen</span>
                </label>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  </section>

  <dialog id="workspaceNameDialog" class="modal">
    <form id="workspaceNameForm" method="dialog">
      <h2>New workspace</h2>
      <label class="field-row" for="workspaceNameInput">
        <span>Name</span>
        <input id="workspaceNameInput" type="text" autocomplete="off" />
      </label>
      <div id="workspaceNameError" class="field-error" hidden></div>
      <div class="modal-actions">
        <button id="workspaceNameCancel" type="button" class="secondary">Cancel</button>
        <button id="workspaceNameCreate" type="submit">Create</button>
      </div>
    </form>
  </dialog>
`;

const terminalElement = document.getElementById("terminal");
if (!terminalElement) {
  throw new Error("Missing terminal root");
}
const terminalRoot = terminalElement;

const terminal = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: '"Berkeley Mono", "SFMono-Regular", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.18,
  theme: {
    background: "#0b0d10",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    selectionBackground: "#32404d",
  },
});
terminal.open(terminalRoot);
terminal.writeln("Repttyl");

terminal.onData((data) => {
  if (state.stream) {
    void window.repttyl.sendTerminalInput(state.stream, data);
  }
});

window.repttyl.onTerminalOutput((message: TerminalOutput) => {
  if (message.stream === state.stream) {
    terminal.write(message.data);
  }
});

window.repttyl.onTerminalError((message: TerminalError) => {
  if (message.stream !== state.stream) {
    return;
  }
  terminal.writeln(`\r\n${message.error.code}: ${message.error.message}`);
  if (!isFatalTerminalError(message.error.code)) {
    return;
  }
  const closedSession = state.streamSessionName;
  state.stream = undefined;
  state.streamSessionName = undefined;
  if (state.selectedSession?.name === closedSession) {
    state.selectedSession = undefined;
  }
  if (message.error.code === "TERMINAL_CLOSED") {
    terminal.writeln("\r\nSession closed.");
    showToast("Session closed.", "error");
  } else {
    showToast("Session connection closed.", "error");
  }
  render();
});

window.repttyl.onConnectionState((nextState) => {
  const wasConnected = state.connection.connected;
  state.connection = nextState;
  if (!nextState.connected && !intentionalDisconnect) {
    const hadStream = state.stream !== undefined;
    resetConnectionState();
    if (wasConnected) {
      if (hadStream) {
        terminal.clear();
        terminal.writeln("\r\nDisconnected from agent.");
      }
      showToast(
        nextState.error ? `Disconnected: ${nextState.error}` : "Disconnected from agent.",
        nextState.error ? "error" : "info",
      );
    }
  }
  render();
});

window.repttyl.onAgentEvent((event: AgentEvent) => {
  if (event.op !== "workspace.status") {
    return;
  }
  applyWorkspaceStatus(event.workspace_id, event.status);
});

window.repttyl.onAutoUpdateStatus((nextState) => {
  state.autoUpdate = nextState;
  render();
});

terminalRoot.addEventListener("click", () => terminal.focus());
new ResizeObserver(() => resizeTerminal()).observe(terminalRoot);

bindUI();
void boot();

function bindUI(): void {
  byID("showWorkspace").addEventListener("click", () => setActiveView("workspace"));
  byID("showSettings").addEventListener("click", () => setActiveView("settings"));
  byID("refreshHosts").addEventListener("click", () => void loadHosts());
  byID("manualHost").addEventListener("input", () => {
    if (state.hostError) {
      state.hostError = undefined;
      render();
    }
  });
  byID("manualHost").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void connectManual();
    }
  });
  byID("connectManual").addEventListener("click", () => {
    void connectManual();
  });
  byID("connectLocal").addEventListener("click", () => void connect({ mode: "local" }));
  byID("disconnect").addEventListener("click", () => void disconnect());
  byID("refreshWorkspaces").addEventListener("click", () => void loadWorkspaces());
  byID("killSession").addEventListener("click", () => {
    if (state.selectedSession) {
      void requestKillSession(state.selectedSession);
    }
  });
  byID("createWorkspace").addEventListener("click", () => void createWorkspace());
  byID("saveSettings").addEventListener("click", () => void saveSettings());
  byID("checkUpdatesNow").addEventListener("click", () => void runUpdateCheck());
}

async function connectManual(): Promise<void> {
  const host = inputValue("manualHost");
  const validation = validateHostInput(host);
  if (!validation.ok) {
    state.hostError = validation.error;
    return render();
  }
  state.hostError = undefined;
  await connect({ mode: "ssh", host });
}

function validateHostInput(value: string): { ok: boolean; error?: string } {
  const candidate = value.trim();
  if (!candidate) {
    return { ok: false, error: "Host is required." };
  }
  if (candidate.includes(" ")) {
    return { ok: false, error: "Host cannot contain spaces." };
  }
  if (candidate.includes("#") || candidate.includes("!") || candidate.includes("*")) {
    return { ok: false, error: "Host contains invalid characters." };
  }
  return { ok: true };
}

async function boot(): Promise<void> {
  const loadErrors: string[] = [];

  await Promise.allSettled([
    loadSafe(loadSettings, "settings").then((result) => {
      if (!result.ok) {
        loadErrors.push(result.error);
      }
    }),
    loadSafe(loadHosts, "hosts").then((result) => {
      if (!result.ok) {
        loadErrors.push(result.error);
      }
    }),
    loadSafe(loadConnectionState, "connection state").then((result) => {
      if (!result.ok) {
        loadErrors.push(result.error);
      }
    }),
    loadSafe(loadAutoUpdateStatus, "auto-update status").then((result) => {
      if (!result.ok) {
        loadErrors.push(result.error);
      }
    }),
  ]);

  if (state.connection.connected) {
    const workspaceResult = await loadSafe(loadWorkspaces, "workspaces");
    if (!workspaceResult.ok && loadErrors.length === 0) {
      loadErrors.push(workspaceResult.error);
    }
    if (state.selectedSession && !state.stream) {
      await attachSession(state.selectedSession);
    }
  }

  if (loadErrors.length > 0) {
    showToast(loadErrors[0] ?? "Some startup data failed to load.", "error");
  }

  render();
  if (state.settings?.updates.checkOnStartup) {
    void runUpdateCheck();
  }
}

async function loadSafe<T>(task: () => Promise<T>, label: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await task();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function loadSettings(): Promise<void> {
  state.settings = await window.repttyl.getSettings();
}

async function loadConnectionState(): Promise<void> {
  state.connection = await window.repttyl.getConnectionState();
}

async function loadAutoUpdateStatus(): Promise<void> {
  state.autoUpdate = await window.repttyl.getAutoUpdateStatus();
}

async function loadHosts(): Promise<void> {
  state.hosts = await window.repttyl.listHosts();
  render();
}

async function connect(request: { mode: "ssh"; host: string } | { mode: "local" }): Promise<void> {
  await withBusy(async () => {
    state.connection = await window.repttyl.connect(request);
    state.hostError = undefined;
    const hostInput = byID("manualHost");
    if (hostInput instanceof HTMLInputElement) {
      hostInput.value = request.mode === "ssh" ? request.host : hostInput.value;
    }
    showToast(request.mode === "ssh" ? `Connected to ${request.host}` : "Connected to local agent");
    await loadWorkspaces();
    if (state.selectedSession && !state.stream) {
      await attachSession(state.selectedSession);
    }
  });
}

async function disconnect(): Promise<void> {
  intentionalDisconnect = true;
  await withBusy(async () => {
    state.connection = await window.repttyl.disconnect();
    resetConnectionState();
    showToast("Disconnected");
    terminal.clear();
    terminal.writeln("Disconnected");
  });
  intentionalDisconnect = false;
}

function resetConnectionState(): void {
  state.workspaces = [];
  state.sessions = [];
  state.selectedWorkspace = undefined;
  state.selectedSession = undefined;
  state.stream = undefined;
  state.streamSessionName = undefined;
}

async function killSession(session: Session): Promise<void> {
  const workspace = state.selectedWorkspace;
  if (!workspace || !state.connection.connected) {
    return;
  }
  await withBusy(async () => {
    await window.repttyl.killSession(workspace.id, session.name);
    const wasActive = state.streamSessionName === session.name;
    if (wasActive) {
      state.stream = undefined;
      state.streamSessionName = undefined;
      terminal.clear();
      terminal.writeln(`Session ${session.name} closed.`);
    }
    if (state.selectedSession?.name === session.name) {
      state.selectedSession = undefined;
    }
    await loadSessions();
    showToast(`Session ${session.name} terminated.`);
  });
}

async function requestKillSession(session: Session): Promise<void> {
  if (!state.connection.connected || !state.selectedWorkspace) {
    return;
  }
  if (!window.confirm(`Kill session ${session.name}?`)) {
    return;
  }
  await killSession(session);
}

async function loadWorkspaces(): Promise<void> {
  if (!state.connection.connected) {
    return;
  }
  await withBusy(async () => {
    const previousWorkspaceID = state.selectedWorkspace?.id;
    state.workspaces = await window.repttyl.listWorkspaces();
    state.selectedWorkspace =
      state.workspaces.find((workspace) => workspace.id === previousWorkspaceID) ?? state.workspaces[0];
    if (!state.selectedWorkspace) {
      state.sessions = [];
      state.selectedSession = undefined;
      return;
    }
    await loadSessions();
  });
}

async function createWorkspace(): Promise<void> {
  if (!state.connection.connected) {
    return;
  }
  const name = await requestWorkspaceName();
  const trimmed = name?.trim();
  if (trimmed && !validateWorkspaceName(trimmed).ok) {
    showToast("Workspace name is invalid.", "error");
    return;
  }
  if (!trimmed) {
    return;
  }
  await withBusy(async () => {
    const workspace = await window.repttyl.createWorkspace(trimmed);
    state.workspaces = await window.repttyl.listWorkspaces();
    state.selectedWorkspace = state.workspaces.find((item) => item.id === workspace.id) ?? workspace;
    state.selectedSession = undefined;
    state.stream = undefined;
    state.streamSessionName = undefined;
    terminal.clear();
    await loadSessions();
    if (state.selectedSession) {
      await attachSession(state.selectedSession);
    }
    showToast(`Workspace ${workspace.name} created.`);
  });
}

function requestWorkspaceName(): Promise<string | undefined> {
  const dialog = byID("workspaceNameDialog");
  const input = byID("workspaceNameInput");
  const form = byID("workspaceNameForm");
  const cancel = byID("workspaceNameCancel");
  const nameError = byID("workspaceNameError");

  if (!(dialog instanceof HTMLDialogElement) || !(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
    return Promise.resolve(undefined);
  }

  input.value = "";
  nameError.textContent = "";
  nameError.setAttribute("hidden", "hidden");

  return new Promise((resolve) => {
    const cleanup = () => {
      dialog.removeEventListener("close", handleClose);
      form.removeEventListener("submit", handleSubmit);
      cancel.removeEventListener("click", handleCancel);
    };
    const handleClose = () => {
      cleanup();
      resolve(dialog.returnValue === "create" ? input.value.trim() : undefined);
    };
    const handleSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      const validation = validateWorkspaceName(input.value.trim());
      if (!validation.ok) {
        nameError.textContent = validation.error ?? "Invalid workspace name.";
        nameError.removeAttribute("hidden");
        return;
      }
      nameError.setAttribute("hidden", "hidden");
      dialog.close("create");
    };
    const handleCancel = () => dialog.close("cancel");

    form.addEventListener("submit", handleSubmit);
    cancel.addEventListener("click", handleCancel);
    dialog.addEventListener("close", handleClose);
    dialog.showModal();
    input.focus();
  });
}

async function selectWorkspace(workspace: Workspace): Promise<void> {
  if (state.selectedWorkspace?.id === workspace.id) {
    return;
  }
  state.selectedWorkspace = workspace;
  state.selectedSession = undefined;
  state.stream = undefined;
  state.streamSessionName = undefined;
  terminal.clear();
  await loadSessions();
  if (state.selectedSession) {
    await attachSession(state.selectedSession);
  }
}

async function loadSessions(): Promise<void> {
  if (!state.selectedWorkspace) {
    state.sessions = [];
    state.selectedSession = undefined;
    render();
    return;
  }

  const previousSessionName = state.selectedSession?.name;
  state.sessions = await window.repttyl.listSessions(state.selectedWorkspace.id);
  state.selectedSession =
    state.sessions.find((session) => session.name === previousSessionName) ?? state.sessions[0] ?? undefined;
  render();
}

async function attachSession(session: Session): Promise<void> {
  const workspace = state.selectedWorkspace;
  if (!workspace || !state.connection.connected) {
    return;
  }
  if (state.stream && state.streamSessionName === session.name) {
    terminal.focus();
    return;
  }

  await withBusy(async () => {
    state.selectedSession = session;
    const size = terminalSize();
    const { stream } = await window.repttyl.attachTerminal({
      workspaceID: workspace.id,
      session: session.name,
      cols: size.cols,
      rows: size.rows,
    });
    state.stream = stream;
    state.streamSessionName = session.name;
    terminal.clear();
    terminal.focus();
    resizeTerminal();
  });
}

function applyWorkspaceStatus(workspaceID: string, status: WorkspaceStatus): void {
  const affectsSelected = state.selectedWorkspace?.id === workspaceID;
  state.workspaces = state.workspaces.map((workspace) =>
    workspace.id === workspaceID ? { ...workspace, status } : workspace,
  );
  if (affectsSelected) {
    void loadSessions();
    return;
  }
  render();
}

function render(): void {
  renderView();
  renderToast();
  renderConnection();
  renderUpdateBanner();
  renderHosts();
  renderWorkspaces();
  renderSessions();
  renderSettings();
}

function setActiveView(view: AppState["activeView"]): void {
  state.activeView = view;
  state.settingsStatus = undefined;
  render();
  if (view === "workspace") {
    resizeTerminal();
  }
}

function renderView(): void {
  byID("workspaceView").hidden = state.activeView !== "workspace";
  byID("settingsView").hidden = state.activeView !== "settings";
  byID("showWorkspace").classList.toggle("selected", state.activeView === "workspace");
  byID("showSettings").classList.toggle("selected", state.activeView === "settings");
}

function renderConnection(): void {
  byID("stateLabel").textContent = state.connection.connected ? "Connected" : "Disconnected";
  byID("stateDetail").textContent = state.connection.connected
    ? `${state.connection.mode === "ssh" ? state.connection.host : "local"} - agent ${state.connection.agentVersion ?? "unknown"}`
    : state.connection.error ?? "Select a host to start.";
  byID("killSession").toggleAttribute(
    "disabled",
    !state.connection.connected || !state.selectedSession || state.busy,
  );
  byID("disconnect").toggleAttribute("disabled", !state.connection.connected || state.busy);
  byID("connectManual").toggleAttribute("disabled", state.busy);
  byID("connectLocal").toggleAttribute("disabled", state.busy);
  const workspaceControlsDisabled = !state.connection.connected || state.busy;
  byID("createWorkspace").toggleAttribute("disabled", workspaceControlsDisabled);
  byID("refreshWorkspaces").toggleAttribute("disabled", workspaceControlsDisabled);
  byID("refreshHosts").toggleAttribute("disabled", state.busy);
}

function renderToast(): void {
  const toast = byID("toast");
  if (!state.toast) {
    toast.textContent = "";
    toast.setAttribute("hidden", "hidden");
    return;
  }

  toast.textContent = state.toast.text;
  toast.classList.toggle("toast-error", state.toast.level === "error");
  toast.removeAttribute("hidden");
}

function renderHosts(): void {
  const error = byID("hostError");
  if (state.hostError) {
    error.textContent = state.hostError;
    error.removeAttribute("hidden");
  } else {
    error.textContent = "";
    error.setAttribute("hidden", "hidden");
  }

  const hosts = byID("hosts");
  hosts.innerHTML = "";

  for (const host of state.hosts) {
    const button = document.createElement("button");
    button.className = `row-button ${state.connection.host === host.alias ? "selected" : ""}`;
    button.innerHTML = `<span>${escapeHTML(host.alias)}</span><small>${escapeHTML(host.user ?? "")}${host.hostName ? ` - ${escapeHTML(host.hostName)}` : ""}</small>`;
    button.addEventListener("click", () => void connect({ mode: "ssh", host: host.alias }));
    hosts.appendChild(button);
  }

  if (state.hosts.length === 0) {
    hosts.innerHTML = `<div class="empty">No SSH config hosts.</div>`;
  }
}

function renderWorkspaces(): void {
  const root = byID("workspaces");
  root.innerHTML = "";
  for (const workspace of state.workspaces) {
    const button = document.createElement("button");
    button.className = `row-button ${state.selectedWorkspace?.id === workspace.id ? "selected" : ""}`;
    button.innerHTML = `<span>${escapeHTML(workspace.name)}</span><small>${escapeHTML(workspace.status ?? "unknown")} - ${escapeHTML(workspace.path)}</small>`;
    button.addEventListener("click", () => void selectWorkspace(workspace));
    root.appendChild(button);
  }

  if (!state.connection.connected) {
    root.innerHTML = `<div class="empty">Connect first.</div>`;
  } else if (state.workspaces.length === 0) {
    root.innerHTML = `<div class="empty">No workspaces.</div>`;
  }
}

function renderSessions(): void {
  const root = byID("sessions");
  root.innerHTML = "";

  for (const session of state.sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    const button = document.createElement("button");
    button.className = `row-button ${state.selectedSession?.name === session.name ? "selected" : ""}`;
    button.innerHTML = `<span>${escapeHTML(session.name)}</span><small>${escapeHTML(session.status)}</small>`;
    button.addEventListener("click", () => void attachSession(session));

    const kill = document.createElement("button");
    kill.className = "row-action";
    kill.type = "button";
    kill.textContent = "⨉";
    kill.title = `Kill ${session.name}`;
    kill.toggleAttribute("disabled", !state.connection.connected || state.busy);
    kill.addEventListener("click", (event) => {
      event.stopPropagation();
      void requestKillSession(session);
    });

    row.append(button, kill);
    root.appendChild(row);
  }

  if (!state.selectedWorkspace) {
    root.innerHTML = `<div class="empty">Select a workspace.</div>`;
  }

  byID("terminalTitle").textContent = state.selectedWorkspace
    ? `${state.selectedWorkspace.name}${state.selectedSession ? ` / ${state.selectedSession.name}` : ""}`
    : "Terminal";
  byID("terminalMeta").textContent = state.stream
    ? "Attached"
    : state.selectedSession
      ? "Attaching session..."
      : "No session attached";
}

function renderSettings(): void {
  const settings = state.settings;
  if (!settings) {
    return;
  }

  const nextSettingsKey = JSON.stringify(settings);
  if (nextSettingsKey !== renderedSettingsKey) {
    setCheckbox("settingCheckOnStartup", settings.updates.checkOnStartup);
    setCheckbox("settingIncludePrereleases", settings.updates.includePrereleases);
    setInput("settingUpdateRepository", settings.updates.repository);
    setCheckbox("settingRemoteAutoInstall", settings.remoteAgent.autoInstall);
    setInput("settingRemoteRepository", settings.remoteAgent.repository);
    setInput("settingRemoteVersion", settings.remoteAgent.version);
    setRadio("settingTerminalBackend", settings.terminal.backend);
    renderedSettingsKey = nextSettingsKey;
  }

  byID("checkUpdatesNow").toggleAttribute("disabled", state.updateChecking);
  byID("saveSettings").toggleAttribute("disabled", state.busy);
  byID("settingsSaveStatus").textContent = state.settingsStatus ?? "";

  const status = byID("updateStatus");
  if (state.autoUpdate?.status === "downloaded") {
    status.textContent = "Desktop update downloaded. Restart to install.";
  } else if (state.autoUpdate?.status === "checking" || state.autoUpdate?.status === "available" || state.autoUpdateChecking) {
    status.textContent = state.autoUpdate?.message ?? "Checking desktop updater...";
  } else if (state.autoUpdate?.status === "error") {
    status.textContent = state.autoUpdate.error ?? state.autoUpdate.message;
  } else if (state.updateChecking) {
    status.textContent = "Checking GitHub releases...";
  } else if (state.updateCheck?.error) {
    status.textContent = state.updateCheck.error;
  } else if (state.updateCheck?.latest) {
    status.textContent = state.updateCheck.updateAvailable
      ? `${state.updateCheck.latest.version} is available.`
      : `Up to date at ${state.updateCheck.currentVersion}.`;
  } else if (state.autoUpdate && !state.autoUpdate.supported) {
    status.textContent = state.autoUpdate.message;
  } else {
    status.textContent = "No check has run yet.";
  }
}

function renderUpdateBanner(): void {
  const banner = byID("updateBanner");
  const result = state.updateCheck;
  const autoUpdate = state.autoUpdate;

  if (autoUpdate?.status === "downloaded") {
    banner.hidden = false;
    banner.innerHTML = `
      <div>
        <strong>Desktop update ready</strong>
        <span>${escapeHTML(autoUpdate.releaseName || autoUpdate.message)}</span>
      </div>
      <button id="installAutoUpdate" class="secondary" title="Restart and install update">Restart to update</button>
    `;
    byID("installAutoUpdate").addEventListener("click", () => void installAutoUpdate());
    return;
  }

  if (!result?.updateAvailable || !result.latest) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }

  banner.hidden = false;
  banner.innerHTML = `
    <div>
      <strong>${escapeHTML(result.latest.version)} available${result.latest.prerelease ? " (RC)" : ""}</strong>
      <span>${escapeHTML(updateBannerDetail(result, autoUpdate))}</span>
    </div>
    ${updateBannerAction(autoUpdate)}
  `;
  const autoButton = document.getElementById("checkAutoUpdate");
  if (autoButton) {
    autoButton.addEventListener("click", () => void runAutoUpdateCheck());
  }
  const releaseButton = document.getElementById("openRelease");
  releaseButton?.addEventListener("click", () => {
    if (result.latest?.url) {
      void window.repttyl.openExternal(result.latest.url);
    }
  });
}

function updateBannerDetail(result: UpdateCheckResult, autoUpdate?: AutoUpdateState): string {
  if (autoUpdate?.supported) {
    if (autoUpdate.status === "checking") {
      return "Checking Electron auto-update feed...";
    }
    if (autoUpdate.status === "available") {
      return "Downloading automatically...";
    }
    if (autoUpdate.status === "error") {
      return autoUpdate.error ?? autoUpdate.message;
    }
    return "Desktop auto-update is available for packaged macOS and Windows builds.";
  }
  return `${result.latest?.name || result.latest?.version} is available on GitHub.`;
}

function updateBannerAction(autoUpdate?: AutoUpdateState): string {
  if (autoUpdate?.supported) {
    const disabled = autoUpdate.status === "checking" || autoUpdate.status === "available" ? " disabled" : "";
    return `<button id="checkAutoUpdate" class="secondary" title="Check and download update"${disabled}>Check updater</button>`;
  }
  return `<button id="openRelease" class="secondary" title="Open release">Open release</button>`;
}

async function saveSettings(): Promise<void> {
  await withBusy(async () => {
    state.settings = await window.repttyl.updateSettings(readSettingsForm());
    state.settingsStatus = "Settings saved.";
    showToast("Settings saved.");
  });
}

async function runUpdateCheck(): Promise<void> {
  try {
    if (state.settings) {
      state.settings = await window.repttyl.updateSettings(readSettingsForm());
    }
    await loadAutoUpdateStatus();
    state.updateChecking = true;
    render();
    try {
      state.updateCheck = await window.repttyl.checkForUpdates();
      if (state.updateCheck.updateAvailable && state.autoUpdate?.supported) {
        state.autoUpdate = await window.repttyl.checkAutoUpdate();
      }
      showToast(state.updateCheck.updateAvailable ? "Update check found a new release." : "You are up to date.");
    } finally {
      state.updateChecking = false;
      render();
    }
  } catch (error) {
    showToast(`Update check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function runAutoUpdateCheck(): Promise<void> {
  try {
    state.autoUpdateChecking = true;
    render();
    state.autoUpdate = await window.repttyl.checkAutoUpdate();
    if (state.autoUpdate.status === "downloaded") {
      showToast("Desktop update downloaded. Restart to install.");
    } else {
      showToast(state.autoUpdate.message);
    }
  } catch (error) {
    showToast(`Auto-update check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    state.autoUpdateChecking = false;
    render();
  }
}

async function installAutoUpdate(): Promise<void> {
  await withBusy(async () => {
    await window.repttyl.installAutoUpdate();
  });
}

function readSettingsForm(): Partial<AppSettings> {
  return {
    updates: {
      checkOnStartup: checkboxValue("settingCheckOnStartup"),
      includePrereleases: checkboxValue("settingIncludePrereleases"),
      repository: inputValue("settingUpdateRepository") || "rifqi2320/repttyl",
    },
    remoteAgent: {
      autoInstall: checkboxValue("settingRemoteAutoInstall"),
      repository: inputValue("settingRemoteRepository") || "rifqi2320/repttyl",
      version: inputValue("settingRemoteVersion") || "v0.1.2-rc.11",
    },
    terminal: {
      backend: radioValue("settingTerminalBackend") === "screen" ? "screen" : "tmux",
    },
  };
}

async function withBusy(task: () => Promise<void>): Promise<void> {
  state.busy = true;
  render();
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(message, "error");
    terminal.writeln(`\r\n${message}`);
  } finally {
    state.busy = false;
    render();
  }
}

function showToast(text: string, level: "info" | "error" = "info", ttlMs = 3500): void {
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  state.toast = { text, level };
  render();
  if (ttlMs <= 0) {
    return;
  }
  toastTimer = setTimeout(() => {
    if (state.toast?.text === text && state.toast.level === level) {
      state.toast = undefined;
      render();
    }
  }, ttlMs);
}

function validateWorkspaceName(name: string): { ok: boolean; error?: string } {
  const normalized = name.trim();
  if (!normalized) {
    return { ok: false, error: "Workspace name is required." };
  }
  if (normalized.length > 100) {
    return { ok: false, error: "Workspace name is too long (max 100)." };
  }
  if (normalized.includes("..") || normalized.startsWith(".") || /[\\/:*?"<>|]/.test(normalized)) {
    return { ok: false, error: "Workspace name contains invalid characters." };
  }
  return { ok: true };
}

function resizeTerminal(): void {
  const size = terminalSize();
  terminal.resize(size.cols, size.rows);
  if (state.stream) {
    void window.repttyl.resizeTerminal(state.stream, size.cols, size.rows);
  }
}

function isFatalTerminalError(code: string): boolean {
  return code === "TERMINAL_CLOSED" || code === "STREAM_NOT_FOUND" || code === "WRITE_FAILED";
}

function terminalSize(): { cols: number; rows: number } {
  const rect = terminalRoot.getBoundingClientRect();
  const style = getComputedStyle(terminalRoot);
  const width =
    rect.width - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
  const height =
    rect.height - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
  const cell = terminalCellSize();

  return {
    cols: Math.max(20, Math.floor(width / cell.width)),
    rows: Math.max(8, Math.floor(height / cell.height)),
  };
}

function terminalCellSize(): { width: number; height: number } {
  const row = terminalRoot.querySelector<HTMLElement>(".xterm-rows > div");
  const textarea = terminalRoot.querySelector<HTMLElement>(".xterm-helper-textarea");
  const rowHeight = row?.getBoundingClientRect().height ?? 0;
  const cellWidth = textarea?.getBoundingClientRect().width ?? 0;

  return {
    width: cellWidth > 0 ? cellWidth : 8.2,
    height: rowHeight > 0 ? rowHeight : 17.5,
  };
}

function byID(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element ${id}`);
  }
  return element;
}

function inputValue(id: string): string {
  const element = byID(id);
  return element instanceof HTMLInputElement ? element.value.trim() : "";
}

function checkboxValue(id: string): boolean {
  const element = byID(id);
  return element instanceof HTMLInputElement ? element.checked : false;
}

function radioValue(name: string): string {
  const element = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return element?.value ?? "";
}

function setInput(id: string, value: string): void {
  const element = byID(id);
  if (element instanceof HTMLInputElement && element.value !== value) {
    element.value = value;
  }
}

function setCheckbox(id: string, value: boolean): void {
  const element = byID(id);
  if (element instanceof HTMLInputElement) {
    element.checked = value;
  }
}

function setRadio(name: string, value: string): void {
  for (const element of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    element.checked = element.value === value;
  }
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char] ?? char;
  });
}
