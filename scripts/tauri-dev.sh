#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT/scripts/tauri-bun-server.sh" &
BACKEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:9888" >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Bun backend exited before becoming ready"
    exit 1
  fi

  sleep 0.1
done

cd "$ROOT/src-tauri"
cargo tauri dev
