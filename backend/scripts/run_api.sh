#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env file if present (variables already set in environment take precedence)
if [ -f "$ROOT_DIR/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    # Only export if not already set in environment
    key="${line%%=*}"
    if [ -z "${!key+x}" ]; then
      export "$line" 2>/dev/null || true
    fi
  done < "$ROOT_DIR/.env"
fi

DEFAULT_PYTHON="$ROOT_DIR/venv/bin/python"
if [ ! -x "$DEFAULT_PYTHON" ]; then
  DEFAULT_PYTHON="$(command -v python3 || command -v python)"
fi
PYTHON_BIN="${PYTHON_BIN:-$DEFAULT_PYTHON}"
HOST="${API_HOST:-127.0.0.1}"
PORT="${API_PORT:-8000}"
WORKERS="${API_WORKERS:-2}"
LOG_LEVEL="${LOG_LEVEL:-info}"
LOG_LEVEL="${LOG_LEVEL,,}"  # normalize to lowercase for uvicorn
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
