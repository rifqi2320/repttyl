import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const agentRoot = path.join(repoRoot, "agent");
const agentBinary = path.join(agentRoot, "bin", "repttyl");
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "main.js");

before(() => {
  const result = spawnSync("go", ["build", "-o", agentBinary, "./cmd/repttyl"], {
    cwd: agentRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("local CLI transport creates, lists, reads sessions, and kills a tmux workspace", { timeout: 30_000 }, (t) => {
  if (skipWithoutTmux(t)) {
    return;
  }

  const env = isolatedEnv();
  t.after(() => cleanupEnv(env));

  const initialList = runClient(env, "--json", "--local", "--agent-binary", agentBinary, "workspace", "list");
  assert.deepEqual(JSON.parse(initialList.stdout), { workspaces: [] });

  const created = JSON.parse(
    runClient(env, "--json", "--local", "--agent-binary", agentBinary, "workspace", "create", "Local E2E").stdout,
  );
  assert.equal(created.workspace.name, "Local E2E");
  assert.equal(created.workspace.slug, "local-e2e");
  assert.match(created.workspace.id, /^ws_/);

  const listed = JSON.parse(runClient(env, "--json", "--local", "--agent-binary", agentBinary, "workspace", "list").stdout);
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.workspaces[0].id, created.workspace.id);
  assert.equal(listed.workspaces[0].status, "running");

  const sessions = JSON.parse(
    runClient(env, "--json", "--local", "--agent-binary", agentBinary, "session", "list", created.workspace.id).stdout,
  );
  assert.deepEqual(sessions.sessions, [{ name: "main", status: "running" }]);

  const killed = JSON.parse(
    runClient(env, "--json", "--local", "--agent-binary", agentBinary, "session", "kill", created.workspace.id).stdout,
  );
  assert.deepEqual(killed, { ok: true });

  const afterKill = JSON.parse(runClient(env, "--json", "--local", "--agent-binary", agentBinary, "workspace", "list").stdout);
  assert.equal(afterKill.workspaces[0].status, "stopped");
});

test("local CLI transport surfaces structured agent validation errors", { timeout: 30_000 }, (t) => {
  if (skipWithoutTmux(t)) {
    return;
  }

  const env = isolatedEnv();
  t.after(() => cleanupEnv(env));

  const result = runClientExpectError(env, "--json", "--local", "--agent-binary", agentBinary, "workspace", "create", "!!!");
  assert.match(result.stderr, /INVALID_WORKSPACE_NAME/);
});

test("docker CLI transport creates, lists, reads sessions, and kills a tmux workspace", { timeout: 420_000 }, (t) => {
  if (skipWithoutDocker(t)) {
    return;
  }

  const image = buildDockerImage(t);
  const container = `repttyl-cli-e2e-${process.pid}-${Date.now()}`;
  t.after(() => {
    spawnSync("docker", ["rm", "-f", container], { encoding: "utf8", timeout: 15_000 });
    spawnSync("docker", ["image", "rm", "-f", image], { encoding: "utf8", timeout: 15_000 });
  });

  runDocker("run", "-d", "--name", container, image);

  const initialList = runClient({}, "--json", "--docker", container, "workspace", "list");
  assert.deepEqual(JSON.parse(initialList.stdout), { workspaces: [] });

  const created = JSON.parse(runClient({}, "--json", "--docker", container, "workspace", "create", "Docker E2E").stdout);
  assert.equal(created.workspace.name, "Docker E2E");
  assert.equal(created.workspace.slug, "docker-e2e");
  assert.match(created.workspace.id, /^ws_/);

  const listed = JSON.parse(runClient({}, "--json", "--docker", container, "workspace", "list").stdout);
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.workspaces[0].id, created.workspace.id);
  assert.equal(listed.workspaces[0].status, "running");

  const sessions = JSON.parse(runClient({}, "--json", "--docker", container, "session", "list", created.workspace.id).stdout);
  assert.deepEqual(sessions.sessions, [{ name: "main", status: "running" }]);

  const killed = JSON.parse(runClient({}, "--json", "--docker", container, "session", "kill", created.workspace.id).stdout);
  assert.deepEqual(killed, { ok: true });

  const afterKill = JSON.parse(runClient({}, "--json", "--docker", container, "workspace", "list").stdout);
  assert.equal(afterKill.workspaces[0].status, "stopped");
});

function runClient(env, ...args) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runDocker(...args) {
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result;
}

function runClientExpectError(env, ...args) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, "command succeeded unexpectedly");
  return result;
}

function isolatedEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "repttyl-cli-e2e-"));
  return {
    REPTTYL_E2E_ROOT: root,
    REPTTYL_STATE_ROOT: path.join(root, "state"),
    REPTTYL_RUNTIME_ROOT: path.join(root, "run"),
    REPTTYL_WORKSPACE_ROOT: path.join(root, "workspaces"),
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
  };
}

function cleanupEnv(env) {
  const workspaceRuntimeRoot = path.join(env.REPTTYL_RUNTIME_ROOT, "workspaces");
  if (existsSync(workspaceRuntimeRoot)) {
    for (const workspaceID of readdirSync(workspaceRuntimeRoot)) {
      const socketPath = path.join(workspaceRuntimeRoot, workspaceID, "tmux.sock");
      spawnSync("tmux", ["-S", socketPath, "kill-server"], { encoding: "utf8" });
    }
  }
  rmSync(env.REPTTYL_E2E_ROOT, { recursive: true, force: true });
}

function buildDockerImage(t) {
  const context = mkdtempSync(path.join(tmpdir(), "repttyl-docker-e2e-"));
  const image = `repttyl-cli-e2e:${process.pid}-${Date.now()}`;
  t.after(() => rmSync(context, { recursive: true, force: true }));

  copyFileSync(agentBinary, path.join(context, "repttyl"));
  writeFileSync(
    path.join(context, "Dockerfile"),
    `FROM debian:bookworm-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates tmux \\
  && rm -rf /var/lib/apt/lists/*
COPY repttyl /usr/local/bin/repttyl
ENV SHELL=/bin/sh
ENV TERM=xterm-256color
CMD ["sleep", "infinity"]
`,
  );

  runDocker("build", "-t", image, context);
  return image;
}

function skipWithoutTmux(t) {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (result.status !== 0) {
    t.skip("tmux is not available on PATH");
    return true;
  }
  return false;
}

function skipWithoutDocker(t) {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0 || result.error) {
    t.skip(`docker is not available: ${result.stderr || result.error?.message || "unknown error"}`);
    return true;
  }
  return false;
}
