#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_PYTHON="$ROOT_DIR/venv/bin/python"
if [ ! -x "$DEFAULT_PYTHON" ]; then
  DEFAULT_PYTHON="$(command -v python3 || command -v python)"
fi
PYTHON_BIN="${PYTHON_BIN:-$DEFAULT_PYTHON}"
HOST="${API_HOST:-127.0.0.1}"
PORT="${API_PORT:-8000}"
WORKERS="${API_WORKERS:-2}"
LOG_LEVEL="${LOG_LEVEL:-info}"
PROXY_HEADERS="${API_PROXY_HEADERS:-true}"
FORWARDED_ALLOW_IPS="${FORWARDED_ALLOW_IPS:-*}"

if ! [[ "$WORKERS" =~ ^[0-9]+$ ]] || [ "$WORKERS" -lt 1 ]; then
  echo "Invalid API_WORKERS=$WORKERS, fallback to 2" >&2
  WORKERS=2
fi

if [ -z "$PYTHON_BIN" ] || [ ! -x "$PYTHON_BIN" ]; then
  echo "Python binary not found. Set PYTHON_BIN manually." >&2
  exit 1
fi

cd "$ROOT_DIR"

ARGS=(
  -m uvicorn api.main:app
  --host "$HOST"
  --port "$PORT"
  --workers "$WORKERS"
  --log-level "$LOG_LEVEL"
)

if [ "$PROXY_HEADERS" = "true" ]; then
  ARGS+=(--proxy-headers --forwarded-allow-ips "$FORWARDED_ALLOW_IPS")
fi

exec "$PYTHON_BIN" "${ARGS[@]}"
