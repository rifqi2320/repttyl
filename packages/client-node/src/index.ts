import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeMessage,
  JsonLineDecoder,
  type AgentConnection,
  type AgentMessage,
  type InboundAgentMessage,
} from "@repttyl/protocol-client";

type MessageListener = (message: InboundAgentMessage) => void;
type CloseListener = (error?: Error) => void;

const DEFAULT_AGENT_VERSION = "v0.1.2-rc.2";
const DEFAULT_RELEASE_REPOSITORY = "rifqi2320/repttyl";

export type SSHHost = {
  alias: string;
  hostName?: string;
  user?: string;
};

export type LocalAgentTransport = {
  mode: "local";
  agentBinary?: string;
};

export type SSHAgentTransport = {
  mode: "ssh";
  host: string;
  remoteCommand?: string;
  remoteInstall?: RemoteAgentInstallOptions | false;
};

export type RemoteAgentInstallOptions = {
  repository?: string;
  version?: string;
};

export type DockerAgentTransport = {
  mode: "docker";
  container: string;
  remoteCommand?: string;
};

export type AgentTransport = LocalAgentTransport | SSHAgentTransport | DockerAgentTransport;

export class AgentProcessConnection implements AgentConnection {
  private readonly decoder = new JsonLineDecoder();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private stderr = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const message of this.decoder.push(chunk)) {
        this.emitMessage(message);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    child.on("error", (error) => this.emitClose(error));
    child.on("close", (code, signal) => {
      if (code === 0 || code === null) {
        this.emitClose();
        return;
      }

      const suffix = this.stderr.trim().length > 0 ? `: ${this.stderr.trim()}` : "";
      this.emitClose(new Error(`agent process exited with code ${code}${signal ? ` signal ${signal}` : ""}${suffix}`));
    });
  }

  send(message: AgentMessage): void {
    this.child.stdin.write(encodeMessage(message));
  }

  close(): void {
    if (!this.child.killed) {
      this.child.stdin.end();
      this.child.kill();
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private emitMessage(message: InboundAgentMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  private emitClose(error?: Error): void {
    for (const listener of this.closeListeners) {
      listener(error);
    }
  }
}

export function createAgentConnection(transport: AgentTransport): AgentProcessConnection {
  if (transport.mode === "local") {
    return createLocalAgentConnection(transport.agentBinary);
  }

  if (transport.mode === "docker") {
    return createDockerAgentConnection(transport.container, transport.remoteCommand);
  }

  return createSSHAgentConnection(transport.host, transport.remoteCommand, transport.remoteInstall);
}

export function createLocalAgentConnection(agentBinary = resolveDefaultAgentBinary()): AgentProcessConnection {
  const child = spawn(agentBinary, ["agent", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  return new AgentProcessConnection(child);
}

export function createAgentProcessConnection(agentBinary = resolveDefaultAgentBinary()): AgentProcessConnection {
  return createLocalAgentConnection(agentBinary);
}

export function createSSHAgentConnection(
  host: string,
  remoteCommand?: string,
  remoteInstall?: RemoteAgentInstallOptions | false,
): AgentProcessConnection {
  const command = remoteCommand
    ? `${remoteCommand} agent --stdio`
    : remoteInstall === false
      ? "repttyl agent --stdio"
      : createRemoteBootstrapCommand(remoteInstall);
  const child = spawn("ssh", ["-T", host, command], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  return new AgentProcessConnection(child);
}

export function createDockerAgentConnection(container: string, remoteCommand = "repttyl"): AgentProcessConnection {
  const child = spawn("docker", ["exec", "-i", "-e", "TERM=xterm-256color", container, remoteCommand, "agent", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  return new AgentProcessConnection(child);
}

export function listSSHHosts(configPath = path.join(os.homedir(), ".ssh", "config")): SSHHost[] {
  if (!existsSync(configPath)) {
    return [];
  }

  const hosts: SSHHost[] = [];
  let current: SSHHost | undefined;

  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const [keywordRaw, ...rest] = line.split(/\s+/);
    const keyword = keywordRaw.toLowerCase();
    const value = rest.join(" ");

    if (keyword === "host") {
      if (current) {
        hosts.push(current);
      }
      const alias = value.split(/\s+/).find((candidate) => !candidate.includes("*") && !candidate.includes("?"));
      current = alias ? { alias } : undefined;
      continue;
    }

    if (!current) {
      continue;
    }

    if (keyword === "hostname") {
      current.hostName = value;
    } else if (keyword === "user") {
      current.user = value;
    }
  }

  if (current) {
    hosts.push(current);
  }

  return dedupeHosts(hosts);
}

export function resolveDefaultAgentBinary(): string {
  if (process.env["REPTTYL_AGENT_BINARY"]) {
    return process.env["REPTTYL_AGENT_BINARY"];
  }

  const repoBinary = path.resolve(projectRoot(), "agent", "bin", "repttyl");
  if (existsSync(repoBinary)) {
    return repoBinary;
  }

  return "repttyl";
}

function stripComment(line: string): string {
  const index = line.indexOf("#");
  return index >= 0 ? line.slice(0, index) : line;
}

function dedupeHosts(hosts: SSHHost[]): SSHHost[] {
  const seen = new Set<string>();
  return hosts.filter((host) => {
    if (seen.has(host.alias)) {
      return false;
    }
    seen.add(host.alias);
    return true;
  });
}

function projectRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "..", "..");
}

function createRemoteBootstrapCommand(options: RemoteAgentInstallOptions = {}): string {
  const version = shellSingleQuote(options.version || process.env["REPTTYL_AGENT_VERSION"] || DEFAULT_AGENT_VERSION);
  const repository = shellSingleQuote(
    options.repository || process.env["REPTTYL_RELEASE_REPOSITORY"] || DEFAULT_RELEASE_REPOSITORY,
  );
  const script = `
set -eu

if command -v repttyl >/dev/null 2>&1; then
  exec repttyl agent --stdio
fi

install_dir="\${REPTTYL_AGENT_INSTALL_DIR:-$HOME/.local/bin}"
agent="$install_dir/repttyl"
if [ -x "$agent" ]; then
  exec "$agent" agent --stdio
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$os" in
  linux|darwin) ;;
  *)
    echo "repttyl: unsupported remote operating system: $os" >&2
    exit 127
    ;;
esac

case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "repttyl: unsupported remote architecture: $arch" >&2
    exit 127
    ;;
esac

tag=${version}
repository=${repository}
url="https://github.com/$repository/releases/download/$tag/repttyl-$tag-$os-$arch.tar.gz"
tmp_dir="\${TMPDIR:-/tmp}/repttyl-install-$$"
archive="$tmp_dir/repttyl.tar.gz"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$install_dir" "$tmp_dir"
echo "repttyl: installing remote agent from $url" >&2

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$archive"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$archive"
else
  echo "repttyl: remote install requires curl or wget" >&2
  exit 127
fi

tar -xzf "$archive" -C "$tmp_dir"
chmod +x "$tmp_dir/repttyl"
mv "$tmp_dir/repttyl" "$agent"
exec "$agent" agent --stdio
`.trim();

  return `sh -lc ${shellSingleQuote(script)}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
