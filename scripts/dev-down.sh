#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_ENV="$ROOT_DIR/.runtime/config/compose.env"

if [[ ! -f "$COMPOSE_ENV" ]]; then
  printf 'Family AI Gateway 尚未初始化，无需停止。\n'
  exit 0
fi

cd "$ROOT_DIR"
docker compose --env-file "$COMPOSE_ENV" down
printf 'Gateway 已停止；.runtime/data 中的会话和历史仍然保留。\n'
