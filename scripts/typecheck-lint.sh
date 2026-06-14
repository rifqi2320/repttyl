#!/bin/sh
set -eu

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

echo "==> TypeScript typecheck"
pnpm --filter @repttyl/protocol-client typecheck
pnpm --filter @repttyl/client-node typecheck
pnpm --filter @repttyl/cli typecheck
pnpm --filter @repttyl/desktop typecheck

echo "==> Go format check"
unformatted=$(cd agent && gofmt -l ./cmd ./internal)
if [ -n "$unformatted" ]; then
  echo "Go files need gofmt:" >&2
  echo "$unformatted" >&2
  exit 1
fi

echo "==> Go tests"
(cd agent && go test -count=1 ./...)

