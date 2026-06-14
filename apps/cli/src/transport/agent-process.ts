import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
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

export function createAgentProcessConnection(agentBinary: string): AgentProcessConnection {
  const child = spawn(agentBinary, ["agent", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  return new AgentProcessConnection(child);
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

function projectRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "..", "..", "..");
}
