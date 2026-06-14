# Repttyl Architecture Diagrams

This document separates transport ownership from agent ownership.

The client owns transport. The agent only speaks the Repttyl JSON-lines protocol over stdin/stdout after it has been started.

## Responsibility Boundary

```mermaid
flowchart LR
  subgraph ClientSide["Client side"]
    Desktop["apps/desktop\nElectron UI"]
    CLI["apps/cli\nNode CLI"]
    ProtocolClient["packages/protocol-client\nAgentClient + JSONL protocol"]
    ClientNode["packages/client-node\ntransport adapters"]
    LocalTransport["Local transport\nspawn(agentBinary, ['agent', '--stdio'])"]
    SSHTransport["SSH transport\nspawn('ssh', ['-T', host, bootstrap command])"]
    DockerTransport["Docker transport\nspawn('docker', ['exec', '-i', container, 'repttyl', 'agent', '--stdio'])"]
  end

  subgraph AgentSide["Agent host side"]
    AgentProcess["agent/cmd/repttyl\nrepttyl agent --stdio"]
    AgentServer["internal/agent\nprotocol server"]
    Metadata["internal/metadata\nworkspace state"]
    Tmux["internal/tmux\ntmux session manager"]
    Terminal["internal/terminal\ntmux attach bridge"]
    Daemon["internal/daemon\nevent broker"]
  end

  Desktop --> ProtocolClient
  CLI --> ProtocolClient
  ProtocolClient --> ClientNode
  ClientNode --> LocalTransport
  ClientNode --> SSHTransport
  ClientNode --> DockerTransport

  LocalTransport -- "stdio JSONL" --> AgentProcess
  SSHTransport -- "SSH pipe carrying stdio JSONL" --> AgentProcess
  DockerTransport -- "docker exec pipe carrying stdio JSONL" --> AgentProcess

  AgentProcess --> AgentServer
  AgentServer --> Metadata
  AgentServer --> Tmux
  AgentServer --> Terminal
  AgentServer --> Daemon
```

## Local Transport

Local mode is a client-side adapter. It starts the agent as a child process on the same machine and then uses that child process stdin/stdout as the protocol pipe.

```mermaid
sequenceDiagram
  participant User
  participant CLI as apps/cli
  participant Client as AgentClient
  participant Local as client-node local transport
  participant Agent as repttyl agent --stdio
  participant Server as Agent protocol server
  participant Tmux as tmux

  User->>CLI: repttyl-client --local workspace create api
  CLI->>Client: createWorkspace("api")
  Client->>Local: send JSONL request
  Local->>Agent: spawn local agent binary
  Local->>Agent: write request to stdin
  Agent->>Server: decode request
  Server->>Tmux: ensure workspace session
  Server-->>Agent: JSONL response
  Agent-->>Local: stdout
  Local-->>Client: decoded response
  Client-->>CLI: workspace result
```

## SSH Transport

SSH mode is also a client-side adapter. The client starts `ssh`; SSH runs a remote bootstrap command that uses `repttyl` when available or installs it from the GitHub release into `~/.local/bin/repttyl`. The Repttyl protocol is still the same stdin/stdout JSON-lines stream after the agent starts.

```mermaid
sequenceDiagram
  participant User
  participant CLI as apps/cli
  participant Client as AgentClient
  participant SSH as client-node SSH transport
  participant OpenSSH as ssh process
  participant RemoteAgent as remote repttyl agent --stdio
  participant Tmux as remote tmux

  User->>CLI: repttyl-client --host devbox workspace list
  CLI->>Client: listWorkspaces()
  Client->>SSH: send JSONL request
  SSH->>OpenSSH: spawn ssh -T devbox bootstrap
  OpenSSH->>RemoteAgent: install if missing, then exec agent stdio
  RemoteAgent->>Tmux: read session status
  RemoteAgent-->>OpenSSH: JSONL response on stdout
  OpenSSH-->>SSH: encrypted transport output
  SSH-->>Client: decoded response
  Client-->>CLI: workspaces
```

## Docker Transport

Docker mode is a client-side adapter. The client starts `docker exec -i`; Docker runs `repttyl agent --stdio` inside an already-running container. The agent still owns tmux inside that container.

```mermaid
sequenceDiagram
  participant User
  participant CLI as apps/cli
  participant Client as AgentClient
  participant Docker as client-node Docker transport
  participant DockerExec as docker exec -i
  participant ContainerAgent as container repttyl agent --stdio
  participant Tmux as container tmux

  User->>CLI: repttyl-client --docker app-dev workspace list
  CLI->>Client: listWorkspaces()
  Client->>Docker: send JSONL request
  Docker->>DockerExec: spawn docker exec -i app-dev repttyl agent --stdio
  DockerExec->>ContainerAgent: container command stdio
  ContainerAgent->>Tmux: read session status
  ContainerAgent-->>DockerExec: JSONL response on stdout
  DockerExec-->>Docker: exec output
  Docker-->>Client: decoded response
  Client-->>CLI: workspaces
```

## Terminal Attach Data Path

The client never controls tmux directly. It asks the agent to attach a terminal stream. The agent owns tmux socket paths, session names, resizing, input forwarding, and output forwarding.

```mermaid
flowchart LR
  UserInput["User keystrokes"]
  ClientUI["CLI or desktop terminal view"]
  Protocol["AgentClient\nstream input/resize messages"]
  Transport["client-node transport\nlocal, SSH, or Docker"]
  Agent["repttyl agent --stdio"]
  Attach["internal/terminal.Attachment"]
  TmuxSocket["workspace tmux socket"]
  Shell["workspace shell"]

  UserInput --> ClientUI
  ClientUI --> Protocol
  Protocol --> Transport
  Transport -- "JSONL stream messages" --> Agent
  Agent --> Attach
  Attach --> TmuxSocket
  TmuxSocket --> Shell
  Shell --> TmuxSocket
  TmuxSocket --> Attach
  Attach --> Agent
  Agent -- "JSONL output messages" --> Transport
  Transport --> Protocol
  Protocol --> ClientUI
```

## Daemon Event Path

The daemon is not a transport layer. It is an agent-host event broker used for status notifications from tmux hooks. Reconnect/refresh still uses `workspace.list` as the authoritative on-demand state check.

```mermaid
flowchart LR
  TmuxHook["tmux hook\nsession closed"]
  Notify["repttyl daemon notify"]
  Daemon["repttyl daemon run\nUnix socket broker"]
  AgentSub["agent events.subscribe"]
  Client["client event handler"]
  Refresh["workspace.list\non reconnect/refresh"]

  TmuxHook --> Notify
  Notify --> Daemon
  Daemon --> AgentSub
  AgentSub --> Client
  Client --> Refresh
```

## Current Ownership Summary

| Concern | Owner |
| --- | --- |
| Choose local vs SSH vs Docker transport | Client (`apps/cli`, later `apps/desktop`) |
| Spawn local agent process | `packages/client-node` local transport |
| Spawn SSH process | `packages/client-node` SSH transport |
| Spawn Docker exec process | `packages/client-node` Docker transport |
| Run `repttyl agent --stdio` | Agent binary, after the client starts it |
| Encode/decode JSON-lines protocol | `packages/protocol-client` and Go agent server |
| Workspace metadata | Agent |
| tmux sessions and sockets | Agent |
| Terminal stream input/output bridge | Agent |
| tmux hook notifications | Agent-side daemon |
