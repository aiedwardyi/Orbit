#!/usr/bin/env bash
# POSIX entry point; same arguments as deploy/cli.ts. Dry run unless --apply.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node 24 or later is required on PATH" >&2
  exit 1
fi
major="$(node -p "process.versions.node.split('.')[0]")"
if [ "$major" -lt 24 ]; then
  echo "Node 24 or later is required (found $major)" >&2
  exit 1
fi
exec node "$(dirname "$0")/cli.ts" "$@"
