#!/usr/bin/env node

import { AgentClient, AgentProtocolError } from "@repttyl/protocol-client";
import { attachTerminalPresentation } from "./presentation/terminal.js";
import { renderWorkspaces } from "./presentation/text.js";
import { createAgentProcessConnection, resolveDefaultAgentBinary } from "./transport/agent-process.js";

const CLIENT_VERSION = "0.1.0";

type ParsedArgs = {
  agentBinary: string;
  json: boolean;
  command: string[];
};

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.command.length === 0 || args.command[0] === "help" || args.command[0] === "--help") {
    printUsage();
    return;
  }

  const connection = createAgentProcessConnection(args.agentBinary);
  const client = new AgentClient(connection);

  try {
    await runCommand(client, args);
  } finally {
    client.close();
  }
}

async function runCommand(client: AgentClient, args: ParsedArgs): Promise<void> {
  const [resource, action, ...rest] = args.command;

  if (resource === "hello") {
    const hello = await client.hello(CLIENT_VERSION);
    writeResult(hello, args.json);
    return;
  }

  if ((resource === "workspace" && action === "list") || resource === "list" || resource === "workspaces") {
    const result = await client.listWorkspaces();
    if (args.json) {
      writeResult(result, true);
    } else {
      renderWorkspaces(result.workspaces, process.stdout);
    }
    return;
  }

  if ((resource === "workspace" && action === "create") || resource === "create") {
    const name = resource === "create" ? [action, ...rest].filter(Boolean).join(" ") : rest.join(" ");
    if (!name) {
      throw new Error("workspace create requires a name");
    }

    const result = await client.createWorkspace(name);
    writeResult(result, args.json);
    return;
  }

  if ((resource === "terminal" && action === "attach") || resource === "attach") {
    const workspaceID = resource === "attach" ? action : rest[0];
    if (!workspaceID) {
      throw new Error("terminal attach requires a workspace id");
    }

    await attachTerminalPresentation(client, workspaceID, {
      input: process.stdin,
      output: process.stdout,
      error: process.stderr,
    });
    return;
  }

  if ((resource === "session" && action === "kill") || resource === "kill") {
    const workspaceID = resource === "kill" ? action : rest[0];
    const session = resource === "kill" ? rest[0] : rest[1];
    if (!workspaceID) {
      throw new Error("session kill requires a workspace id");
    }

    await client.killSession(workspaceID, session ?? "main");
    writeResult({ ok: true }, args.json);
    return;
  }

  throw new Error(`unknown command: ${args.command.join(" ")}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    agentBinary: resolveDefaultAgentBinary(),
    json: false,
    command: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--agent-binary") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--agent-binary requires a path");
      }
      parsed.agentBinary = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--agent-binary=")) {
      parsed.agentBinary = arg.slice("--agent-binary=".length);
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    parsed.command.push(arg);
  }

  return parsed;
}

function writeResult(value: unknown, json: boolean): void {
  if (json || typeof value !== "object") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage(): void {
  process.stdout.write(`repttyl-client

Usage:
  repttyl-client [--agent-binary PATH] [--json] hello
  repttyl-client [--agent-binary PATH] [--json] workspace list
  repttyl-client [--agent-binary PATH] [--json] workspace create <name>
  repttyl-client [--agent-binary PATH] terminal attach <workspace-id>
  repttyl-client [--agent-binary PATH] [--json] session kill <workspace-id> [session]

Aliases:
  list
  workspaces
  create <name>
  attach <workspace-id>
  kill <workspace-id> [session]

Layering:
  Shared protocol/client internals live in @repttyl/protocol-client.
  This CLI owns Node subprocess transport and terminal/TUI presentation.
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof AgentProtocolError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }

  process.exitCode = 1;
});
