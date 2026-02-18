#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/venv/bin/python}"
HOST="${API_HOST:-127.0.0.1}"
PORT="${API_PORT:-8000}"
WORKERS="${API_WORKERS:-2}"
LOG_LEVEL="${LOG_LEVEL:-info}"

if ! [[ "$WORKERS" =~ ^[0-9]+$ ]] || [ "$WORKERS" -lt 1 ]; then
  echo "Invalid API_WORKERS=$WORKERS, fallback to 2" >&2
  WORKERS=2
fi

cd "$ROOT_DIR"

exec "$PYTHON_BIN" -m uvicorn api.main:app \
  --host "$HOST" \
  --port "$PORT" \
  --workers "$WORKERS" \
  --log-level "$LOG_LEVEL"
