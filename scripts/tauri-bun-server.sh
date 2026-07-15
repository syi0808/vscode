#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export NODE_ENV=development
export VSCODE_DEV=1

exec bun out/server-main.js \
  --host 127.0.0.1 \
  --port 9888 \
  --without-connection-token \
  --accept-server-license-terms \
  --default-folder "${CODE_TAURI_WORKSPACE:-$ROOT}"
