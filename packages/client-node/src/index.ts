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

export type SSHHost = {
  alias: string;
  hostName?: string;
  user?: string;
};

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

export function createAgentProcessConnection(agentBinary = resolveDefaultAgentBinary()): AgentProcessConnection {
  const child = spawn(agentBinary, ["agent", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  return new AgentProcessConnection(child);
}

export function createSSHAgentConnection(host: string, remoteCommand = "repttyl"): AgentProcessConnection {
  const child = spawn("ssh", ["-T", host, remoteCommand, "agent", "--stdio"], {
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
