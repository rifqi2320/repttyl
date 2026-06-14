# Repttyl Protocol

The MVP protocol is newline-delimited JSON over the stdio stream created by:

```bash
ssh -T host 'repttyl agent --stdio'
```

Every request has an `op`. RPC-style requests include `id` and receive an `ok` response with the same `id`. Terminal stream requests use `stream`.

## Events

Clients can subscribe to daemon-delivered events over the same stdio stream:

```json
{"id":1,"op":"events.subscribe"}
```

The agent starts/connects to the user-level daemon and acknowledges:

```json
{"id":1,"ok":true}
```

When tmux hooks notify the daemon, subscribed clients receive async events:

```json
{"op":"workspace.status","workspace_id":"ws_01HX","status":"stopped","reason":"session-closed"}
```

`workspace.list` remains the authoritative on-demand refresh path for reconnects and missed events.

## Daemon

The daemon is a user-level Unix socket event broker. It does not poll tmux.

```bash
repttyl daemon start
repttyl daemon stop
repttyl daemon status --json
repttyl daemon notify --workspace-id ws_01HX --event session-closed
```
