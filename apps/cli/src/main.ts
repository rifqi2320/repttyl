#!/usr/bin/env node

import { AgentClient, AgentProtocolError, type Session, type Workspace } from "@repttyl/protocol-client";
import {
  createAgentConnection,
  listSSHHosts,
  resolveDefaultAgentBinary,
  type AgentTransport,
  type SSHHost,
} from "@repttyl/client-node";
import { attachTerminalPresentation } from "./presentation/terminal.js";
import { renderSessions } from "./presentation/sessions.js";
import { promptText, selectOne } from "./presentation/select.js";
import { renderWorkspaces } from "./presentation/text.js";

const CLIENT_VERSION = "0.1.2-rc.5";

type ParsedArgs = {
  agentBinary: string;
  host?: string;
  dockerContainer?: string;
  local: boolean;
  json: boolean;
  command: string[];
};

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  validateTransportSelection(args);

  if (args.command[0] === "help" || args.command[0] === "--help") {
    printUsage();
    return;
  }

  if (args.command.length === 0 || args.command[0] === "tui") {
    await runInteractive(args);
    return;
  }

  const client = createClient(args);
  try {
    await runCommand(client, args);
  } finally {
    client.close();
  }
}

async function runInteractive(args: ParsedArgs): Promise<void> {
  const host = args.local || args.dockerContainer ? undefined : args.host ?? (await chooseHost());
  if (!args.local && !args.dockerContainer && !host) {
    process.stdout.write("No host selected.\n");
    return;
  }

  const client = createClient({ ...args, host });
  try {
    await client.hello(CLIENT_VERSION);

    const workspace = await chooseWorkspace(client);
    if (!workspace) {
      return;
    }

    const session = await chooseSession(client, workspace);
    if (!session) {
      return;
    }

    process.stdout.write(`\nConnecting to ${workspace.name}/${session.name}${transportSuffix({ ...args, host })}...\n`);
    await attachTerminalPresentation(client, workspace.id, session.name, {
      input: process.stdin,
      output: process.stdout,
      error: process.stderr,
    });
  } finally {
    client.close();
  }
}

async function runCommand(client: AgentClient, args: ParsedArgs): Promise<void> {
  const [resource, action, ...rest] = args.command;

  if (resource === "hello") {
    writeResult(await client.hello(CLIENT_VERSION), args.json);
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
    writeResult(await client.createWorkspace(name), args.json);
    return;
  }

  if ((resource === "session" && action === "list") || resource === "sessions") {
    const workspaceID = resource === "sessions" ? action : rest[0];
    if (!workspaceID) {
      throw new Error("session list requires a workspace id");
    }

    const result = await client.listSessions(workspaceID);
    if (args.json) {
      writeResult(result, true);
    } else {
      renderSessions(result.sessions, process.stdout);
    }
    return;
  }

  if ((resource === "terminal" && action === "attach") || resource === "attach") {
    const workspaceID = resource === "attach" ? action : rest[0];
    const session = resource === "attach" ? rest[0] : rest[1];
    if (!workspaceID) {
      throw new Error("terminal attach requires a workspace id");
    }

    await attachTerminalPresentation(client, workspaceID, session ?? "main", {
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

function createClient(args: ParsedArgs): AgentClient {
  return new AgentClient(createAgentConnection(resolveTransport(args)));
}

function resolveTransport(args: ParsedArgs): AgentTransport {
  if (args.local) {
    return { mode: "local", agentBinary: args.agentBinary };
  }

  if (args.dockerContainer) {
    return { mode: "docker", container: args.dockerContainer };
  }

  if (!args.host) {
    throw new Error("remote commands require --host or --docker, or use --local for a local agent");
  }

  return { mode: "ssh", host: args.host };
}

function validateTransportSelection(args: ParsedArgs): void {
  const selected = [args.local, Boolean(args.host), Boolean(args.dockerContainer)].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("choose only one transport: --local, --host, or --docker");
  }
}

function transportSuffix(args: ParsedArgs): string {
  if (args.local) {
    return " locally";
  }

  if (args.dockerContainer) {
    return ` in Docker container ${args.dockerContainer}`;
  }

  return args.host ? ` on ${args.host}` : "";
}

async function chooseHost(): Promise<string | undefined> {
  const hosts = listSSHHosts();
  if (hosts.length === 0) {
    const typed = await promptText({ input: process.stdin, output: process.stdout }, "SSH host: ");
    return typed || undefined;
  }

  const selected = await selectOne<SSHHost>(
    { input: process.stdin, output: process.stdout },
    "SSH hosts",
    hosts,
    (host) => `${host.alias}${host.user ? ` (${host.user})` : ""}${host.hostName ? ` -> ${host.hostName}` : ""}`,
  );
  return selected?.alias;
}

async function chooseWorkspace(client: AgentClient): Promise<Workspace | undefined> {
  let { workspaces } = await client.listWorkspaces();
  if (workspaces.length === 0) {
    const name = await promptText({ input: process.stdin, output: process.stdout }, "No workspaces. Create workspace name: ");
    if (!name) {
      return undefined;
    }
    const created = await client.createWorkspace(name);
    workspaces = [created.workspace];
  }

  return selectOne<Workspace>(
    { input: process.stdin, output: process.stdout },
    "Workspaces",
    workspaces,
    (workspace) => `${workspace.name}  ${workspace.status ?? "unknown"}  ${workspace.path}`,
  );
}

async function chooseSession(client: AgentClient, workspace: Workspace): Promise<Session | undefined> {
  const { sessions } = await client.listSessions(workspace.id);
  return selectOne<Session>(
    { input: process.stdin, output: process.stdout },
    "Sessions",
    sessions,
    (session) => `${session.name}  ${session.status}`,
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    agentBinary: resolveDefaultAgentBinary(),
    local: false,
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

    if (arg === "--host") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--host requires an SSH host");
      }
      parsed.host = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--host=")) {
      parsed.host = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--docker") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--docker requires a container name or id");
      }
      parsed.dockerContainer = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--docker=")) {
      parsed.dockerContainer = arg.slice("--docker=".length);
      continue;
    }

    if (arg === "--local") {
      parsed.local = true;
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

Default:
  repttyl-client
  repttyl-client tui

Remote SSH:
  repttyl-client --host <ssh-host> workspace list
  repttyl-client --host <ssh-host> sessions <workspace-id>
  repttyl-client --host <ssh-host> attach <workspace-id> [session]

Docker:
  repttyl-client --docker <container> workspace list
  repttyl-client --docker <container> sessions <workspace-id>
  repttyl-client --docker <container> attach <workspace-id> [session]

Local development:
  repttyl-client --local [--agent-binary PATH] workspace list
  repttyl-client --local [--agent-binary PATH] workspace create <name>
  repttyl-client --local [--agent-binary PATH] attach <workspace-id> [session]

Other:
  --json
  --local
  --host <ssh-host>
  --docker <container>
  --agent-binary <path>

The CLI never invokes tmux directly. It connects to the agent over local process, SSH, or Docker transport, and the agent owns tmux.
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
