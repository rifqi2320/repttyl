import { Terminal } from "@xterm/xterm";
import type { Session, TerminalError, TerminalOutput, Workspace } from "@repttyl/protocol-client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type SSHHost = Awaited<ReturnType<typeof window.repttyl.listHosts>>[number];
type ConnectionState = Awaited<ReturnType<typeof window.repttyl.getConnectionState>>;

type AppState = {
  hosts: SSHHost[];
  connection: ConnectionState;
  workspaces: Workspace[];
  sessions: Session[];
  selectedHost?: string;
  selectedWorkspace?: Workspace;
  selectedSession?: Session;
  stream?: string;
  busy: boolean;
  message?: string;
};

const state: AppState = {
  hosts: [],
  connection: { connected: false },
  workspaces: [],
  sessions: [],
  busy: false,
};

const app = document.getElementById("app");
if (!app) {
  throw new Error("Missing app root");
}

app.innerHTML = `
  <section class="shell">
    <aside class="rail">
      <div class="brand">
        <div class="mark">R</div>
        <div>
          <h1>Repttyl</h1>
          <p>Remote shells</p>
        </div>
      </div>
      <div class="host-panel">
        <label for="manualHost">Host</label>
        <div class="manual-host">
          <input id="manualHost" type="text" placeholder="user@host or SSH alias" />
          <button id="connectManual" title="Connect">Connect</button>
        </div>
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
          <div id="stateLabel" class="state-label">Disconnected</div>
          <div id="stateDetail" class="state-detail">Select a host to start.</div>
        </div>
        <div class="top-actions">
          <button id="refreshWorkspaces" class="secondary" title="Refresh workspaces">Refresh</button>
          <button id="disconnect" class="danger" title="Disconnect">Disconnect</button>
        </div>
      </header>

      <section class="browser">
        <div class="column">
          <div class="column-head">
            <h2>Workspaces</h2>
            <button id="createWorkspace" class="icon" title="New workspace">+</button>
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
    </main>
  </section>
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
  if (message.stream === state.stream) {
    terminal.writeln(`\r\n${message.error.code}: ${message.error.message}`);
  }
});

window.repttyl.onConnectionState((nextState) => {
  state.connection = nextState;
  render();
});

terminalRoot.addEventListener("click", () => terminal.focus());
new ResizeObserver(() => resizeTerminal()).observe(terminalRoot);

bindUI();
void boot();

function bindUI(): void {
  byID("refreshHosts").addEventListener("click", () => void loadHosts());
  byID("connectManual").addEventListener("click", () => {
    const host = inputValue("manualHost");
    if (host) {
      void connect({ mode: "ssh", host });
    }
  });
  byID("connectLocal").addEventListener("click", () => void connect({ mode: "local" }));
  byID("disconnect").addEventListener("click", () => void disconnect());
  byID("refreshWorkspaces").addEventListener("click", () => void loadWorkspaces());
  byID("createWorkspace").addEventListener("click", () => void createWorkspace());
}

async function boot(): Promise<void> {
  await Promise.all([loadHosts(), loadConnectionState()]);
  render();
}

async function loadConnectionState(): Promise<void> {
  state.connection = await window.repttyl.getConnectionState();
}

async function loadHosts(): Promise<void> {
  state.hosts = await window.repttyl.listHosts();
  render();
}

async function connect(request: { mode: "ssh"; host: string } | { mode: "local" }): Promise<void> {
  await withBusy(async () => {
    state.connection = await window.repttyl.connect(request);
    state.selectedHost = request.mode === "ssh" ? request.host : undefined;
    await loadWorkspaces();
  });
}

async function disconnect(): Promise<void> {
  await withBusy(async () => {
    state.connection = await window.repttyl.disconnect();
    state.workspaces = [];
    state.sessions = [];
    state.selectedWorkspace = undefined;
    state.selectedSession = undefined;
    state.stream = undefined;
    terminal.clear();
    terminal.writeln("Disconnected");
  });
}

async function loadWorkspaces(): Promise<void> {
  if (!state.connection.connected) {
    return;
  }
  await withBusy(async () => {
    state.workspaces = await window.repttyl.listWorkspaces();
    state.selectedWorkspace = state.workspaces[0];
    await loadSessions();
  });
}

async function createWorkspace(): Promise<void> {
  if (!state.connection.connected) {
    return;
  }
  const name = window.prompt("Workspace name");
  if (!name?.trim()) {
    return;
  }
  await withBusy(async () => {
    const workspace = await window.repttyl.createWorkspace(name.trim());
    state.workspaces = await window.repttyl.listWorkspaces();
    state.selectedWorkspace = state.workspaces.find((item) => item.id === workspace.id) ?? workspace;
    await loadSessions();
  });
}

async function selectWorkspace(workspace: Workspace): Promise<void> {
  state.selectedWorkspace = workspace;
  state.selectedSession = undefined;
  await loadSessions();
}

async function loadSessions(): Promise<void> {
  if (!state.selectedWorkspace) {
    state.sessions = [];
    state.selectedSession = undefined;
    render();
    return;
  }

  state.sessions = await window.repttyl.listSessions(state.selectedWorkspace.id);
  state.selectedSession = state.sessions[0];
  render();
}

async function attachSession(session: Session): Promise<void> {
  const workspace = state.selectedWorkspace;
  if (!workspace) {
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
    terminal.clear();
    terminal.focus();
    resizeTerminal();
  });
}

function render(): void {
  renderConnection();
  renderHosts();
  renderWorkspaces();
  renderSessions();
}

function renderConnection(): void {
  byID("stateLabel").textContent = state.connection.connected ? "Connected" : "Disconnected";
  byID("stateDetail").textContent = state.connection.connected
    ? `${state.connection.mode === "ssh" ? state.connection.host : "local"} - agent ${state.connection.agentVersion ?? "unknown"}`
    : state.connection.error ?? "Select a host to start.";
  byID("refreshWorkspaces").toggleAttribute("disabled", !state.connection.connected || state.busy);
  byID("disconnect").toggleAttribute("disabled", !state.connection.connected || state.busy);
  byID("connectManual").toggleAttribute("disabled", state.busy);
  byID("connectLocal").toggleAttribute("disabled", state.busy);
}

function renderHosts(): void {
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
    const button = document.createElement("button");
    button.className = `row-button ${state.selectedSession?.name === session.name ? "selected" : ""}`;
    button.innerHTML = `<span>${escapeHTML(session.name)}</span><small>${escapeHTML(session.status)}</small>`;
    button.addEventListener("click", () => void attachSession(session));
    root.appendChild(button);
  }

  if (!state.selectedWorkspace) {
    root.innerHTML = `<div class="empty">Select a workspace.</div>`;
  }

  byID("terminalTitle").textContent = state.selectedWorkspace
    ? `${state.selectedWorkspace.name}${state.selectedSession ? ` / ${state.selectedSession.name}` : ""}`
    : "Terminal";
  byID("terminalMeta").textContent = state.stream ? "Attached" : "No session attached";
}

async function withBusy(task: () => Promise<void>): Promise<void> {
  state.busy = true;
  render();
  try {
    await task();
  } catch (error) {
    state.message = error instanceof Error ? error.message : String(error);
    terminal.writeln(`\r\n${state.message}`);
  } finally {
    state.busy = false;
    render();
  }
}

function resizeTerminal(): void {
  const size = terminalSize();
  terminal.resize(size.cols, size.rows);
  if (state.stream) {
    void window.repttyl.resizeTerminal(state.stream, size.cols, size.rows);
  }
}

function terminalSize(): { cols: number; rows: number } {
  const rect = terminalRoot.getBoundingClientRect();
  return {
    cols: Math.max(20, Math.floor(rect.width / 8.2)),
    rows: Math.max(8, Math.floor(rect.height / 16.2)),
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
