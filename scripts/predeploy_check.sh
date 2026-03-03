#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail=0
warn() { echo "[WARN] $*"; }
err() { echo "[ERROR] $*"; fail=1; }
ok() { echo "[OK] $*"; }

if ! command -v docker >/dev/null 2>&1; then
  err "docker 未安装"
else
  ok "docker 已安装"
fi

if ! docker compose version >/dev/null 2>&1; then
  err "docker compose 不可用"
else
  ok "docker compose 可用"
fi

if [ ! -f "backend/.env" ]; then
  err "缺少 backend/.env，请先从 backend/.env.example 复制并填写"
else
  ok "backend/.env 存在"
fi

if [ ! -f "docker-compose.prod.yml" ]; then
  err "缺少 docker-compose.prod.yml"
fi

if [ -f "backend/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source backend/.env
  set +a

  provider="${LLM_PROVIDER:-}"
  case "$provider" in
    minimax)
      [ -n "${MINIMAX_API_KEY:-}" ] || err "LLM_PROVIDER=minimax 但 MINIMAX_API_KEY 为空"
      ;;
    openai)
      [ -n "${OPENAI_API_KEY:-}" ] || err "LLM_PROVIDER=openai 但 OPENAI_API_KEY 为空"
      ;;
    deepseek)
      [ -n "${DEEPSEEK_API_KEY:-}" ] || err "LLM_PROVIDER=deepseek 但 DEEPSEEK_API_KEY 为空"
      ;;
    *)
      err "LLM_PROVIDER 未设置为 minimax/openai/deepseek"
      ;;
  esac

  cors="${CORS_ALLOW_ORIGINS:-*}"
  hosts="${TRUSTED_HOSTS:-*}"

  if [ "$cors" = "*" ]; then
    warn "CORS_ALLOW_ORIGINS=*，公网部署建议改成你的域名"
  else
    ok "CORS_ALLOW_ORIGINS 已配置"
  fi

  if [ "$hosts" = "*" ]; then
    warn "TRUSTED_HOSTS=*，公网部署建议改成你的域名"
  else
    ok "TRUSTED_HOSTS 已配置"
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf "\n预部署检查失败，请先修复上述错误。\n"
  exit 1
fi

printf "\n预部署检查通过。\n"
