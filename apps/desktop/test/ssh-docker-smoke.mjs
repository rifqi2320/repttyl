#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const desktopBinary = path.join(desktopRoot, "out", "linux-unpacked", "repttyl-desktop");
const hostAlias = "repttyl-docker-ssh-smoke";
const skipBuild = process.argv.includes("--skip-build");
const display = process.env.DISPLAY || ":99";

const resources = {
  root: mkdtempSync(path.join(tmpdir(), "repttyl-desktop-ssh-smoke-")),
  container: `repttyl-desktop-ssh-smoke-${process.pid}-${Date.now()}`,
  image: `repttyl-desktop-ssh-smoke:${process.pid}-${Date.now()}`,
  electron: undefined,
};

let cleaningUp = false;

process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

try {
  requireCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
  requireCommand("ssh", ["-V"]);
  requireExecutable("ssh-keygen");

  if (!skipBuild) {
    run("pnpm", ["--filter", "@repttyl/desktop", "package"], { cwd: repoRoot, stdio: "inherit", timeout: 180_000 });
  } else if (!existsSync(desktopBinary)) {
    throw new Error(`Packaged desktop binary not found at ${desktopBinary}. Run without --skip-build first.`);
  }

  if (process.platform !== "linux") {
    throw new Error(`This smoke test currently expects the Linux packaged app, got ${process.platform}.`);
  }

  const sshPort = await createSSHContainer();
  const sshEnv = createSSHConfig(sshPort);
  await waitForSSH(sshEnv.home);

  const debugPort = await freePort();
  resources.electron = spawn(desktopBinary, ["--no-sandbox", `--remote-debugging-port=${debugPort}`], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DISPLAY: display,
      ELECTRON_DISABLE_SANDBOX: "1",
      HOME: sshEnv.home,
      PATH: `${sshEnv.binDir}:${process.env.PATH}`,
      REPTTYL_VNC: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let electronOutput = "";
  resources.electron.stdout.setEncoding("utf8");
  resources.electron.stderr.setEncoding("utf8");
  resources.electron.stdout.on("data", (chunk) => {
    electronOutput += chunk;
  });
  resources.electron.stderr.on("data", (chunk) => {
    electronOutput += chunk;
  });

  resources.electron.on("exit", (code, signal) => {
    if (!cleaningUp && code !== 0) {
      console.error(`Electron exited early with code ${code}${signal ? ` signal ${signal}` : ""}`);
      console.error(electronOutput.trim());
    }
  });

  const page = await waitForDevToolsPage(debugPort);
  const result = await evaluateSmoke(page.webSocketDebuggerUrl);

  console.log(JSON.stringify(result, null, 2));

  assert.equal(result.hostFound, true, "temporary SSH host was not visible in Electron");
  assert.equal(result.hostRendered, true, "temporary SSH host was not rendered in the sidebar");
  assert.equal(result.connected, true, result.connectionError || "Electron SSH connection failed");
  assert.equal(result.stateLabel, "Connected");
  assert.equal(result.workspaceName, "Docker SSH Smoke");
  assert.equal(result.sessionCount, 1);
  assert.equal(result.terminalEchoSeen, true, "terminal attach did not echo the smoke marker");

} finally {
  cleanup();
}

function requireCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} is not available: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
  }
}

function requireExecutable(command) {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} is not available on PATH.`);
  }
}

async function createSSHContainer() {
  const context = path.join(resources.root, "docker");
  mkdirSync(context, { recursive: true });

  const keyPath = path.join(resources.root, "id_ed25519");
  run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "repttyl-desktop-ssh-smoke"], {
    cwd: resources.root,
    stdio: "ignore",
    timeout: 30_000,
  });

  writeFileSync(
    path.join(context, "Dockerfile"),
    `FROM debian:bookworm-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends openssh-server ca-certificates curl tmux bash tar gzip \\
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash repttyl \\
  && mkdir -p /run/sshd /home/repttyl/.ssh \\
  && chmod 700 /home/repttyl/.ssh
COPY id_ed25519.pub /home/repttyl/.ssh/authorized_keys
RUN chown -R repttyl:repttyl /home/repttyl/.ssh \\
  && chmod 600 /home/repttyl/.ssh/authorized_keys
ENV SHELL=/bin/bash
ENV TERM=xterm-256color
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`,
  );

  run("cp", [`${keyPath}.pub`, path.join(context, "id_ed25519.pub")], { cwd: resources.root });
  run("docker", ["build", "-t", resources.image, context], { cwd: repoRoot, stdio: "inherit", timeout: 300_000 });
  run("docker", ["run", "-d", "--name", resources.container, "-p", "127.0.0.1::22", resources.image], {
    cwd: repoRoot,
    timeout: 120_000,
  });

  const port = run("docker", ["port", resources.container, "22/tcp"], { cwd: repoRoot, timeout: 30_000 }).stdout
    .trim()
    .match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (!port) {
    throw new Error("Could not resolve mapped SSH port for Docker container.");
  }

  return Number(port);
}

function createSSHConfig(port) {
  const home = path.join(resources.root, "home");
  const sshDir = path.join(home, ".ssh");
  const binDir = path.join(resources.root, "bin");
  mkdirSync(sshDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const keyPath = path.join(resources.root, "id_ed25519");
  const configPath = path.join(sshDir, "config");
  chmodSync(keyPath, 0o600);
  writeFileSync(
    configPath,
    `Host ${hostAlias}
  HostName 127.0.0.1
  Port ${port}
  User repttyl
  IdentityFile ${keyPath}
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile ${path.join(resources.root, "known_hosts")}
  BatchMode yes
  LogLevel ERROR
`,
  );
  chmodSync(configPath, 0o600);

  const systemSSH = run("sh", ["-c", "command -v ssh"], { cwd: repoRoot, timeout: 30_000 }).stdout.trim();
  const wrapper = path.join(binDir, "ssh");
  writeFileSync(
    wrapper,
    `#!/bin/sh
exec ${shellQuote(systemSSH)} -F ${shellQuote(configPath)} "$@"
`,
  );
  chmodSync(wrapper, 0o755);

  return { home, binDir };
}

async function waitForSSH(home) {
  const deadline = Date.now() + 60_000;
  let lastError = "";

  while (Date.now() < deadline) {
    const result = spawnSync("ssh", ["-F", path.join(home, ".ssh", "config"), hostAlias, "true"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status === 0) {
      return;
    }
    lastError = result.stderr || result.stdout || result.error?.message || "";
    await delay(1_000);
  }

  throw new Error(`Timed out waiting for container SSH: ${lastError}`);
}

async function waitForDevToolsPage(port) {
  const deadline = Date.now() + 60_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (page) {
          return page;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for Electron DevTools page: ${lastError}`);
}

async function evaluateSmoke(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(JSON.stringify(message.error)));
    } else {
      request.resolve(message.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  try {
    const expression = `(${rendererSmoke.toString()})(${JSON.stringify(hostAlias)})`;
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Renderer smoke evaluation failed.");
    }

    return JSON.parse(result.result.value);
  } finally {
    ws.close();
  }

  function send(method, params) {
    const call = ++id;
    ws.send(JSON.stringify({ id: call, method, params }));
    return new Promise((resolve, reject) => pending.set(call, { resolve, reject }));
  }
}

async function rendererSmoke(alias) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() || "";
  for (let index = 0; index < 200 && !window.repttyl; index += 1) {
    await wait(100);
  }

  const hosts = await window.repttyl.listHosts();
  const hostFound = hosts.some((host) => host.alias === alias);
  let hostButton;
  for (let index = 0; index < 100; index += 1) {
    hostButton = [...document.querySelectorAll("#hosts .row-button")].find((button) => button.textContent?.includes(alias));
    if (hostButton) {
      break;
    }
    await wait(100);
  }

  if (!hostButton) {
    return JSON.stringify({
      hostFound,
      hostRendered: false,
      stateLabel: text("#stateLabel"),
      stateDetail: text("#stateDetail"),
      hostsText: text("#hosts"),
    });
  }

  hostButton.click();
  for (let index = 0; index < 1_200; index += 1) {
    if (text("#stateLabel") === "Connected") {
      break;
    }
    await wait(100);
  }

  const connection = await window.repttyl.getConnectionState();
  if (!connection.connected) {
    return JSON.stringify({
      hostFound,
      hostRendered: true,
      connected: false,
      connectionError: connection.error,
      stateLabel: text("#stateLabel"),
      stateDetail: text("#stateDetail"),
      terminalText: text(".xterm-screen"),
    });
  }

  const workspace = await window.repttyl.createWorkspace("Docker SSH Smoke");
  const sessions = await window.repttyl.listSessions(workspace.id);
  const attached = await window.repttyl.attachTerminal({
    workspaceID: workspace.id,
    session: "main",
    cols: 80,
    rows: 24,
  });

  const marker = `repttyl-smoke-${Date.now()}`;
  const output = await new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for terminal marker ${marker}. Output: ${buffer}`));
    }, 30_000);
    const unsubscribe = window.repttyl.onTerminalOutput((message) => {
      if (message.stream !== attached.stream) {
        return;
      }
      buffer += message.data;
      if (buffer.includes(marker)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(buffer);
      }
    });

    window.repttyl.sendTerminalInput(attached.stream, `printf '${marker}\\\\n'\\r`);
  });

  const result = {
    hostFound,
    hostRendered: true,
    connected: connection.connected,
    connectionError: connection.error,
    stateLabel: text("#stateLabel"),
    stateDetail: text("#stateDetail"),
    agentVersion: connection.agentVersion,
    protocolVersion: connection.protocolVersion,
    workspaceName: workspace.name,
    workspaceID: workspace.id,
    sessionCount: sessions.length,
    terminalEchoSeen: output.includes(marker),
  };

  await window.repttyl.disconnect();
  return JSON.stringify(result);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stderr || ""}${result.stdout || ""}${result.error?.message || ""}`,
    );
  }
  return result;
}

function cleanup() {
  if (cleaningUp) {
    return;
  }
  cleaningUp = true;

  if (resources.electron && !resources.electron.killed) {
    resources.electron.kill();
  }
  spawnSync("docker", ["rm", "-f", resources.container], { encoding: "utf8", timeout: 15_000 });
  spawnSync("docker", ["image", "rm", "-f", resources.image], { encoding: "utf8", timeout: 30_000 });
  rmSync(resources.root, { recursive: true, force: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
