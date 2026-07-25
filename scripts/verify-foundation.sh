#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$ROOT_DIR/docs/acceptance/runtime/logs"
MEMBER_WEB_URL_FILE="$RUNTIME_DIR/config/member-web-url"

fail() {
  printf 'FOUNDATION VERIFICATION FAILED: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "未找到 Docker。"
docker compose version >/dev/null 2>&1 || fail "当前 Docker 不支持 'docker compose'。"
command -v curl >/dev/null 2>&1 || fail "未找到 curl。"
command -v git >/dev/null 2>&1 || fail "未找到 Git，无法确认依赖锁已受版本控制。"

umask 077
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
cd "$ROOT_DIR"

printf '\n[1/6] Checking the committed dependency lock...\n'
[[ -f package-lock.json ]] || fail "仓库缺少已提交的 package-lock.json。请不要在验证时临时生成锁文件。"
git ls-files --error-unmatch -- package-lock.json >/dev/null 2>&1 \
  || fail "package-lock.json 未受 Git 跟踪。请先将正确的依赖锁加入当前任务分支。"
printf 'Using the committed package-lock.json.\n'

printf '\n[2/6] Building and verifying the Docker image...\n'
printf 'The Docker build runs npm ci, all tests, static checks, type checking, and builds.\n'
docker compose build 2>&1 | tee "$LOG_DIR/docker-build.log"

printf '\n[3/6] Starting a clean Gateway...\n'
./scripts/dev-reset.sh --yes >/dev/null
./scripts/dev-up.sh 2>&1 | tee "$LOG_DIR/automated-dev-up.log"

printf '\n[4/6] Verifying the message kernel...\n'
./scripts/acceptance.sh 2>&1 | tee "$LOG_DIR/foundation-verification.log"

printf '\n[5/6] Verifying Family identity, permissions, restart recovery, and product handoff...\n'
bash ./scripts/acceptance-onboarding.sh 2>&1 | tee "$LOG_DIR/onboarding-verification.log"

printf '\n[6/6] Keeping the verified Family state running for the real product workbench...\n'
[[ -f "$MEMBER_WEB_URL_FILE" ]] || fail "未生成真实个人工作台的配对链接。"
MEMBER_WEB_URL="$(cat "$MEMBER_WEB_URL_FILE")"
[[ "$MEMBER_WEB_URL" == http://127.0.0.1:8790/member/\?pairingRef=* ]] \
  || fail "真实个人工作台链接格式不正确。"

cat <<EOF

============================================================
Family AI automated verification: PASS
============================================================

自动验证已经覆盖：
- 消息、幂等、权限和重启恢复内核；
- 空 Family 领域与一次性建家；
- 同一 Person / Device 的独立 Admin 与 Personal Session；
- 家庭管理 → 家庭管家；
- 个人空间 → 个人助理；
- 管理员新增成员；
- Personal 入口无法访问 Admin API；
- Gateway 重启后入口状态继续有效；
- 真实浏览器 Device / EntryBinding / EntrySession 的产品配对路径；
- Chat、Work、显式补拉、累计 ACK 与 SSE 所使用的正式产品接口。

Gateway 保留刚刚通过验证的真实 Family 状态并继续运行。
打开下面的地址，直接进入真实个人工作台：

$MEMBER_WEB_URL

浏览器会通过正式配对建立个人设备，随后进入普通用户日常使用的 Chat / Work 工作台。
请直接通过正常产品行为完成体验：
1. 发送一条 Chat 消息，并看到个人助理回复。
2. 创建一个 Work，在 Work 中继续对话。
3. 刷新页面，确认 Chat、Work、草稿和消息仍然恢复。
4. 在仓库目录执行：
   docker compose --env-file .runtime/config/compose.env restart gateway
5. Gateway 恢复后刷新页面，确认工作台通过补拉和实时同步恢复到相同状态。

运行日志（仅保存在 Git 忽略的本机目录）：
$LOG_DIR

停止但保留当前体验数据：
./scripts/dev-down.sh

清空一次性开发数据并重新体验：
./scripts/dev-reset.sh
EOF
