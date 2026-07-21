#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$ROOT_DIR/docs/acceptance/runtime/logs"

fail() {
  printf 'FOUNDATION VERIFICATION FAILED: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "未找到 Docker。"
docker compose version >/dev/null 2>&1 || fail "当前 Docker 不支持 'docker compose'。"
command -v curl >/dev/null 2>&1 || fail "未找到 curl。"

umask 077
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
cd "$ROOT_DIR"

printf '\n[1/6] Checking the committed dependency lock...\n'
[[ -f package-lock.json ]] || fail "仓库缺少已提交的 package-lock.json。请不要在验收时临时生成锁文件。"
printf 'Using the committed package-lock.json.\n'

printf '\n[2/6] Building and verifying the Docker image...\n'
printf 'The Docker build runs npm ci, all tests, static checks, type checking, and builds.\n'
docker compose build 2>&1 | tee "$LOG_DIR/docker-build.log"

printf '\n[3/6] Starting a clean automated-test Gateway...\n'
./scripts/dev-reset.sh --yes >/dev/null
./scripts/dev-up.sh 2>&1 | tee "$LOG_DIR/automated-dev-up.log"

printf '\n[4/6] Running the legacy message-kernel acceptance...\n'
./scripts/acceptance.sh 2>&1 | tee "$LOG_DIR/foundation-acceptance.log"

printf '\n[5/6] Running the Family onboarding and dual-entry acceptance...\n'
bash ./scripts/acceptance-onboarding.sh 2>&1 | tee "$LOG_DIR/onboarding-acceptance.log"

printf '\n[6/6] Preparing a clean Gateway for beginner browser acceptance...\n'
./scripts/dev-reset.sh --yes >/dev/null
./scripts/dev-up.sh 2>&1 | tee "$LOG_DIR/browser-dev-up.log"

TOKEN_FILE="$RUNTIME_DIR/config/device-token"
[[ -f "$TOKEN_FILE" ]] || fail "浏览器验收启动后未找到开发 Token 文件。"
DEVICE_TOKEN="$(cat "$TOKEN_FILE")"
ACCEPTANCE_URL="http://127.0.0.1:8790/#token=$DEVICE_TOKEN&device=device%3Atest"

cat <<EOF

============================================================
Family AI Foundation automated verification: PASS
============================================================

自动验收已经验证：
- 原有消息、幂等和重启恢复内核；
- 空 Family 领域；
- 一次性建家；
- 同一 Person / Device 上的两套独立入口 Session；
- 家庭管理 → 家庭管家；
- 个人空间 → 个人助理；
- 管理员新增成员；
- Personal 入口无法访问 Admin API；
- Gateway 重启后两套 Session 仍可使用。

Gateway 已再次清空并保持运行，供你亲手体验。

打开本机地址：
$ACCEPTANCE_URL

按页面依次完成：
1. 填写家庭名称、管理员姓名和当前设备名称。
2. 点击“创建家庭并进入门户”。
3. 进入“家庭管理”，确认默认 Agent 是“家庭管家”。
4. 新增一位家庭成员。
5. 返回双入口门户。
6. 进入“个人空间”，确认默认 Agent 是“个人助理”。
7. 对比两个入口：Person 和 Device 相同，Session Ref 与 Agent 不同。
8. 刷新页面，确认两套入口仍然可用。
9. 执行下面的重启命令，再刷新页面：
   docker compose --env-file .runtime/config/compose.env restart gateway
10. 确认家庭、成员和两个入口仍然存在。

自动验收日志：
$LOG_DIR

停止但保留当前体验数据：
./scripts/dev-down.sh

清空一次性开发数据并重新体验：
./scripts/dev-reset.sh
EOF
