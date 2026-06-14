# AGENTS.md

## Project Commands

- Run `pnpm typecheck` before handing off code changes.
- Run `pnpm test` when behavior, protocol, transport, terminal, or release paths change.
- Run `pnpm verify` before release-facing changes.
- For Go changes, keep `agent/cmd` and `agent/internal` formatted with `gofmt`.

## Git Hooks

This repo uses versioned hooks in `.githooks`.

DO NOT OVERRIDE the hooks verify.

The `pre-commit` and `pre-push` hooks both run `scripts/typecheck-lint.sh`. Do not replace, bypass, weaken, or delete these hooks unless the user explicitly asks for that specific change.

If hooks are not active in a fresh clone, run:

```bash
git config core.hooksPath .githooks
```

## Architecture Notes

- Client transports live in `packages/client-node`.
- The agent binary only speaks `repttyl agent --stdio` after a client transport starts it.
- The agent owns workspace metadata, tmux sessions, terminal attach streams, and daemon events.
- Do not make clients call tmux directly.

