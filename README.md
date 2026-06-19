# Repttyl

Repttyl is a desktop-first shell workspace system built around a small agent, transport adapters, and persistent tmux-backed terminal sessions.

The current release ships the remote agent, CLI client, and Electron desktop app artifacts.

## What It Does

- Uses OpenSSH for remote hosts, Docker exec for containers, and a local subprocess transport for same-machine development.
- Runs `repttyl agent --stdio` either locally or under the remote SSH user, bootstrapping the agent from GitHub when needed.
- Keeps shell state alive through tmux after client disconnects.
- Stores named workspaces under the remote user's home directory.
- Provides a CLI client for listing, creating, attaching to, and killing workspace sessions.
- Emits daemon-backed workspace status events from tmux hooks without polling.

## Repository Layout

```text
agent/                     Go remote agent and repttyl CLI binary
apps/cli/                  Node CLI client
apps/desktop/              Electron desktop scaffold
packages/client-node/      Node transport adapters for local, SSH, and Docker agent connections
packages/protocol-client/  Shared TypeScript protocol client
packages/protocol-schema/  JSON schema and protocol notes
docs/release.md            Release process
```

## Install From Release

Download artifacts from:

```text
https://github.com/rifqi2320/repttyl/releases
```

Agent archives are named by platform:

```text
repttyl-v0.1.2-rc.8-linux-amd64.tar.gz
repttyl-v0.1.2-rc.8-linux-arm64.tar.gz
repttyl-v0.1.2-rc.8-darwin-amd64.tar.gz
repttyl-v0.1.2-rc.8-darwin-arm64.tar.gz
repttyl-v0.1.2-rc.8-windows-amd64.tar.gz
```

The CLI archive is platform-independent and requires Node.js:

```text
repttyl-client-v0.1.2-rc.8.tar.gz
```

## Build From Source

Requirements:

- Go 1.24+
- Node.js 24+
- pnpm 10+
- tmux on hosts that run the agent

Install dependencies:

```bash
pnpm install
```

Build and test the agent:

```bash
cd agent
go test ./...
go build -o bin/repttyl ./cmd/repttyl
```

Build the CLI:

```bash
pnpm --filter @repttyl/cli build
```

Run the full release preflight:

```bash
pnpm release:preflight
```

## Agent Commands

```bash
repttyl agent --stdio
repttyl version --json
repttyl doctor --json
repttyl probe --json
repttyl workspace list --json
repttyl daemon start
repttyl daemon stop
repttyl daemon status --json
```

The agent stores state under:

```text
~/.local/share/repttyl/state
~/.cache/repttyl/run
~/repttyl-workspaces
```

These can be overridden with:

```text
REPTTYL_STATE_ROOT
REPTTYL_RUNTIME_ROOT
REPTTYL_WORKSPACE_ROOT
```

## CLI Usage

After building `apps/cli`, run:

```bash
node apps/cli/dist/main.js --local --agent-binary ./agent/bin/repttyl hello
node apps/cli/dist/main.js --local --agent-binary ./agent/bin/repttyl workspace list
node apps/cli/dist/main.js --local --agent-binary ./agent/bin/repttyl workspace create default
node apps/cli/dist/main.js --local --agent-binary ./agent/bin/repttyl attach <workspace-id>
node apps/cli/dist/main.js --local --agent-binary ./agent/bin/repttyl kill <workspace-id>
```

When `--agent-binary` is omitted and `repttyl` is missing or does not match the client release, local mode downloads the matching agent into `~/.local/bin/repttyl` and runs it from there. The local machine needs `tmux` plus either `curl` or `wget`.

For a remote host with SSH access:

```bash
node apps/cli/dist/main.js --host my-ssh-host workspace list
node apps/cli/dist/main.js --host my-ssh-host attach <workspace-id>
```

If `repttyl` is not found on the remote host, the SSH transport downloads the matching release agent into `~/.local/bin/repttyl` and runs it from there. The remote host needs `tmux` plus either `curl` or `wget`.

## Opening Unsigned macOS DMGs

Development macOS DMGs are unsigned unless Apple signing secrets are configured in the release workflow. If macOS reports that `Repttyl` is damaged, drag `Repttyl.app` to `/Applications`, then run:

```bash
xattr -dr com.apple.quarantine /Applications/Repttyl.app
open /Applications/Repttyl.app
```

## Desktop Auto-Update

Packaged macOS and Windows builds use `electron-updater` with GitHub Releases. The release workflow uploads installer artifacts plus update metadata such as `latest.yml`, `latest-mac.yml`, or prerelease channel files like `rc.yml`; the app downloads supported updates automatically and prompts for restart after the update is ready. Linux desktop tarball builds do not use desktop auto-update; update those through the release artifacts or a package manager.

For a running Docker container with `repttyl` and `tmux` installed:

```bash
node apps/cli/dist/main.js --docker my-container workspace list
node apps/cli/dist/main.js --docker my-container workspace create default
node apps/cli/dist/main.js --docker my-container attach <workspace-id>
```

## Release

Releases are created by pushing a semantic version tag:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

See [docs/release.md](docs/release.md) for the full release flow.

## License

MIT. See [LICENSE](LICENSE).
