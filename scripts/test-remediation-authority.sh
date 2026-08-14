#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_FILE="${REMEDIATION_AUTHORITY_FILE:-AGENTS.md}"

node --input-type=module - "$TARGET_FILE" <<'NODE'
import { readFileSync } from "node:fs";

const targetFile = process.argv[2];
const source = readFileSync(targetFile, "utf8").replace(/\r\n/g, "\n");

const requiredFragments = [
  "docs/superpowers/plans/2026-08-13-deep-review-remediation-program.md",
  "只允许加固仓库已经存在的 Session、设备配对、附件、Provider Adapter、浏览器客户端和发布工具",
  "不得借整改任务新增产品能力",
  "第二套业务后端或数据权威",
  "正式 Member/Admin Web",
  "公共语音终端",
  "多 Agent 语义编排",
  "R1（短停、备份与副本演练）",
  "R2（maintenance 与 worker-disabled 可逆切换）",
  "R3（限定 subject/budget 的真实 Provider 验收与开放写入）",
  "127.0.0.1:8790",
  "B4 固定为 disabled-verified",
  "FAMILY_AI_RUNTIME_ROOT=<absolute-dir>",
  "COMPOSE_PROJECT_NAME=<safe-unique>",
  "FAMILY_AI_HOST_PORT=0",
  "FAMILY_AI_IMAGE_REF=<immutable-id>",
  "A4 合入前",
  "A4 合入后"
];

const forbiddenLegacyLines = [
  "- 正式浏览器 Session；",
  "- 设备配对和附件；",
  "- 真实 Hermes/Codex Provider；"
];

const invariantFragments = [
  "conversation 必须同时绑定 member 和 agent",
  "任何会话读取、消息发送、历史读取和幂等重放都必须校验当前 member 与 agent",
  "Provider external session 不得跨 Agent/Profile 复用",
  "幂等授权先于缓存命中",
  "pairing claim token 只能完成一次",
  "服务启动和 bootstrap 不得恢复已撤销设备",
  "Provider 子进程只能获得显式 allowlist 环境变量",
  "普通成员无法调用 `/api/admin/*`",
  "管理员身份不自动获得其他成员私人消息正文读取权",
  "数据库 Schema 变化必须版本化、可验证、可回滚",
  "附件文件与数据库状态必须具有补偿或可恢复机制",
  "密钥、Token、Cookie、Provider stderr 和本机私有路径不得进入公共 API、审计或 Git",
  "第一阶段端口只能发布到 `127.0.0.1`",
  "开发验收台不得包含正式管理员能力"
];

function validate(content) {
  const errors = [];
  const authoritySection = content.match(/## 当前整改阶段授权[\s\S]*$/);
  if (!authoritySection) {
    errors.push("无法定位当前整改阶段授权章节");
  } else {
    for (const fragment of requiredFragments) {
      if (!authoritySection[0].includes(fragment)) {
        errors.push(`缺少整改授权边界：${fragment}`);
      }
    }
  }
  for (const line of forbiddenLegacyLines) {
    if (content.split("\n").includes(line)) {
      errors.push(`仍存在与现状冲突的整类禁令：${line}`);
    }
  }

  const invariantSection = content.match(/## 安全不变量\n([\s\S]*?)\n## 工程边界/);
  if (!invariantSection) {
    errors.push("无法定位完整的安全不变量章节");
  } else {
    const numberedRules = invariantSection[1].match(/^\d+\.[ \t]+.+$/gm) ?? [];
    if (numberedRules.length !== 14) {
      errors.push(`安全不变量必须保持 14 条，当前为 ${numberedRules.length} 条`);
    }
    for (const fragment of invariantFragments) {
      if (!invariantSection[1].includes(fragment)) {
        errors.push(`安全不变量被删除或改写：${fragment}`);
      }
    }
  }

  for (const fragment of [
    "`main` 是唯一权威开发基线",
    "一个任务对应一个独立分支和一个直接指向 `main` 的 PR",
    "失败测试 → 最小实现 → 测试通过 → 重构 → 完整验证 → 提交",
    "npm ci",
    "npm run check"
  ]) {
    if (!content.includes(fragment)) {
      errors.push(`既有 Git/TDD 门禁不得删除：${fragment}`);
    }
  }
  return errors;
}

const errors = validate(source);
if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}

const currentScope = source.match(/## 当前整改阶段授权[\s\S]*$/);
if (!currentScope) {
  process.stderr.write("无法构造旧阶段规则回归样本。\n");
  process.exit(1);
}
const legacyVariant = source.replace(
  currentScope[0],
  `## 当前阶段限制\n\n暂不开发：\n\n${forbiddenLegacyLines.join("\n")}\n`
);
const legacyErrors = validate(legacyVariant);
if (!legacyErrors.some(error => error.includes("仍存在与现状冲突的整类禁令"))) {
  process.stderr.write("静态门禁未能拒绝旧阶段的整类禁令回归。\n");
  process.exit(1);
}

process.stdout.write("Remediation authority alignment checks passed.\n");
NODE
