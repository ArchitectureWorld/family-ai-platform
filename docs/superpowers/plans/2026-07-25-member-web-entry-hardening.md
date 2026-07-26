# Member Web 身份与入口生命周期加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个用户可从 Mac 直接打开体验的 Member Web：身份缓存严格隔离，Logout/Resume/Revoke 与多标签页行为确定，Renderer 不累积写监听器，Web Pairing v2 可在首次响应丢失后安全重放。

**Architecture:** Gateway 将 Web Entry 顶层协议升级到 v2，以浏览器预生成的 32 字节 Device Credential 建立 Device，并通过 HKDF 派生首次 Claim Session，使完全相同的 Claim 重放返回同一 Session。浏览器端把 Pairing、持久 Entry 状态、生命周期协调和产品工作台拆成聚焦 ES modules；所有跨标签状态变化由 Web Locks 串行、LocalStorage revision 定序、BroadcastChannel 唤醒。Preview 使用 Linux 上独立的 `8791` Node Gateway 和 `8792` 整站故障代理，通过 `ssh admin-yr` Tunnel 给 Mac 直接体验。

**Tech Stack:** Node.js 22、TypeScript 6、Zod 4、Fastify 5、SQLite/better-sqlite3、Vitest 4、原生浏览器 ES modules、IndexedDB、Web Locks、BroadcastChannel、Web Crypto、Bash。

## Global Constraints

- 所有 Linux 开发、测试、启动和验证必须通过 `ssh admin-yr` 在 `Admin-YR` 执行；Mac 只负责 SSH、Tunnel 和浏览器访问。
- 唯一工作目录是 `/home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening`，分支是 `fix/member-web-entry-hardening`，计划起点是 `7e123732bd5e2e5d5e1a7a97fb31b202097eb4fe`。
- 每个生产改动严格执行 RED（新增行为测试并观察预期失败）→ GREEN（最小实现）→ 定向回归 → commit。
- 不增加 React、Vite、前端框架、新第三方依赖或本地数据加密。
- 身份数据库键精确使用 `{familyRef, personRef, deviceRef}`；普通 Logout 保留数据库，Device Revoke 删除当前身份数据库。
- 旧全局数据库 `family-ai-member-web` 不迁移；成功前每次启动重试删除，`blocked` 时 fail closed。
- Web Entry 顶层协议版本固定为 `2`；嵌套 Public Context 的既有协议版本保持 `1`。
- Device Credential 是精确 32 字节的 canonical unpadded Base64URL；JSON 响应不得返回 Credential 或 Entry Token。
- Claim replay 只允许 `consumedAt + 2 minutes` 内成功三次；每次复用首次 Claim 的同一 Entry Session。
- 所有 Entry lifecycle HTTP 请求先使用 origin-global
  `family-ai-member-cookie-mutation` Web Lock，再使用
  `family-ai-member-entry-mutation:${installationId}`。安装/续期 Session、
  显式清除 Cookies、Logout、Device DELETE、Revoke/rotation 的路径还必须
  取得 exclusive Product-flight；只读 Context 验证可只持 Cookie→Entry，
  但不得在该路径直接 renew/activate，失效后必须先写 marker、停掉 Product
  并进入 exclusive drain recovery。不使用 LocalStorage lease；缺少 Web
  Locks 时 Pair、Resume 和 Cookie cleanup fail closed。Logout 仍可立即
  锁屏并发送其精确 Session Logout。
- 身份数据库 open/Context 校验/pointer 发布与 Revoke 的 pointer
  判定共享
  `family-ai-member-cache-open:${installationId}` Web Lock。每个 active
  Product 持有
  `family-ai-member-product-flight:${installationId}` shared lease，直到
  Sync 关闭、请求 abort/drain、Renderer/cache 释放后才归还；会设置或
  清除 Cookies 的 lifecycle 路径持 exclusive Product-flight barrier。
  完整锁序固定为 Cookie mutation → Entry mutation →
  Product-flight(exclusive) → cache-open；Product 只走
  Product-flight(shared) → cache-open。任何路径不得反向取锁。
- 每个 Context 启动 ticket 必须绑定读取或提交时的 exact lifecycle
  `{revision,state,transitionId}`；每次成功 Claim 即使原状态已 active 也推进
  一次 revision，所有 Product guards 在请求 shared flight 前、cache-open
  内和启动后校验该快照。
- Pairing material 只在 unresolved pending Claim 的当前标签 `sessionStorage` 中短暂存在；不得进入 LocalStorage、IndexedDB、Git、日志、PublicError、BroadcastChannel 或 JSON 响应。
- 正式 Member URL 使用 `/member/#pairingRef=pairing%3Aweb-alice-0001&code=ABCD-EFGH` 这一 fragment 结构；fragment 必须在第一次 API/credentialed fetch 前同步清除。
- Preview Gateway 只监听 Linux `127.0.0.1:8791`，故障代理只监听 `127.0.0.1:8792`；不得停止、重建或替换现有健康的 `127.0.0.1:8790` 容器。
- 本 worktree 不运行 `scripts/verify-foundation.sh` 或固定 Compose 项目；Preview 使用 `.runtime-preview/` 下独立数据库、Token、PID、handoff 和日志。
- 用户体验使用真实 `/member/`、Cookie、Entry、Chat、Work 和 Sync 路径；development Fake Provider 回复必须明确标注为模拟回复。

---

## File Map

### New production and browser-support files

- `apps/gateway/src/webEntryCrypto.ts` — canonical Device Credential 解码和首次 Claim Session HKDF 派生。
- `apps/gateway/member-public/cache-identity.js` — Context 身份键、按身份开库、旧库删除和 revoke 删库。
- `apps/gateway/member-public/pairing.js` — fragment 解析/清除、pending Claim、Credential 生成和错误处置。
- `apps/gateway/member-public/entry-storage.js` — installation、lock marker、identity pointer、lifecycle revision 和 revoke tombstone。
- `apps/gateway/member-public/entry-mutation.js` — origin-global Cookie 与
  installation-scoped Entry/Product-flight/cache-open 的固定顺序 Web
  Lock 串行器。
- `apps/gateway/member-public/entry-lifecycle.js` — Web Lock、BroadcastChannel、Logout/Resume/Revoke 状态机。
- `scripts/member-preview-up.sh` — 构建并启动独立 `8791` Gateway 与 `8792` 故障代理。
- `scripts/member-preview-pair.mjs` — 初始化 Preview Family（仅首次）并生成 `0600` fragment handoff。
- `scripts/member-preview-revoke.mjs` — 通过 Preview Admin Session 和正式 Admin API 撤销指定配对产生的 Web Device。
- `scripts/member-preview-secret-audit.mjs` — 运行五类动态 sentinel 并扫描允许边界之外的日志/响应。
- `scripts/member-preview-down.sh` — 仅停止 `.runtime-preview` 记录的 Gateway/代理 PID。
- `scripts/member-preview-claim-loss-proxy.mjs` — 整站同源反向代理，只丢弃首次已提交 Claim 的下游响应。
- `scripts/write-member-handoff.mjs` — 从 stdin 读取配对材料并写入 `0600` fragment handoff。

### New test-support and test files

- `apps/gateway/test/helpers/memberBrowserHarness.ts` — 无第三方依赖的 Storage、Web Locks、BroadcastChannel、EventTarget 和最小 DOM harness。
- `apps/gateway/test/webEntryCrypto.test.ts` — canonical Credential 与固定 HKDF 向量。
- `apps/gateway/test/memberIdentityCache.test.ts` — A/B/A 身份隔离、旧库删除和删库阻塞。
- `apps/gateway/test/memberPairingClient.test.ts` — fragment、pending Claim、Credential 和错误分类行为。
- `apps/gateway/test/memberEntryStorage.test.ts` — installation、revision、marker、tombstone 与 Web Lock 行为。
- `apps/gateway/test/memberProductWorkbenchLifecycle.test.ts` — 身份校验先于投影读取和 Workbench 安全停启。
- `apps/gateway/test/memberHandoff.test.ts` — handoff 文件权限与 stdout/stderr 秘密隔离。
- `apps/gateway/test/memberSecretBoundary.test.ts` — 五类动态 sentinel 的 PublicError、Channel、Storage 和普通 JSON 边界。
- `apps/gateway/test/memberPreviewProxy.test.ts` — `8792` 全站代理与一次性响应丢失。
- `apps/gateway/test/memberPreviewScripts.test.ts` — 隔离端口、runtime 权限、PID 范围和秘密 handoff。
- `docs/superpowers/evidence/2026-07-25-member-web-entry-hardening.md` — 最终门禁、端口隔离、秘密扫描和体验路径证据。

### Existing files modified

- `packages/contracts/src/webEntry.ts`
- `packages/contracts/fixtures/web-entry/claim-request.json`
- `packages/contracts/fixtures/web-entry/context-response.json`
- `packages/contracts/fixtures/web-entry/error-response.json`
- `packages/contracts/fixtures/web-entry/operation-response.json`
- `packages/contracts/test/webEntry.test.ts`
- `apps/gateway/src/database.ts`
- `apps/gateway/src/webEntry.ts`
- `apps/gateway/src/webEntryCookies.ts`
- `apps/gateway/src/webEntryRoutes.ts`
- `apps/gateway/src/entrySessionAuth.ts`
- `apps/gateway/src/eventStream.ts`
- `apps/gateway/src/app.ts`
- `apps/gateway/src/memberWeb.ts`
- `apps/gateway/member-public/api.js`
- `apps/gateway/member-public/cache.js`
- `apps/gateway/member-public/entry.js`
- `apps/gateway/member-public/product.js`
- `apps/gateway/member-public/render.js`
- `apps/gateway/member-public/sync.js`
- `apps/gateway/member-public/index.html`
- `apps/gateway/test/database.test.ts`
- `apps/gateway/test/webEntryRepository.test.ts`
- `apps/gateway/test/webEntryRoutes.test.ts`
- `apps/gateway/test/webEntryCookies.test.ts`
- `apps/gateway/test/webEntryBridge.test.ts`
- `apps/gateway/test/eventStream.test.ts`
- `apps/gateway/test/eventStreamResilience.test.ts`
- `apps/gateway/test/syncContracts.test.ts`
- `apps/gateway/test/memberApiStore.test.ts`
- `apps/gateway/test/memberCacheModel.test.ts`
- `apps/gateway/test/memberEntryLifecycle.test.ts`
- `apps/gateway/test/memberRenderLifecycle.test.ts`
- `apps/gateway/test/memberSyncAuth.test.ts`
- `apps/gateway/test/memberWebModules.test.ts`
- `apps/gateway/test/memberWebOneClick.test.ts`
- `scripts/acceptance-onboarding.sh`
- `scripts/dev-up.sh`
- `scripts/verify-foundation.sh`
- `scripts/static-check.sh`
- `.gitignore`
- `.dockerignore`
- `docs/development/2026-07-25-member-web-product-workbench.md`

---

### Task 1: Freeze Web Entry v2 public contracts

**Files:**
- Modify: `packages/contracts/src/webEntry.ts:1-52`
- Modify: `packages/contracts/fixtures/web-entry/claim-request.json`
- Modify: `packages/contracts/fixtures/web-entry/context-response.json`
- Create: `packages/contracts/fixtures/web-entry/error-response.json`
- Modify: `packages/contracts/fixtures/web-entry/operation-response.json`
- Modify: `packages/contracts/test/webEntry.test.ts:1-80`

**Interfaces:**
- Produces: `WEB_ENTRY_PROTOCOL_VERSION = 2`
- Produces: `webDeviceCredentialSchema` and `webPairingClaimRequestSchema` with required canonical Credential
- Produces: `WEB_ENTRY_REVOKED_SSE_EVENT_NAME = "entry-revoked"`
- Produces: `webEntryRevokedSseDataSchema` and `webGatewayErrorSchema`
- Preserves: nested `personalPortalContextSchema.protocolVersion = 1`

- [ ] **Step 1: Write the failing v2 contract tests**

```ts
describe("Web Entry v2 contracts", () => {
  it("requires canonical client-generated Device Credential", () => {
    expect(WEB_ENTRY_PROTOCOL_VERSION).toBe(2);
    const request = fixture("claim-request.json") as Record<string, unknown>;
    expect(webPairingClaimRequestSchema.parse(request)).toMatchObject({
      protocolVersion: 2,
      deviceCredential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      protocolVersion: 1
    }).success).toBe(false);
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      deviceCredential: "short"
    }).success).toBe(false);
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      deviceCredential: "A".repeat(42) + "B"
    }).success).toBe(false);
  });

  it("keeps every public response credential-free", () => {
    const context = fixture("context-response.json") as Record<string, unknown>;
    expect(context).toMatchObject({
      protocolVersion: 2,
      context: { protocolVersion: 1 }
    });
    expect(JSON.stringify(context).toLowerCase()).not.toContain("credential");
    expect(JSON.stringify(context).toLowerCase()).not.toContain("entrytoken");
  });

  it("defines the credential-free revoke control and v2 error envelope", () => {
    expect(WEB_ENTRY_REVOKED_SSE_EVENT_NAME).toBe("entry-revoked");
    expect(webEntryRevokedSseDataSchema.parse({
      protocolVersion: 2,
      type: "device_revoked"
    })).toEqual({ protocolVersion: 2, type: "device_revoked" });
    expect(webGatewayErrorSchema.parse(fixture("error-response.json")))
      .toEqual(fixture("error-response.json"));
  });
});
```

- [ ] **Step 2: Run the contract test and observe RED**

Run through `ssh admin-yr` on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
npm exec --workspace @family-ai/contracts -- vitest run test/webEntry.test.ts
```

Expected: FAIL because `WEB_ENTRY_PROTOCOL_VERSION` is `1` and the strict request schema rejects `deviceCredential`.

- [ ] **Step 3: Implement the strict v2 schema and fixtures**

```ts
import {
  pairingCodeSchema,
  pairingRefSchema,
  personalPortalContextSchema
} from "./mobileEntry.js";

export const WEB_ENTRY_PROTOCOL_VERSION = 2 as const;
export const webDeviceCredentialSchema = z.string().regex(
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
);

export const webPairingClaimRequestSchema = z.object({
  protocolVersion: z.literal(WEB_ENTRY_PROTOCOL_VERSION),
  pairingRef: pairingRefSchema.optional(),
  code: pairingCodeSchema,
  installationId: z.string().uuid(),
  deviceCredential: webDeviceCredentialSchema,
  device: webDeviceDescriptorSchema
}).strict();

export const WEB_ENTRY_REVOKED_SSE_EVENT_NAME = "entry-revoked" as const;
export const webEntryRevokedSseDataSchema = z.object({
  protocolVersion: z.literal(WEB_ENTRY_PROTOCOL_VERSION),
  type: z.literal("device_revoked")
}).strict();

export const webGatewayErrorSchema = z.object({
  protocolVersion: z.literal(WEB_ENTRY_PROTOCOL_VERSION),
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    category: z.enum([
      "validation", "permission", "availability",
      "timeout", "conflict", "internal"
    ]),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    requestId: z.string().min(1)
  }).strict()
}).strict();
```

The final-character class encodes the required zero padding bits for a canonical unpadded 32-byte Base64URL value. Update the Claim/Context/Operation fixtures to top-level `protocolVersion: 2`; add the 43-character canonical Credential only to `claim-request.json`. Add `error-response.json` with v2, a synthetic `DEVICE_REVOKED` error, and a synthetic request ID.

- [ ] **Step 4: Build contracts and run their full tests**

Run:

```bash
npm run build -w @family-ai/contracts
npm exec --workspace @family-ai/contracts -- vitest run test
```

Expected: all contract tests PASS; Mobile Entry v1 fixtures remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/webEntry.ts packages/contracts/fixtures/web-entry packages/contracts/test/webEntry.test.ts
git commit -m "feat(contracts): require web entry v2 credentials"
```

---

### Task 2: Add durable Web Claim replay metadata migration

**Files:**
- Modify: `apps/gateway/src/database.ts:367-470`
- Modify: `apps/gateway/test/database.test.ts:18-105`

**Interfaces:**
- Produces: Gateway schema migration `6`
- Produces columns:
  - `mobile_pairing_codes.web_claim_session_ref TEXT REFERENCES entry_sessions(entry_session_ref)`
  - `mobile_pairing_codes.web_replay_count INTEGER NOT NULL DEFAULT 0 CHECK (web_replay_count >= 0)`

- [ ] **Step 1: Write the failing migration test**

```ts
const migrationVersions = [
  { version: 1 },
  { version: 2 },
  { version: 3 },
  { version: 4 },
  { version: 5 },
  { version: 6 }
];

it("adds bounded Web Claim replay metadata", () => {
  directory = mkdtempSync(join(tmpdir(), "family-ai-web-replay-schema-"));
  db = openGatewayDatabase(join(directory, "gateway.sqlite"));
  const columns = db.prepare("PRAGMA table_info(mobile_pairing_codes)").all()
    .map((row) => String((row as { name: unknown }).name));
  expect(columns).toEqual(expect.arrayContaining([
    "web_claim_session_ref",
    "web_replay_count"
  ]));
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
```

Update the existing exact `pairingColumns` array by appending the two new names. Add a V5-upgrade fixture that creates `schema_migrations` with rows 1–5, an `entry_sessions(entry_session_ref TEXT PRIMARY KEY)` target, and the 13-column V5 `mobile_pairing_codes` table with one active and one consumed row. Opening it through `openGatewayDatabase()` must:

- append only migration 6;
- retain both rows;
- yield `web_claim_session_ref = NULL` and `web_replay_count = 0`;
- report `notnull = 1` and default `0` for the count;
- report the `entry_sessions` foreign-key target;
- reject an update to `web_replay_count = -1`.

- [ ] **Step 2: Run the database test and observe RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run test/database.test.ts
```

Expected: FAIL because migration `6` and both columns do not exist.

- [ ] **Step 3: Add migration 6 and advance the migration guard**

```ts
const MIGRATION_V6 = `
ALTER TABLE mobile_pairing_codes
  ADD COLUMN web_claim_session_ref TEXT REFERENCES entry_sessions(entry_session_ref);
ALTER TABLE mobile_pairing_codes
  ADD COLUMN web_replay_count INTEGER NOT NULL DEFAULT 0
  CHECK (web_replay_count >= 0);
`;
```

Extend `applyMigrations()` from `5` to `6`, record version `6` in the same transaction, reject versions above `6`, and require final version `6`.

- [ ] **Step 4: Verify new and reopened databases**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run test/database.test.ts
npm run typecheck -w @family-ai/gateway
```

Expected: database tests PASS new/open-twice behavior, V5→V6 retained-row upgrade, exact column order, schema ledger `[1..6]`, constraint checks and foreign-key check.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/database.ts apps/gateway/test/database.test.ts
git commit -m "feat(gateway): persist web claim replay metadata"
```

---

### Task 3: Implement canonical Credential decoding and HKDF

**Files:**
- Create: `apps/gateway/src/webEntryCrypto.ts`
- Create: `apps/gateway/test/webEntryCrypto.test.ts`

**Interfaces:**
- Produces: `decodeCanonicalWebDeviceCredential(value: string): Buffer`
- Produces: `deriveWebClaimEntryToken(deviceCredential: string, pairingRef: string): string`

- [ ] **Step 1: Write failing fixed-vector and rejection tests**

```ts
import {
  decodeCanonicalWebDeviceCredential,
  deriveWebClaimEntryToken
} from "../src/webEntryCrypto.js";

it("derives the fixed v2 claim-session vector", () => {
  const credential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  expect(decodeCanonicalWebDeviceCredential(credential)).toHaveLength(32);
  expect(deriveWebClaimEntryToken(credential, "pairing:web-alice-0001"))
    .toBe("-dlmHncaTJJzTa7rq-30_N_VkSGf-Ep3EDeDdMaze08");
});

it.each([
  "",
  "A".repeat(42),
  "A".repeat(44),
  "A".repeat(42) + "/",
  "A".repeat(42) + "B"
])("rejects non-canonical Credential %j", (credential) => {
  expect(() => decodeCanonicalWebDeviceCredential(credential))
    .toThrow("WEB_DEVICE_CREDENTIAL_INVALID");
});
```

- [ ] **Step 2: Run the crypto test and observe RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run test/webEntryCrypto.test.ts
```

Expected: FAIL because `webEntryCrypto.ts` does not exist.

- [ ] **Step 3: Implement exact canonical decode and HKDF parameters**

```ts
import { createHash, hkdfSync } from "node:crypto";

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_SESSION_INFO = Buffer.from(
  "family-ai:web-entry:claim-session:v2",
  "utf8"
);

export function decodeCanonicalWebDeviceCredential(value: string): Buffer {
  if (!CREDENTIAL_PATTERN.test(value)) throw new Error("WEB_DEVICE_CREDENTIAL_INVALID");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("WEB_DEVICE_CREDENTIAL_INVALID");
  }
  return decoded;
}

export function deriveWebClaimEntryToken(
  deviceCredential: string,
  pairingRef: string
): string {
  const salt = createHash("sha256").update(pairingRef, "utf8").digest();
  return Buffer.from(hkdfSync(
    "sha256",
    decodeCanonicalWebDeviceCredential(deviceCredential),
    salt,
    CLAIM_SESSION_INFO,
    32
  )).toString("base64url");
}
```

- [ ] **Step 4: Run crypto tests and typecheck**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run test/webEntryCrypto.test.ts
npm run typecheck -w @family-ai/gateway
```

Expected: PASS with the fixed vector and all invalid encodings rejected.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/webEntryCrypto.ts apps/gateway/test/webEntryCrypto.test.ts
git commit -m "feat(gateway): derive idempotent web claim sessions"
```

---

### Task 4: Make repository Claim replay bounded and truly idempotent

**Files:**
- Modify: `apps/gateway/src/webEntry.ts:1-510`
- Modify: `apps/gateway/test/webEntryRepository.test.ts:1-170`

**Interfaces:**
- Consumes: `deriveWebClaimEntryToken()` from Task 3
- Consumes: migration columns from Task 2
- Changes: `WebPairingClaimRequest.deviceCredential` is the submitted pending
  candidate; the private repository input may also carry
  `existingDevice`, and the repository selects the verified effective
  Credential without conflating the two sources
- Changes: `logoutSession(input: { entrySessionRef: string; entryBindingRef: string }): boolean`
- Produces: replay of the same `{pairingRef, code, installationId, deviceCredential}` returns the same `deviceRef`, `entrySessionRef`, `entryToken`, and `expiresAt`

- [ ] **Step 1: Rewrite repository fixtures and add failing replay tests**

```ts
const claim = {
  protocolVersion: 2 as const,
  pairingRef: "",
  code: "ABCD-EFGH",
  installationId: "b53f0490-99f1-4d6c-9a95-921a3d76a8c3",
  deviceCredential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  device: {
    displayName: "Alice 的浏览器",
    browser: "Chrome 140",
    operatingSystem: "macOS 15",
    appVersion: "0.1.0"
  }
};

it("replays the same consumed Claim without rotating its Session", () => {
  const first = web.claimPairing({ ...claim, pairingRef });
  currentNow = new Date("2026-07-25T08:01:00.000Z");
  const replay = web.claimPairing({ ...claim, pairingRef });
  expect(replay).toEqual(first);
  expect(db.prepare(
    "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
  ).get(pairingRef)).toEqual({ web_replay_count: 1 });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
  ).get(first.entryBindingRef)).toEqual({ count: 1 });
});
```

Add tests for wrong Credential, different installation, revoked managed
Device, revoked `device_bindings` row with an otherwise-active Entry Binding,
revoked `entry_bindings` row with an otherwise-active Device Binding, replay
at `consumedAt + 2m + 1ms`, three successful replays followed by
`PAIRING_CONSUMED`, and two immediate replays returning the identical Session.
Add an existing-Device/new-Pairing case proving its verified Cookie Credential
is not rotated and its first/replayed Claim also uses one deterministic
Session.

- [ ] **Step 2: Run repository tests and observe RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run test/webEntryRepository.test.ts
```

Expected: FAIL because the repository generates its own Device Credential, issues a new Session on replay, and has no deadline/count checks.

- [ ] **Step 3: Extend PairingRow and implement an initial deterministic Claim Session**

```ts
interface PairingRow extends Record<string, unknown> {
  pairing_ref: string;
  code_hash: string;
  family_ref: string;
  person_ref: string;
  expires_at: string;
  status: "active" | "consumed" | "revoked" | "expired";
  failed_attempts: number;
  max_attempts: number;
  created_by_entry_binding_ref: string;
  created_at: string;
  consumed_at: string | null;
  consumed_device_ref: string | null;
  revoked_at: string | null;
  web_claim_session_ref: string | null;
  web_replay_count: number;
}
```

Add `consumed_at`, `web_claim_session_ref`, and `web_replay_count` to both `pairingByRef()` and `pairingByCodeHash()` SELECT lists so the typed row and runtime row cannot diverge.

For every active Pairing, first choose or create the Device and Binding. A new Device uses `input.deviceCredential`; an existing Device uses the Credential returned by `requireExistingDeviceCredential(existing, input.existingDevice)`. Then use the effective Credential in one common finalization path:

```ts
const deviceCredential = effectiveDeviceCredential;
const entryToken = deriveWebClaimEntryToken(deviceCredential, pairing.pairing_ref);
const session = this.issueClaimSession(entryBindingRef, entryToken);

this.db.prepare(
  `UPDATE mobile_pairing_codes
   SET status = 'consumed',
       consumed_at = ?,
       consumed_device_ref = ?,
       web_claim_session_ref = ?,
       web_replay_count = 0
   WHERE pairing_ref = ? AND status = 'active'`
).run(now, deviceRef, session.entrySessionRef, pairing.pairing_ref);
```

`issueClaimSession()` inserts one active Session without calling the normal renew path that revokes existing Sessions.

- [ ] **Step 4: Implement consumed replay as lookup, verification, and counter update**

```ts
if (!pairing.consumed_device_ref || !pairing.web_claim_session_ref) {
  throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
}
const consumedDevice = this.deviceByRef(pairing.consumed_device_ref);
if (
  !consumedDevice ||
  consumedDevice.installation_ref !== sha256(input.installationId)
) {
  throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
}
const submittedCredentialMatches = secureHashEqual(
  consumedDevice.credential_hash,
  sha256(input.deviceCredential)
);
const existingCredentialMatches =
  input.existingDevice?.deviceRef === consumedDevice.device_ref &&
  secureHashEqual(
    consumedDevice.credential_hash,
    sha256(input.existingDevice.deviceCredential)
  );
const replayCredential = existingCredentialMatches
  ? input.existingDevice!.deviceCredential
  : submittedCredentialMatches
    ? input.deviceCredential
    : null;
if (!replayCredential) {
  throw webError(
    "DEVICE_AUTH_INVALID", 401, "permission",
    "浏览器设备凭证无效。"
  );
}
if (
  consumedDevice.terminal_type !== "web" ||
  consumedDevice.platform !== "browser"
) {
  throw webError(
    "DEVICE_AUTH_INVALID", 401, "permission",
    "该设备不是浏览器入口。"
  );
}
if (consumedDevice.status === "revoked") {
  throw webError(
    "DEVICE_REVOKED", 403, "permission",
    "浏览器设备已经撤销。"
  );
}
const binding = this.personalBinding(
  consumedDevice.device_ref,
  pairing.family_ref,
  pairing.person_ref
);
if (!binding) {
  throw webError(
    "DEVICE_REVOKED", 403, "permission",
    "浏览器入口已经撤销。"
  );
}

const recoveryDeadline = Date.parse(pairing.consumed_at!) + 2 * 60 * 1000;
if (this.now().getTime() > recoveryDeadline || pairing.web_replay_count >= 3) {
  throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
}

const entryToken = deriveWebClaimEntryToken(
  replayCredential,
  pairing.pairing_ref
);
const session = this.activeClaimSession(
  pairing.web_claim_session_ref!,
  binding.entry_binding_ref,
  entryToken
);
if (!session) {
  throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
}

this.db.prepare(
  `UPDATE mobile_pairing_codes
   SET web_replay_count = web_replay_count + 1
   WHERE pairing_ref = ?
     AND status = 'consumed'
     AND web_replay_count < 3`
).run(pairing.pairing_ref);
```

Change `personalBinding()` itself to require both authorization layers:

```ts
private personalBinding(
  deviceRef: string,
  familyRef: string,
  personRef: string
): { entry_binding_ref: string } | null {
  return (this.db.prepare(
    `SELECT eb.entry_binding_ref
     FROM entry_bindings eb
     JOIN device_bindings db
       ON db.device_ref = eb.device_ref
      AND db.family_ref = eb.family_ref
      AND db.owner_scope = 'person'
      AND db.person_ref = eb.person_ref
      AND db.status = 'active'
     WHERE eb.device_ref = ? AND eb.family_ref = ? AND eb.person_ref = ?
       AND eb.audience = 'personal' AND eb.status = 'active'`
  ).get(deviceRef, familyRef, personRef) as
    { entry_binding_ref: string } | undefined) ?? null;
}
```

Both the initial existing-Device branch and consumed replay use this joined
helper. Revoking either binding layer therefore prevents replay before any
counter update or Session material is returned.

The consumed branch never blindly prefers either request field. It accepts an
`existingDevice` Credential only when its Cookie Device ref and hash match the
exact consumed Device, otherwise it falls back to the submitted pending
Credential only when that hash matches. This preserves the new-installation
response-loss path while allowing an already-authenticated Device—whose fresh
pending Credential necessarily differs—to replay the same derived Session.
Add the paired regression: existing Device Cookie + new Pairing + distinct
submitted Credential succeeds initially and after a lost response with the
same Cookie, returns the identical Session, and increments only the replay
counter; removing or corrupting that Cookie makes the distinct submitted
Credential fail with `DEVICE_AUTH_INVALID`.

`activeClaimSession()` selects the exact stored Session ref plus `entry_binding_ref`, `token_hash`, `status`, and `expires_at`; it returns `null` unless the binding matches, status is `active`, `expires_at > now`, and `secureHashEqual(token_hash, sha256(entryToken))`. Its return value reuses the stored `entrySessionRef` and `expiresAt` with the derived `entryToken`.

Require the counter update to change exactly one row. Keep all checks and the counter increment inside the SQLite transaction. Never create or revoke a Session in the consumed branch.

- [ ] **Step 5: Make Logout target only one Session**

```ts
logoutSession(input: {
  entrySessionRef: string;
  entryBindingRef: string;
}): boolean {
  const result = this.db.prepare(
    `UPDATE entry_sessions
     SET status = 'revoked', revoked_at = ?
     WHERE entry_session_ref = ?
       AND entry_binding_ref = ?
       AND status = 'active'`
  ).run(this.nowIso(), input.entrySessionRef, input.entryBindingRef);
  return result.changes === 1;
}
```

Add a regression test: logout S1 with its binding, renew to S2, repeat the delayed S1 Logout input, and assert S2 still authenticates.

- [ ] **Step 6: Run repository, database, crypto tests**

Run:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryCrypto.test.ts \
  test/webEntryRepository.test.ts \
  test/database.test.ts
```

Expected: all PASS; one Web Device, one initial Claim Session, bounded replay count, exact-session Logout.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/webEntry.ts apps/gateway/test/webEntryRepository.test.ts
git commit -m "fix(gateway): make web claim replay idempotent"
```

---

### Task 5: Route Web Entry v2 and exact-session Logout

**Files:**
- Modify: `apps/gateway/src/entrySessionAuth.ts:20-145`
- Modify: `apps/gateway/src/webEntryRoutes.ts:1-176`
- Modify: `apps/gateway/test/webEntryRoutes.test.ts:1-220`
- Modify: `apps/gateway/test/memberProductFlow.test.ts`
- Modify: `apps/gateway/test/webEntryBridge.test.ts`

**Interfaces:**
- Consumes: Web Entry v2 schemas and bounded repository Claim
- Produces: `requireEntryRequestWithSession(request, authenticator, expectedAudience?): { context: EntryContext; entrySessionRef: string }`
- Rule: an existing valid Device Cookie wins over a newly submitted Credential and can never rotate that Device Credential

- [ ] **Step 1: Update route fixtures and write response-loss tests**

Use `protocolVersion: 2` and include:

```ts
deviceCredential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
```

Add:

```ts
it("replays a lost Claim response with identical Cookies and no duplicate Device", async () => {
  const first = await claim();
  const replay = await claim(); // Deliberately do not send first Set-Cookie back.
  expect(first.statusCode).toBe(204);
  expect(replay.statusCode).toBe(204);
  expect(cookiesByName(replay.headers["set-cookie"]))
    .toEqual(cookiesByName(first.headers["set-cookie"]));
  expect(first.body).toBe("");
  expect(replay.body).toBe("");
});
```

Add a route test proving a request carrying an existing Device Cookie does not replace that Device Credential with the submitted pending value.
The Claim success response is deliberately `204 No Content`: Cookies are its
only browser-side commit, and the client fetches the formal Context route
afterward. This removes a headers-accepted/body-lost ambiguity; all public
identity data continues to come from the v2 Context response.
Update the product-flow test to perform Claim `204` → credentialed Context
`200` before Chat/Work, and prove neither initial nor replayed Claim contains
or parses a JSON body.
For every parsed non-2xx Claim error—including a repository throw after its
transaction returns—assert the response contains no positive Entry/Device
Cookie value. It may carry only explicit expiry headers from Task 6's error
matrix. This is the server invariant behind client
`claimOutcome: "rejected"`.

- [ ] **Step 2: Run route tests and observe RED**

Run:

```bash
npm run build -w @family-ai/contracts
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryRoutes.test.ts \
  test/webEntryBridge.test.ts \
  test/memberProductFlow.test.ts
```

Expected: FAIL on v2 parsing, missing request Credential handling, replay Cookie mismatch, and binding-wide Logout behavior.

- [ ] **Step 3: Return authenticated Session identity with Context**

```ts
export function requireEntryRequestWithSession(
  request: FastifyRequest,
  authenticator: EntrySessionAuthenticator,
  expectedAudience?: EntryAudience
): { context: EntryContext; entrySessionRef: string } {
  const ref = entrySessionRef(request);
  const token = bearerToken(request);
  const result = ref && token
    ? authenticator.authenticate(ref, token)
    : { status: "invalid" as const };

  if (result.status === "expired") {
    throw new GatewayDomainError(
      "ENTRY_SESSION_EXPIRED", 401, "permission", false,
      "入口会话已经过期。"
    );
  }
  if (result.status === "device_revoked") {
    throw new GatewayDomainError(
      "DEVICE_REVOKED", 403, "permission", false,
      "设备授权已经撤销。"
    );
  }
  if (result.status !== "authenticated") {
    throw new GatewayDomainError(
      "ENTRY_SESSION_INVALID", 401, "permission", false,
      "入口会话无效。"
    );
  }
  if (expectedAudience && result.context.audience !== expectedAudience) {
    throw new GatewayDomainError(
      "ENTRY_AUDIENCE_FORBIDDEN", 403, "permission", false,
      "当前入口没有执行家庭管理操作的权限。"
    );
  }
  return { context: result.context, entrySessionRef: ref! };
}

export function requireEntryRequest(
  request: FastifyRequest,
  authenticator: EntrySessionAuthenticator,
  expectedAudience?: EntryAudience
): EntryContext {
  return requireEntryRequestWithSession(request, authenticator, expectedAudience).context;
}
```

- [ ] **Step 4: Select the effective Claim Credential without rotating an existing Device**

```ts
const existingDevice = useWebDeviceCookies(request);
const claimed = input.repository.claimPairing({
  ...parsed.data,
  ...(existingDevice ? { existingDevice } : {})
});
```

`deviceCredential` always remains the submitted pending value. The repository
uses `existingDevice` only after
`deviceByInstallation(sha256(input.installationId))` finds that exact existing
Device and verifies the Cookie ref/hash against it. With no Device for the
submitted installation, it ignores an unrelated/stale Device Cookie and
creates the new Device from the submitted Credential. Add a route/repository
test with Device-A Cookies plus installation-B Claim: B hashes Credential B,
A remains unchanged, and no credential is copied across installations. The
consumed response-loss path works with no Cookie by using the submitted
Credential; the exact existing-installation path keeps its verified Cookie
Credential.

- [ ] **Step 5: Revoke only the exact authenticated Logout Session**

```ts
const authenticated = requireEntryRequestWithSession(
  request,
  input.entryAuthenticator,
  "personal"
);
input.repository.logoutSession({
  entrySessionRef: authenticated.entrySessionRef,
  entryBindingRef: authenticated.context.entryBindingRef
});
```

Return `204 No Content` for successful/replayed Claim after attaching the
exact Cookies. Return top-level protocol version `2` for Context, renew,
Logout and Revoke responses. The client must not attempt to parse a Claim
success body. Compute/validate the repository result and all Cookie strings
before mutating `reply`; attach the positive Cookies only in the final
synchronous success branch immediately followed by `reply.code(204).send()`.
Every throw reaches the error handler with no positive Claim Cookie headers
already staged.

- [ ] **Step 6: Run route and normal product flow tests**

Run on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryRoutes.test.ts \
  test/webEntryBridge.test.ts \
  test/memberProductFlow.test.ts
npm run typecheck -w @family-ai/gateway
```

Expected: PASS with identical replay Cookies and bodyless `204` Claim
success, no public secret fields, exact Logout, and unchanged Chat/Work nested
protocol v1 payloads.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/gateway/src/entrySessionAuth.ts \
  apps/gateway/src/webEntryRoutes.ts \
  apps/gateway/test/webEntryRoutes.test.ts \
  apps/gateway/test/webEntryBridge.test.ts \
  apps/gateway/test/memberProductFlow.test.ts
git commit -m "feat(gateway): expose web entry v2 claims"
```

---

### Task 6: Track Cookie authentication provenance and clear only the correct Cookies

**Files:**
- Modify: `apps/gateway/src/webEntryCookies.ts:1-178`
- Modify: `apps/gateway/src/webEntryRoutes.ts:68-176`
- Modify: `apps/gateway/src/app.ts:1-140,335`
- Modify: `apps/gateway/test/webEntryCookies.test.ts:1-150`
- Modify: `apps/gateway/test/webEntryRoutes.test.ts`
- Modify: `apps/gateway/test/webEntryBridge.test.ts`

**Interfaces:**
- Produces:

```ts
export type WebAuthenticationSource =
  | "none"
  | "explicit_authorization"
  | "entry_cookie"
  | "device_cookie";

export function webAuthenticationSource(
  request: FastifyRequest
): WebAuthenticationSource;

export function useWebDeviceCookies(
  request: FastifyRequest
): { deviceRef: string; deviceCredential: string } | null;

export function webErrorCookieHeaders(input: {
  source: WebAuthenticationSource;
  errorCode: string;
  mode: WebCookieMode;
}): string[];
```

- Produces: `POST /api/v1/web-entry/cookies/clear`, same-origin guarded, auth-free, idempotent `204`
- Consumes: `webGatewayErrorSchema` from Task 1

- [ ] **Step 1: Write failing provenance and matrix unit tests**

```ts
it("records Entry Cookie provenance but preserves explicit Authorization", () => {
  const bridged = request({ headers: { cookie: validEntryCookie } });
  expect(applyWebEntryCookieHeaders(bridged)).toBe(true);
  expect(webAuthenticationSource(bridged)).toBe("entry_cookie");

  const explicit = request({
    headers: { cookie: validEntryCookie, authorization: "Bearer explicit" }
  });
  expect(applyWebEntryCookieHeaders(explicit)).toBe(false);
  expect(webAuthenticationSource(explicit)).toBe("explicit_authorization");
});

expect(webErrorCookieHeaders({
  source: "entry_cookie",
  errorCode: "ENTRY_SESSION_EXPIRED",
  mode: "development"
})).toHaveLength(2);
expect(webErrorCookieHeaders({
  source: "entry_cookie",
  errorCode: "DEVICE_REVOKED",
  mode: "development"
})).toHaveLength(4);
expect(webErrorCookieHeaders({
  source: "explicit_authorization",
  errorCode: "DEVICE_REVOKED",
  mode: "development"
})).toEqual([]);
```

Also test `device_cookie + DEVICE_AUTH_INVALID/DEVICE_REVOKED => 4`, and all unrelated combinations return `[]`.

- [ ] **Step 2: Write failing HTTP matrix and clear-endpoint tests**

Add real-app tests that:

1. Admin-revoke a claimed Web Device.
2. Request Context, Chat, Work and Sync using the stale Cookie; assert `403 DEVICE_REVOKED` and four expired Cookies on every Cookie-bridge surface.
3. Send an explicit stale Bearer plus the same browser Cookie; assert no `Set-Cookie`.
4. Send an invalid/expired Entry Session Cookie; assert two Session Cookies expire but Device Cookies do not.
5. POST `/api/v1/web-entry/cookies/clear` with valid same-origin headers; assert `204` and four expired Cookies.
6. Assert the clear endpoint rejects missing custom header, cross-origin metadata, and explicit Authorization.
7. Make the Claim repository throw a plain `Error`; assert Web Entry returns a v2 `GATEWAY_INTERNAL_ERROR` envelope and does not fall back to Mobile v1 or a flat error body.

- [ ] **Step 3: Run Cookie/route tests and observe RED**

Run:

```bash
npm run build:contracts
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryCookies.test.ts \
  test/webEntryRoutes.test.ts \
  test/webEntryBridge.test.ts
```

Expected: FAIL because provenance is not stored, revoked errors do not attach cleanup Cookies, explicit Bearer is not distinguishable, and the clear endpoint is `404`.

- [ ] **Step 4: Implement unforgeable request provenance**

```ts
const authenticationSources =
  new WeakMap<FastifyRequest, WebAuthenticationSource>();

export function webAuthenticationSource(
  request: FastifyRequest
): WebAuthenticationSource {
  if (request.headers.authorization &&
      !authenticationSources.has(request)) {
    return "explicit_authorization";
  }
  return authenticationSources.get(request) ?? "none";
}
```

`applyWebEntryCookieHeaders()` records `"entry_cookie"` immediately before synthesizing headers. `useWebDeviceCookies()` reads the existing Device Cookies and records `"device_cookie"` only for routes that deliberately authenticate them. A request with a client-provided Authorization header remains `"explicit_authorization"` even if Cookie headers are also present.

Replace `readWebDeviceCookies(request)` with `useWebDeviceCookies(request)` in exactly three handlers: Pairing Claim existing-Device selection, Session renew, and Device revoke. Pure parsing remains private to `webEntryCookies.ts`; this prevents unrelated requests from forging or accidentally acquiring Device-Cookie provenance.

- [ ] **Step 5: Implement the exact Cookie side-effect matrix**

```ts
export function webErrorCookieHeaders(input: {
  source: WebAuthenticationSource;
  errorCode: string;
  mode: WebCookieMode;
}): string[] {
  if (input.source === "explicit_authorization" || input.source === "none") return [];
  if (input.errorCode === "DEVICE_REVOKED") {
    return clearAllWebEntryCookieHeaders(input.mode);
  }
  if (
    input.source === "device_cookie" &&
    input.errorCode === "DEVICE_AUTH_INVALID"
  ) {
    return clearAllWebEntryCookieHeaders(input.mode);
  }
  if (
    input.source === "entry_cookie" &&
    ["ENTRY_SESSION_INVALID", "ENTRY_SESSION_EXPIRED"].includes(input.errorCode)
  ) {
    return clearWebSessionCookieHeaders(input.mode);
  }
  return [];
}
```

- [ ] **Step 6: Route Web v2 errors before Mobile v1 errors**

Add `webErrorRoute(request)` for `/api/v1/web-entry/**`. Change `publicError()` to receive `mode`, attach the matrix headers before sending, and serialize Web Entry route errors with:

```ts
webGatewayErrorSchema.parse({
  protocolVersion: WEB_ENTRY_PROTOCOL_VERSION,
  error: {
    code: error.code,
    category: error.category,
    message: error.message,
    retryable: error.retryable,
    requestId: `request:${String(request.id)}`
  }
});
```

Both the `GatewayDomainError` and unexpected-error branches check Web Entry routes before Mobile routes. Unexpected Web errors serialize a v2 `GATEWAY_INTERNAL_ERROR` with `category: "internal"` and `retryable: true`. Do not change Mobile v1 serialization or non-Web Chat/Work error payloads.

- [ ] **Step 7: Add the auth-free same-origin Cookie clear route**

```ts
app.post("/api/v1/web-entry/cookies/clear", async (request, reply) => {
  assertWebCookieRequestAllowed(request);
  if (request.headers.authorization) {
    throw invalidRequest("Cookie 清理接口不接受 Authorization。");
  }
  setCookies(reply, clearAllWebEntryCookieHeaders(input.mode));
  return reply.code(204).send();
});
```

- [ ] **Step 8: Run matrix tests and typecheck**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryCookies.test.ts \
  test/webEntryRoutes.test.ts \
  test/webEntryBridge.test.ts
npm run typecheck -w @family-ai/gateway
```

Expected: all matrix cases PASS and explicit Authorization never receives Cookie side effects.

- [ ] **Step 9: Commit**

```bash
git add \
  apps/gateway/src/webEntryCookies.ts \
  apps/gateway/src/webEntryRoutes.ts \
  apps/gateway/src/app.ts \
  apps/gateway/test/webEntryCookies.test.ts \
  apps/gateway/test/webEntryRoutes.test.ts \
  apps/gateway/test/webEntryBridge.test.ts
git commit -m "fix(gateway): clear revoked web cookies safely"
```

---

### Task 7: Emit an SSE Device-revoked control event

**Files:**
- Modify: `apps/gateway/src/eventStream.ts:83-505`
- Modify: `apps/gateway/src/app.ts:235-242`
- Modify: `apps/gateway/test/eventStream.test.ts`
- Modify: `apps/gateway/test/eventStreamRoutes.test.ts`
- Modify: `apps/gateway/test/eventStreamResilience.test.ts`
- Modify: `apps/gateway/test/syncContracts.test.ts`

**Interfaces:**
- Consumes: `WEB_ENTRY_REVOKED_SSE_EVENT_NAME` and `webEntryRevokedSseDataSchema`
- Consumes: `webAuthenticationSource(request)`
- Adds:

```ts
export type EventStreamAuthenticationSource =
  | "explicit_authorization"
  | "entry_cookie";

export interface EventStreamSubscriberInput {
  personRef: string;
  cursor: number;
  entrySessionRef: string;
  token: string;
  sink: EventStreamSink;
  authenticationSource: EventStreamAuthenticationSource;
}

export function formatEntryRevokedFrame(): string;
```

- [ ] **Step 1: Write failing frame and heartbeat behavior tests**

```ts
it("notifies Cookie subscribers before gracefully ending a revoked stream", async () => {
  const authenticator = new MutableAuthenticator();
  authenticator.set("entry-session:web", authenticated("person:test"));
  const sink = new FakeSink();
  const hub = new PersonEventStreamHub(source, authenticator, { autoStart: false });
  hub.register({
    personRef: "person:test",
    cursor: 0,
    entrySessionRef: "entry-session:web",
    token: "token",
    authenticationSource: "entry_cookie",
    sink
  });

  authenticator.set("entry-session:web", { status: "device_revoked" });
  await hub.heartbeatAll();
  expect(sink.frames).toContain(formatEntryRevokedFrame());
  expect(sink.ended).toBe(true);
  expect(sink.destroyed).toBe(false);
});
```

Add a second test for `"explicit_authorization"`: Device revoke closes/destroys without writing the control frame. Extend route tests so an initial pre-flush revoke still uses the Task 6 HTTP Cookie matrix.

Add a backpressure case where a domain frame is already waiting for drain and the direct control `write()` returns `false`. Assert the control chunk is accepted by the sink before `end()`, is not placed in the hub queue that `unregister()` clears, and appears exactly once. Update every `hub.register()` call in `eventStream.test.ts`, `eventStreamResilience.test.ts`, and `syncContracts.test.ts` with an explicit `"entry_cookie"` or `"explicit_authorization"` source.
Add a two-subscriber isolation case: the first revoked Cookie sink throws from
its direct `write()`, while the second healthy revoked Cookie sink still
receives exactly one control frame and ends cleanly. The throwing sink is
destroyed, `heartbeatAll()` resolves, and no unhandled rejection is emitted.

- [ ] **Step 2: Run SSE tests and observe RED**

Run:

```bash
npm run build:contracts
npm exec --workspace @family-ai/gateway -- vitest run \
  test/eventStream.test.ts \
  test/eventStreamRoutes.test.ts
```

Expected: FAIL because subscriber input has no source and `heartbeatAll()` treats every non-authenticated result identically.

- [ ] **Step 3: Format the non-secret control frame**

```ts
export function formatEntryRevokedFrame(): string {
  const data = webEntryRevokedSseDataSchema.parse({
    protocolVersion: WEB_ENTRY_PROTOCOL_VERSION,
    type: "device_revoked"
  });
  return `event: ${WEB_ENTRY_REVOKED_SSE_EVENT_NAME}\n` +
    `data: ${JSON.stringify(data)}\n\n`;
}
```

The frame has no `id:` line, Person/Device ref, Cursor, Cookie, Token, or business content.

- [ ] **Step 4: Distinguish revoked Cookie streams in heartbeat**

When `authentication.status === "device_revoked"` and the subscriber source
is `"entry_cookie"`, isolate the direct control write per subscriber:

```ts
try {
  subscriber.sink.write(formatEntryRevokedFrame());
  this.unregister(subscriber, true);
} catch {
  this.unregister(subscriber, false);
}
continue;
```

`unregister(subscriber, true)` lets Node own the accepted chunk and `end()`
flush it even when `write()` reports backpressure. A synchronous write failure
destroys only that subscriber and cannot abort the heartbeat loop for healthy
subscribers. Do not use `enqueueFrame()`, whose queue is cleared by
unregister. Expired/invalid or explicit-Bearer subscribers retain the
non-control close behavior.

In `registerEventStreamRoutes()`, map Task 6 provenance:

```ts
authenticationSource:
  webAuthenticationSource(request) === "entry_cookie"
    ? "entry_cookie"
    : "explicit_authorization"
```

- [ ] **Step 5: Run all SSE tests**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/eventStream.test.ts \
  test/eventStreamRoutes.test.ts \
  test/eventStreamResilience.test.ts \
  test/syncContracts.test.ts \
  test/eventStreamLive.test.ts
```

Expected: PASS; domain events/backpressure stay unchanged, Cookie revoke emits exactly one control frame.

- [ ] **Step 6: Commit**

```bash
git add \
  apps/gateway/src/eventStream.ts \
  apps/gateway/src/app.ts \
  apps/gateway/test/eventStream.test.ts \
  apps/gateway/test/eventStreamRoutes.test.ts \
  apps/gateway/test/eventStreamResilience.test.ts \
  apps/gateway/test/syncContracts.test.ts
git commit -m "feat(gateway): signal web device revoke over sse"
```

---

### Task 8: Namespace Member cache by authenticated identity

**Files:**
- Create: `apps/gateway/member-public/cache-identity.js`
- Create: `apps/gateway/test/memberIdentityCache.test.ts`
- Modify: `apps/gateway/member-public/cache.js:1-194`
- Modify: `apps/gateway/test/memberCacheModel.test.ts:1-170`

**Interfaces:**
- Produces:

```js
cacheIdentityFromContext(context)
memberCacheDatabaseName(identity)
sameCacheIdentity(left, right)
validateOrInitializeMemberCacheContext(cache, context)
openIdentityMemberCache(context, { openCache = openMemberCache } = {})
deleteLegacyMemberCache({ indexedDBImpl = globalThis.indexedDB } = {})
deleteIdentityMemberCache(identity, {
  indexedDBImpl = globalThis.indexedDB,
  onBlocked = () => {}
} = {})
```

- Changes low-level opener in this independently buildable commit to:

```js
openMemberCache(databaseName = "family-ai-member-web", {
  indexedDBImpl = globalThis.indexedDB
} = {})
```

The temporary default keeps the pre-integration `product.js` caller working in
Task 8. Task 13 changes every production caller to `openIdentityMemberCache()`
and then removes this default so a new global database cannot be opened.

- [ ] **Step 1: Write failing A/B/A and fail-closed tests**

```ts
const contextFor = (suffix: string, displayName = suffix) => ({
  family: { familyRef: `family:${suffix}`, displayName: `Family ${displayName}` },
  person: { personRef: `person:${suffix}`, displayName },
  device: { deviceRef: `device:${suffix}`, displayName: `Browser ${displayName}` }
});
const contextA = contextFor("alice", "Alice");
const contextB = contextFor("bob", "Bob");

it("isolates A and B and reopens A by the exact identity triple", async () => {
  const registry = new Map<string, ReturnType<typeof createMemoryCache>>();
  const openCache = async (name: string) => {
    if (!registry.has(name)) registry.set(name, createMemoryCache());
    return registry.get(name)!;
  };

  const openedA = await openIdentityMemberCache(contextA, { openCache });
  await openedA.cache.transaction(MEMBER_CACHE_STORES, async (transaction) => {
    await transaction.put("meta", { key: "localAppliedSequence", value: 7 });
    await transaction.put("meta", { key: "selectedSection", value: "work" });
    await transaction.put("meta", { key: "selectedWorkRef", value: "work:a" });
    await transaction.put("threads", { threadRef: "thread:a" });
    await transaction.put("messages", {
      messageRef: "message:a",
      threadRef: "thread:a",
      threadSequence: 1
    });
    await transaction.put("works", { workConversationRef: "work:a" });
    await transaction.put("progress", { workConversationRef: "work:a" });
    await transaction.put("drafts", {
      threadRef: "thread:a",
      text: "A private draft"
    });
    await transaction.put("outgoing", {
      clientMessageId: "client:a",
      threadRef: "thread:a"
    });
  });

  const openedB = await openIdentityMemberCache(contextB, { openCache });
  expect(await readBootstrapSnapshot(openedB.cache)).toEqual({
    context: contextB,
    drafts: [],
    localAppliedSequence: 0,
    messages: [],
    outgoing: [],
    progress: [],
    selectedSection: "chat",
    selectedWorkRef: null,
    threads: [],
    works: []
  });

  const reopenedA = await openIdentityMemberCache(contextA, { openCache });
  expect(await readBootstrapSnapshot(reopenedA.cache)).toMatchObject({
    context: contextA,
    drafts: [{ text: "A private draft" }],
    localAppliedSequence: 7,
    messages: [{ messageRef: "message:a" }],
    outgoing: [{ clientMessageId: "client:a" }],
    progress: [{ workConversationRef: "work:a" }],
    selectedSection: "work",
    selectedWorkRef: "work:a",
    threads: [{ threadRef: "thread:a" }],
    works: [{ workConversationRef: "work:a" }]
  });
});
```

Add a test that preloads `meta.context` for A and tries to validate B against the same cache; expect `error.code === "CACHE_IDENTITY_MISMATCH"` and no snapshot read.
Add a same-identity test that reopens A with changed display names and other
non-identity Context fields; it must retain every projection above while
replacing `meta.context` with the newest complete Context.

- [ ] **Step 2: Write failing legacy/delete/versionchange tests**

Use a test-local fake IDB request/EventTarget:

- Legacy `success` resolves.
- Legacy `blocked` rejects with `LEGACY_CACHE_DELETE_BLOCKED`.
- Identity delete `blocked` calls `onBlocked` but stays pending until a later `success`.
- Identity delete `error` rejects a local error whose code is exactly
  `MEMBER_CACHE_DELETE_FAILED` and whose cause is the IndexedDB error.
- A fake database `versionchange` event calls its `close()` exactly once.

- [ ] **Step 3: Run cache tests and observe RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberIdentityCache.test.ts \
  test/memberCacheModel.test.ts
```

Expected: FAIL because `cache-identity.js` does not exist and the low-level opener always uses `family-ai-member-web`.

- [ ] **Step 4: Implement stable identity derivation and validation**

```js
export function cacheIdentityFromContext(context) {
  return {
    familyRef: context.family.familyRef,
    personRef: context.person.personRef,
    deviceRef: context.device.deviceRef
  };
}

export function memberCacheDatabaseName(identity) {
  return [
    "family-ai-member-web-v2",
    identity.familyRef,
    identity.personRef,
    identity.deviceRef
  ].join(":");
}

export async function openIdentityMemberCache(
  context,
  { openCache = openMemberCache } = {}
) {
  const identity = cacheIdentityFromContext(context);
  const cache = await openCache(memberCacheDatabaseName(identity));
  try {
    await validateOrInitializeMemberCacheContext(cache, context);
    return { cache, identity };
  } catch (error) {
    cache.close();
    throw error;
  }
}
```

`validateOrInitializeMemberCacheContext()` performs one `meta` transaction:
initialize missing Context; compare all three stable refs if present; throw a
local error with `code = "CACHE_IDENTITY_MISMATCH"` before any projection read
when they differ; and overwrite the stored full Context when the identity is
the same so display and role changes refresh without losing projections.

- [ ] **Step 5: Parameterize the low-level IndexedDB opener**

Rename the fixed name to `LEGACY_DATABASE_NAME` and use it only as the temporary
default and in `deleteLegacyMemberCache()`. Open the caller-supplied
`databaseName`. After open:

```js
database.addEventListener("versionchange", () => database.close());
```

Keep every store, index, transaction helper, pagination behavior and event atomicity unchanged.

- [ ] **Step 6: Implement distinct legacy and identity deletion semantics**

`deleteLegacyMemberCache()` rejects immediately on `blocked`.
`deleteIdentityMemberCache()` reports `blocked` via callback and keeps the
request alive until `success` or `error`; it must not treat `blocked` as
deletion. Wrap `request.onerror` as `MEMBER_CACHE_DELETE_FAILED`, preserve the
original exception as `cause`, and never clear the identity pointer in this
module.

- [ ] **Step 7: Run cache behavior tests**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberIdentityCache.test.ts \
  test/memberCacheModel.test.ts \
  test/memberPersistenceReview.test.ts
```

Expected: PASS for A/B/A isolation, mismatch fail closed, legacy deletion, blocked identity deletion, versionchange close, and existing transaction/cursor behavior.

- [ ] **Step 8: Commit**

```bash
git add \
  apps/gateway/member-public/cache.js \
  apps/gateway/member-public/cache-identity.js \
  apps/gateway/test/memberIdentityCache.test.ts \
  apps/gateway/test/memberCacheModel.test.ts
git commit -m "fix(member): isolate cache by authenticated identity"
```

---

### Task 9: Give every Renderer listener one abortable owner

**Files:**
- Create/Modify: `apps/gateway/test/helpers/memberBrowserHarness.ts`
- Modify: `apps/gateway/member-public/render.js:43-414`
- Rewrite behaviorally: `apps/gateway/test/memberRenderLifecycle.test.ts`

**Interfaces:**
- Changes:

```js
createRenderer({
  store,
  actions,
  documentRef = globalThis.document,
  AbortControllerClass = globalThis.AbortController,
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis)
})
```

- The same Renderer `AbortSignal` owns static buttons/forms/inputs and dynamically rendered Work/select/retry handlers.

- [ ] **Step 1: Build the dependency-free DOM harness**

Implement `FakeDocument` with `getElementById`, `createElement`,
`querySelectorAll`, and `activeElement`. Implement
`FakeElement extends EventTarget` with every operation currently used by
`render.js`: `classList.add/toggle/contains`, `dataset`, `children`,
`firstChild`, `lastElementChild`, `append`, `removeChild`, `before`,
`querySelectorAll`, `setAttribute`, `removeAttribute`, `focus`,
`requestSubmit`, `reset`, `showModal`, `close`, `scrollHeight`, `scrollTop`,
`clientHeight`, `value`, `disabled`, `type`, `checked`, `selected`, `id`,
`className`, `options`, and `textContent`. Event helpers populate `target`,
`key`, `shiftKey`, and `preventDefault`; `requestSubmit()` dispatches the form
submit path. `createMemberDocumentHarness()` returns every ID from
`member-public/index.html`, supports `[data-section]`,
`[data-close-dialog]`, and `"button, input, textarea"`, and exposes
`click(id)`, `input(id, value)`, `submit(id)`, and `whenIdle()`.

Export the shared, concrete fixtures used by Tasks 9–13 so no test snippet
depends on an undeclared pseudo-helper:

```ts
export function createStorage(options?: {
  onSetItem?: (key: string, value: string) => void;
}): StorageHarness;
export function zeroCrypto(): Pick<Crypto, "getRandomValues">;
export function deterministicUuidCrypto(): Pick<
  Crypto,
  "getRandomValues" | "randomUUID"
>;
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
export function createDeterministicWebLocks(): WebLocksHarness;
export function createEntryControllerHarness(
  options?: EntryControllerHarnessOptions
): EntryControllerHarness;
export function memberContextFixture(
  overrides?: Partial<MemberContextFixture>
): MemberContextFixture;
export function fakeIdentityCache(options?: {
  calls?: string[];
  snapshot?: Partial<MemberSnapshotFixture>;
}): IdentityCacheFixture;
export function memberProductFetchFixture(
  calls?: string[]
): typeof globalThis.fetch;
export function memberState(overrides = {}): MemberStateFixture;
export function memberActions(overrides = {}): MemberActionSpies;
export function fakeRenderer(): { destroy: ReturnType<typeof vi.fn> };
export function fakeSync(calls: string[]): SyncFixture;
```

`memberActions()` supplies spies for all nine production actions:
`navigate`, `openWork`, `createWork`, `send`, `saveDraft`, `loadEarlier`,
`retry`, `toggleMessageSelection`, and `convertChatToWork`.
`memberProductFetchFixture()` is a strict URL/method router: it returns valid
current-contract JSON for `GET /api/v1/chat?timezone=UTC`,
`GET /api/v1/work-conversations`, and
`GET /api/v1/threads/thread%3Achat-0001/messages?limit=100`; an unlisted
request throws. It records `"chat:init"`, `"work:init"`, and
`"chat:messages"` in the optional calls array so ProductWorkbench ordering
tests execute the real Chat/Work controllers instead of silently bypassing
them.

- [ ] **Step 2: Write the failing create/destroy/recreate behavior tests**

```ts
import {
  createMemberDocumentHarness,
  memberActions,
  memberState
} from "./helpers/memberBrowserHarness.js";

it("runs Create Work once after renderer replacement", async () => {
  const harness = createMemberDocumentHarness();
  const actions = memberActions();
  const first = createRenderer({
    store: createStore(memberState()),
    actions,
    documentRef: harness.document
  });
  first.destroy();
  const second = createRenderer({
    store: createStore(memberState()),
    actions,
    documentRef: harness.document
  });

  harness.submit("createWorkForm");
  await harness.whenIdle();
  expect(actions.createWork).toHaveBeenCalledOnce();
  second.destroy();
});
```

Repeat for Chat composer submit, Draft input, Work selection, outgoing Retry,
message selection, navigation, load-earlier, and both dialogs. Call
`destroy()` twice and assert no throw. These tests exercise static and
dynamically rendered listeners and verify that each action reaches only the
second Renderer.

- [ ] **Step 3: Run Renderer tests and observe semantic RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberRenderLifecycle.test.ts
```

Expected: current implementation invokes old and new actions twice because `destroy()` leaves DOM listeners attached.

- [ ] **Step 4: Register every listener with one AbortSignal**

At Renderer creation:

```js
const controller = new AbortControllerClass();
const listenerOptions = { signal: controller.signal };
```

Pass `documentRef` through `$`, `element`, `messageNode`, `outgoingNode`, `renderThread`, `ensureMobileWorkSelect`, and `renderWorkList`. Every `addEventListener`, including dynamic Retry and selection handlers, receives `listenerOptions`.

- [ ] **Step 5: Destroy in the approved order**

```js
destroy() {
  controller.abort();
  unsubscribe();
  if (toastTimer !== null) {
    clearTimeoutFn(toastTimer);
    toastTimer = null;
  }
}
```

AbortController and unsubscribe are idempotent.

- [ ] **Step 6: Run Renderer and product controller tests**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberRenderLifecycle.test.ts \
  test/memberControllers.test.ts \
  test/memberProjectionReview.test.ts
```

Expected: all PASS; every post-rebuild user action calls exactly one current controller.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/gateway/member-public/render.js \
  apps/gateway/test/helpers/memberBrowserHarness.ts \
  apps/gateway/test/memberRenderLifecycle.test.ts
git commit -m "fix(member): abort renderer listeners on destroy"
```

---

### Task 10: Capture pairing fragments and preserve only unresolved Claims

**Files:**
- Create: `apps/gateway/member-public/pairing.js`
- Create: `apps/gateway/test/memberPairingClient.test.ts`
- Modify: `apps/gateway/member-public/api.js:1-112`
- Modify: `apps/gateway/test/memberApiStore.test.ts`

**Interfaces:**
- Produces:

```js
normalizePairingCode(value)
createDeviceCredential(cryptoImpl = globalThis.crypto)
preparePendingClaim({
  pairingRef,
  code,
  installationId,
  sessionStorage,
  cryptoImpl
})
capturePairingFragment({
  href,
  historyRef,
  installationId,
  sessionStorage,
  cryptoImpl
})
readPendingClaim(sessionStorage, expectedInstallationId)
clearPendingClaim(sessionStorage)
isTerminalPairingError(error)
shouldRetainPendingClaim(error)
```

- Adds API client methods:

```js
claimWebPairing(request)
clearWebEntryCookies()
```

- Session-only key: `family-ai-member-pending-claim:v2`

- [ ] **Step 1: Write failing Credential, fragment and storage tests**

```ts
import {
  createStorage,
  zeroCrypto
} from "./helpers/memberBrowserHarness.js";

it("creates a canonical 32-byte Credential from Web Crypto", () => {
  const cryptoImpl = {
    getRandomValues(bytes: Uint8Array) {
      bytes.fill(0);
      return bytes;
    }
  };
  expect(createDeviceCredential(cryptoImpl))
    .toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
});

it("captures and scrubs the fragment synchronously", () => {
  const calls: string[] = [];
  const sessionStorage = createStorage({
    onSetItem: () => calls.push("store")
  });
  const historyRef = {
    state: { retained: true },
    replaceState(state: unknown, _title: string, url: string) {
      expect(state).toEqual({ retained: true });
      calls.push(`scrub:${url}`);
    }
  };

  const pending = capturePairingFragment({
    href: "http://127.0.0.1:8791/member/#pairingRef=pairing%3Aweb-1&code=abcd-efgh",
    historyRef,
    installationId: "b53f0490-99f1-4d6c-9a95-921a3d76a8c3",
    sessionStorage,
    cryptoImpl: zeroCrypto()
  });

  expect(calls).toEqual(["store", "scrub:/member/"]);
  expect(pending).toEqual({
    protocolVersion: 2,
    pairingRef: "pairing:web-1",
    code: "ABCD-EFGH",
    installationId: "b53f0490-99f1-4d6c-9a95-921a3d76a8c3",
    deviceCredential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  });
  expect(readPendingClaim(
    sessionStorage,
    "b53f0490-99f1-4d6c-9a95-921a3d76a8c3"
  )).toEqual(pending);
});
```

Add behavior cases for:

- an invalid fragment is scrubbed before `PAIRING_FRAGMENT_INVALID` is thrown;
- a valid fragment is stored in SessionStorage before `replaceState`; if Web
  Crypto or SessionStorage fails, no Claim request is made and the fragment
  remains available for a browser/user retry;
- query parameters do not count as pairing material and legacy `pairingRef`/`code` query keys are removed from history;
- re-reading an unresolved pending Claim returns byte-for-byte identical material;
- a pending Claim whose stored `installationId` differs from the current
  installation is cleared synchronously and returned as `null`;
- a SessionStorage object whose Credential ends in non-canonical `B` is rejected and cleared;
- success clears pending material;
- `PAIRING_INVALID`, `PAIRING_EXPIRED`, `PAIRING_ATTEMPTS_EXCEEDED`, terminal `PAIRING_CONSUMED`, `DEVICE_AUTH_INVALID`, `DEVICE_REVOKED`, and `PAIRING_TARGET_INACTIVE` clear it;
- network/timeout/retryable 5xx retains it;
- a non-terminal but non-retryable error clears it and does not expose Retry;
- SessionStorage and Web Crypto absence produce `PAIRING_CREDENTIAL_UNAVAILABLE` without using LocalStorage.
- exact Claim `204` resolves without calling `response.json()`; a parsed
  non-2xx v2 envelope marks `claimOutcome: "rejected"`, while network,
  abort, malformed error and unexpected success status mark `"unknown"`;
- Claim fetch uses `credentials: "same-origin"`, `keepalive: false`, the
  unsafe-request header and the caller AbortSignal.

- [ ] **Step 2: Run the browser pairing test and observe RED**

Run on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberPairingClient.test.ts \
  test/memberApiStore.test.ts
```

Expected: FAIL because `pairing.js` and both API methods do not exist.

- [ ] **Step 3: Implement canonical browser Credential creation**

```js
const PENDING_CLAIM_KEY = "family-ai-member-pending-claim:v2";

function localPairingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createDeviceCredential(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.getRandomValues !== "function" ||
      typeof globalThis.btoa !== "function") {
    throw localPairingError(
      "PAIRING_CREDENTIAL_UNAVAILABLE",
      "当前浏览器无法安全建立入口。"
    );
  }
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  const binary = String.fromCharCode(...bytes);
  return globalThis.btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
```

Assert the result matches
`/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/`; otherwise throw the same local
error. This is the canonical 32-byte unpadded base64url subset used by the v2
Contracts schema.

- [ ] **Step 4: Implement synchronous capture, validation and scrubbing**

```js
export function capturePairingFragment(input) {
  const url = new URL(input.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const hasPairingMaterial =
    fragment.has("pairingRef") || fragment.has("code");
  url.hash = "";
  url.searchParams.delete("pairingRef");
  url.searchParams.delete("code");

  const scrub = () => input.historyRef.replaceState(
    input.historyRef.state, "", `${url.pathname}${url.search}`
  );

  if (!hasPairingMaterial) {
    scrub();
    return readPendingClaim(
      input.sessionStorage,
      input.installationId
    );
  }
  const pairingRef = fragment.get("pairingRef");
  const code = normalizePairingCode(fragment.get("code"));
  if (
    fragment.getAll("pairingRef").length !== 1 ||
    fragment.getAll("code").length !== 1 ||
    !/^pairing:[a-z0-9][a-z0-9._:-]{1,126}$/u.test(pairingRef ?? "") ||
    !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(code)
  ) {
    scrub();
    throw localPairingError(
      "PAIRING_FRAGMENT_INVALID",
      "配对链接无效，请重新生成。"
    );
  }
  const pending = preparePendingClaim({
    pairingRef,
    code,
    installationId: input.installationId,
    sessionStorage: input.sessionStorage,
    cryptoImpl: input.cryptoImpl
  });
  scrub();
  return pending;
}
```

`preparePendingClaim()` uses the exact Contracts expressions
`/^pairing:[a-z0-9][a-z0-9._:-]{1,126}$/` and
`/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/`, creates one Credential, stores only
the v2 request fields in SessionStorage, and returns them. The browser test
locks these expressions to the Contracts fixtures so the plain-JS client
cannot silently widen them. `readPendingClaim()` applies the same
`/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/` canonical rule before returning a
stored Credential. It also requires the stored `installationId` to equal its
`expectedInstallationId`; mismatch clears the record and returns `null`
without any fetch. Neither function writes LocalStorage or IndexedDB.

For manual code entry, `pairingRef` may be absent and is omitted from the
stored/request object; when present it must match the exact Contracts
expression above. Implement terminal classification with this exact set:

```js
const TERMINAL_PAIRING_CODES = new Set([
  "PAIRING_INVALID",
  "PAIRING_EXPIRED",
  "PAIRING_ATTEMPTS_EXCEEDED",
  "PAIRING_CONSUMED",
  "DEVICE_AUTH_INVALID",
  "DEVICE_REVOKED",
  "PAIRING_TARGET_INACTIVE"
]);
```

`shouldRetainPendingClaim(error)` returns true only for a fetch/network
`TypeError`, timeout category, `GATEWAY_UNAVAILABLE` code, or
`error.retryable === true`. Any other
non-terminal error clears pending material and returns to input rather than
blindly replaying.

- [ ] **Step 5: Add the two API client methods**

```js
claimWebPairing: async (request, { signal } = {}) => {
  try {
    const response = await rawApiRequest(
      "/api/v1/web-entry/pairing/claim",
      {
        method: "POST",
        body: request,
        signal,
        keepalive: false
      }
    );
    if (response.status === 204) return;
    if (!response.ok) {
      const error = await parseGatewayError(response);
      Object.defineProperty(error, "claimOutcome", {
        value: "rejected",
        enumerable: false
      });
      throw error;
    }
    throw localApiError(
      "ENTRY_CLAIM_RESPONSE_INVALID",
      "配对响应无效。"
    );
  } catch (error) {
    if (error.claimOutcome !== "rejected") {
      Object.defineProperty(error, "claimOutcome", {
        value: "unknown",
        enumerable: false
      });
    }
    throw error;
  }
},
clearWebEntryCookies: () => apiRequest(
  "/api/v1/web-entry/cookies/clear",
  { method: "POST" }
),
```

`rawApiRequest()` retains `credentials: "same-origin"` and the existing
unsafe-request header behavior but returns the Response without consuming a
success body. `parseGatewayError()` applies the same v2 error validation as
`apiRequest()`. Never infer success from a parsed JSON body or expose response
headers to lifecycle code.

- [ ] **Step 6: Run pairing and API regression tests**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberPairingClient.test.ts \
  test/memberApiStore.test.ts
```

Expected: PASS; pending material survives only retryable failures and the fragment is absent before any network call can be scheduled.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/gateway/member-public/pairing.js \
  apps/gateway/member-public/api.js \
  apps/gateway/test/memberPairingClient.test.ts \
  apps/gateway/test/memberApiStore.test.ts
git commit -m "feat(member): make pairing claims safely retryable"
```

---

### Task 11: Persist non-secret Entry state and serialize mutations

**Files:**
- Create: `apps/gateway/member-public/entry-storage.js`
- Create: `apps/gateway/member-public/entry-mutation.js`
- Create: `apps/gateway/test/memberEntryStorage.test.ts`
- Extend: `apps/gateway/test/helpers/memberBrowserHarness.ts`

**Interfaces:**
- Produces:

```js
createEntryStorage({
  localStorage = globalThis.localStorage,
  cryptoImpl = globalThis.crypto,
  now = () => new Date()
} = {})
```

with methods:

```js
getOrCreateInstallationId()
readInstallationId()
rotateInstallationId(expectedInstallationId)
readLockMarker(installationId)
writeLockMarker(installationId)
clearLockMarker(installationId)
readIdentityPointer(installationId)
writeIdentityPointer(installationId, identity)
clearIdentityPointer(installationId)
readCleanupTombstone(installationId)
listCleanupTombstones()
writeCleanupTombstone(installationId, tombstone)
clearCleanupTombstone(installationId, expectedTransitionId)
readClaimCookieIntent()
writeClaimCookieIntent(intent)
clearClaimCookieIntent(expectedTransitionId)
readCookieClearPending()
writeCookieClearPending(signal)
clearCookieClearPending(expectedTransitionId)
readCookieOwnerWakeFromEvent(storageEvent)
readLifecycle(installationId)
advanceLifecycle(installationId, state, transitionId)
```

- Produces:

```js
createEntryMutationLock({
  locks = globalThis.navigator?.locks
} = {})
```

with
`{ available, runCookieMutation(callback), run(installationId, callback), acquireProductFlight(installationId), runProductDrain(installationId, callback), runCacheOpen(installationId, callback) }`.

- [ ] **Step 1: Write failing key, revision and rotation tests**

```ts
it("stores only protocol-v2 non-secret lifecycle records", () => {
  const storage = createStorage();
  const entry = createEntryStorage({
    localStorage: storage,
    cryptoImpl: deterministicUuidCrypto(),
    now: () => new Date("2026-07-25T09:00:00.000Z")
  });
  const installationId = entry.getOrCreateInstallationId();
  entry.writeLockMarker(installationId);
  const locked = entry.advanceLifecycle(
    installationId,
    "locked",
    "82c136a6-20b8-4f04-8d99-ec754c0dc9f8"
  );
  const active = entry.advanceLifecycle(
    installationId,
    "active",
    "1d98be57-0696-4539-9fc6-0d768cd80f13"
  );

  expect(locked.revision).toBe(1);
  expect(active.revision).toBe(2);
  expect(entry.readLockMarker(installationId)).toEqual({
    protocolVersion: 2,
    lockedAt: "2026-07-25T09:00:00.000Z"
  });
  expect(JSON.stringify(storage.dump())).not.toMatch(
    /token|cookie|credential|pairingRef|message/iu
  );
});
```

Add tests that:

- all exact keys include the old installation ID;
- malformed/wrong-version records fail closed and are never treated as active;
- `rotateInstallationId(oldId)` rotates once and a repeated call returns the already-current ID;
- identity pointers contain only protocol version and the exact identity triple;
- tombstones accept `closing` with `identity: null` or one exact identity,
  accept `deleting` only with one exact identity, and require a non-secret
  `cookiesCleared: boolean` crash checkpoint;
- tombstone writes are monotonic for one `transitionId`: they reject
  `cookiesCleared: true → false`, `deleting → closing`, exact identity →
  null/different identity, and ownership replacement; clear also requires the
  matching transition ID;
- `listCleanupTombstones()` scans only `family-ai-member-revoke-cleanup:` keys and returns the installation ID encoded in each valid key;
- the origin-global Cookie-clear signal accepts only
  `{ protocolVersion: 2, transitionId, installationId, createdAt }`, contains
  no identity or secret, and clears only when the expected transition matches;
- the origin-global Claim Cookie intent accepts the same non-secret owner
  fields, refuses replacement by another transition, and clears only on the
  exact owner. It is durable before the first Claim request byte and may never
  coexist with a Cookie-clear signal;
- `readCookieOwnerWakeFromEvent()` preserves event causality: valid
  `newValue` is `kind: "set"`, exact removal (`newValue === null`) with valid
  `oldValue` is `kind: "clear"`, and malformed/update events are rejected. A
  later live-storage re-read may not erase this set/clear distinction;
- lifecycle revisions are monotonically incremented from the stored record, not a tab-local counter.
- two `writeLockMarker()` calls under the same fixed clock still produce
  strictly increasing `lockedAt` values, and a clear operation carrying the
  first marker cannot delete the second marker.

- [ ] **Step 2: Write failing Web Lock serialization tests**

```ts
import {
  createDeterministicWebLocks,
  createStorage,
  deferred,
  deterministicUuidCrypto
} from "./helpers/memberBrowserHarness.js";

it("serializes two mutations under the exact installation lock", async () => {
  const locks = createDeterministicWebLocks();
  const mutation = createEntryMutationLock({ locks });
  const order: string[] = [];
  const firstEntered = deferred<undefined>();
  const releaseFirst = deferred<undefined>();

  const first = mutation.run("install-a", async () => {
    order.push("a:start");
    firstEntered.resolve(undefined);
    await releaseFirst.promise;
    order.push("a:end");
  });
  await firstEntered.promise;
  const second = mutation.run("install-a", async () => {
    order.push("b:start");
    order.push("b:end");
  });
  await Promise.resolve();
  expect(order).toEqual(["a:start"]);
  releaseFirst.resolve(undefined);
  await Promise.all([first, second]);
  expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  expect(locks.requestedNames).toEqual([
    "family-ai-member-entry-mutation:install-a",
    "family-ai-member-entry-mutation:install-a"
  ]);
});
```

Add no-Web-Locks tests expecting
`error.code === "ENTRY_MUTATION_LOCK_UNAVAILABLE"` from both `run()` and
`runCookieMutation()`/`runProductDrain()`, and prove no LocalStorage lease key
is written. `acquireProductFlight()` returns an idempotent no-op lease only so
an already-authenticated tab can remain viewable; it never makes Pair,
Resume, clear or rotation available.
Add a two-installation Cookie test: an uncertain I1 Claim owns
`family-ai-member-cookie-mutation`; an I2 Claim and an I1 Cookie-clear retry
must both wait regardless of their distinct Entry lock names. Assert the
global lock serializes the actual request/response intervals and that no
late clear can run after I2 Claim.
Add a Product-flight test with two tab harnesses holding shared
`family-ai-member-product-flight:install-a` leases. An exclusive
`runProductDrain("install-a")` request must wait for both. Release A and prove
it still waits; release B and prove it enters exactly once. An `install-b`
flight does not block it. Lease release is idempotent and resolves only after
the Web Lock callback exits.
Add a cache-open lock test with Product holding shared Product-flight plus
`family-ai-member-cache-open:install-a` while Revoke acquires the Entry
mutation lock under the global Cookie lock and waits first for exclusive
Product-flight. Product publishes the pointer, releases cache-open and then
its shared flight last; Revoke enters exclusive flight, takes cache-open and
observes the pointer before rotation. Assert requested lock order
`product-flight(shared)`, `cache-open`, `cookie-mutation`, `entry-mutation`,
`product-flight(exclusive)`, `cache-open` and no deadlock. Also prove the
no-Web-Locks `runCacheOpen()` fallback executes its callback directly; Revoke
still cannot rotate because its outer Cookie/Entry/Product-drain locks fail
closed.

- [ ] **Step 3: Run storage tests and observe RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberEntryStorage.test.ts
```

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement exact records and monotonic updates**

Use these key builders:

```js
const INSTALLATION_KEY = "family-ai-web-installation-id";
const lockKey = (id) => `family-ai-member-entry-lock:${id}`;
const identityKey = (id) => `family-ai-member-cache-identity:${id}`;
const lifecycleKey = (id) => `family-ai-member-entry-state:${id}`;
const tombstoneKey = (id) => `family-ai-member-revoke-cleanup:${id}`;
export const CLAIM_COOKIE_INTENT_KEY =
  "family-ai-member-claim-cookie-intent";
export const COOKIE_CLEAR_PENDING_KEY =
  "family-ai-member-cookie-clear-pending";
```

`advanceLifecycle()` accepts only `active`, `locked`, or `revoked`, re-reads the current record, stores `revision + 1`, and returns the persisted record:

```js
const next = {
  protocolVersion: 2,
  revision: (current?.revision ?? 0) + 1,
  state,
  transitionId
};
localStorage.setItem(lifecycleKey(installationId), JSON.stringify(next));
return next;
```

`writeLockMarker()` also re-reads shared storage and returns the exact record
it persisted. Preserve the approved marker schema while making every write
distinguishable even when two tabs share one clock tick:

```js
const current = readLockMarker(installationId);
const currentMillis = Date.parse(current?.lockedAt ?? "");
const wallMillis = now().getTime();
const lockedAtMillis = Number.isFinite(currentMillis)
  ? Math.max(wallMillis, currentMillis + 1)
  : wallMillis;
const marker = {
  protocolVersion: 2,
  lockedAt: new Date(lockedAtMillis).toISOString()
};
localStorage.setItem(lockKey(installationId), JSON.stringify(marker));
return marker;
```

Allow `clearLockMarker(installationId, expectedMarker)` to remove only a
byte-equal current marker and return `true`; mismatch returns `false` without
modification. Callers that intentionally perform final revoke cleanup may
omit `expectedMarker` for unconditional removal. Resume and Claim activation
always provide their captured marker and re-check the boolean result.

The Claim intent and Cookie-clear signal are origin-global because HttpOnly
Web Entry Cookies are origin-global. `writeClaimCookieIntent()` runs before a
Claim request while Cookie→Entry locks are held, refuses an existing owner,
and returns the exact persisted record. A success `204` clears that owner
before local activation; an uncertain transport outcome retains it until a
lock owner clears all Cookies. `writeCookieClearPending()` likewise preserves
an already-valid signal instead of replacing its owner and returns the
persisted signal. Storage rejects an attempt to create either record while
the other exists.
`clearCookieClearPending(expectedTransitionId)` re-reads and removes only the
matching signal, and `clearClaimCookieIntent(expectedTransitionId)` does the
same for an intent. Their `installationId` exists to select the nested Entry
lock after the one global Cookie lock; these cleanup paths may clear Cookies
but may never clear an identity pointer, delete a database, or rotate that
installation.
`readCookieOwnerWakeFromEvent()` reuses the exact owner validator but returns
the event edge, not current storage: valid `newValue` is a set edge; only an
actual removal with `newValue === null` may use valid `oldValue` as a clear
edge. It never treats malformed replacement text as a clear.

`writeCleanupTombstone()` is a compare-and-advance boundary: when a valid
record exists, the next value must retain its `transitionId`, retain any exact
identity already learned, keep `cookiesCleared` true once set, and only move
`closing → deleting`. Invalid regressions throw
`ENTRY_TOMBSTONE_REGRESSION` without modifying storage.
`clearCleanupTombstone(id, transitionId)` likewise removes only that owner.
These checks are defensive; supported-browser writers also update the record
inside the Entry mutation lock.

`rotateInstallationId(expected)` checks the current ID first. If it no longer equals `expected`, return the current ID without generating another UUID.

- [ ] **Step 5: Implement the strict Web Lock adapter**

```js
export function createEntryMutationLock({
  locks = globalThis.navigator?.locks
} = {}) {
  const cookieMutationName = "family-ai-member-cookie-mutation";
  const productFlightName = (installationId) =>
    `family-ai-member-product-flight:${installationId}`;
  const cacheOpenName = (installationId) =>
    `family-ai-member-cache-open:${installationId}`;
  return {
    available: typeof locks?.request === "function",
    async runCookieMutation(callback) {
      if (typeof locks?.request !== "function") {
        const error = new Error("当前浏览器不支持安全 Cookie 协调。");
        error.code = "ENTRY_MUTATION_LOCK_UNAVAILABLE";
        throw error;
      }
      return locks.request(
        cookieMutationName,
        { mode: "exclusive" },
        callback
      );
    },
    async run(installationId, callback) {
      if (typeof locks?.request !== "function") {
        const error = new Error("当前浏览器不支持安全恢复入口。");
        error.code = "ENTRY_MUTATION_LOCK_UNAVAILABLE";
        throw error;
      }
      return locks.request(
        `family-ai-member-entry-mutation:${installationId}`,
        { mode: "exclusive" },
        callback
      );
    },
    async acquireProductFlight(installationId) {
      if (typeof locks?.request !== "function") {
        return { release: async () => {} };
      }
      let releaseHold;
      let acquiredResolve;
      let acquiredReject;
      let released = false;
      const acquired = new Promise((resolve, reject) => {
        acquiredResolve = resolve;
        acquiredReject = reject;
      });
      const hold = new Promise((resolve) => {
        releaseHold = resolve;
      });
      const done = locks.request(
        productFlightName(installationId),
        { mode: "shared" },
        async () => {
          acquiredResolve();
          await hold;
        }
      );
      done.catch(acquiredReject);
      await acquired;
      return {
        async release() {
          if (!released) {
            released = true;
            releaseHold();
          }
          await done;
        }
      };
    },
    async runProductDrain(installationId, callback) {
      if (typeof locks?.request !== "function") {
        const error = new Error("当前浏览器不支持跨标签请求清理。");
        error.code = "ENTRY_MUTATION_LOCK_UNAVAILABLE";
        throw error;
      }
      return locks.request(
        productFlightName(installationId),
        { mode: "exclusive" },
        callback
      );
    },
    async runCacheOpen(installationId, callback) {
      if (typeof locks?.request !== "function") {
        return callback();
      }
      return locks.request(
        cacheOpenName(installationId),
        { mode: "exclusive" },
        callback
      );
    }
  };
}
```

The only permitted lifecycle nesting order is `runCookieMutation()` then
`run()` then `runProductDrain()` then `runCacheOpen()`. A Product generation
starts at `acquireProductFlight()` shared and may then take cache-open; it
never calls a Cookie/Entry mutation while holding either later lock. Claim,
Resume and active recovery release their exclusive Product drain and both
outer locks before starting a Product shared lease; no activation helper may
start Product while exclusive flight is held. Revoke alone proceeds from
exclusive flight into cache-open. This prevents self-deadlock while closing
the old-response Cookie race and validated-database/pointer publication race.

- [ ] **Step 6: Run storage tests and secret-source guard**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberEntryStorage.test.ts \
  test/memberWebModules.test.ts
```

Expected: PASS with serialized mutations, one rotation, monotonic revisions and no secret-bearing persistent records.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/gateway/member-public/entry-storage.js \
  apps/gateway/member-public/entry-mutation.js \
  apps/gateway/test/helpers/memberBrowserHarness.ts \
  apps/gateway/test/memberEntryStorage.test.ts
git commit -m "feat(member): coordinate entry mutations across tabs"
```

---

### Task 12: Implement the Logout, Resume and Revoke state machine

**Files:**
- Create: `apps/gateway/member-public/entry-lifecycle.js`
- Rewrite behaviorally: `apps/gateway/test/memberEntryLifecycle.test.ts`
- Extend: `apps/gateway/test/helpers/memberBrowserHarness.ts`

**Interfaces:**
- Produces:

```js
createEntryController({
  api,
  storage,
  mutationLock,
  cacheLifecycle,
  workbench,
  pendingClaims,
  deviceDescriptor,
  BroadcastChannelClass = globalThis.BroadcastChannel,
  AbortControllerClass = globalThis.AbortController,
  eventTarget = globalThis,
  now = () => new Date(),
  uuid = () => globalThis.crypto.randomUUID(),
  onViewState = () => {}
})
```

returning:

```js
{
  bootstrap({ pendingClaim = null, fragmentError = null } = {}),
  claim(pendingClaim),
  logout(),
  resume(),
  removeDevice(),
  revoke(error, expectedInstallationId),
  retry(),
  retryCleanup(expectedInstallationId),
  handleEntryFailure(error, expectedInstallationId),
  getState(),
  whenIdle(),
  destroy()
}
```

`destroy()` returns `Promise<void>` and is idempotent.

Injected adapters have these exact shapes:

```js
/** @type {{
 *   deleteLegacy: () => Promise<void>,
 *   deleteIdentity: (
 *     identity: { familyRef: string, personRef: string, deviceRef: string },
 *     options: { onBlocked: () => void }
 *   ) => Promise<void>
 * }} */
const cacheLifecycle = input.cacheLifecycle;

/** @type {{
 *   start: (
 *     context: object,
 *     expectedInstallationId: string,
 *     assertEntryStartable: () => void
 *   ) => Promise<boolean>,
 *   stop: () => Promise<void>
 * }} */
const workbench = input.workbench;

/** @type {{
 *   clear: () => void,
 *   isTerminalError: (error: unknown) => boolean,
 *   shouldRetain: (error: unknown) => boolean
 * }} */
const pendingClaims = input.pendingClaims;

/** @type {{
 *   displayName: string,
 *   browser: string,
 *   operatingSystem: string,
 *   appVersion: string
 * }} */
const deviceDescriptor = input.deviceDescriptor;
```

- Lifecycle channel: `family-ai-member-entry-lifecycle`
- States: `unpaired`, `pairing`, `active`, `locked`, `revoked`, `recoverable_error`

- [ ] **Step 1: Replace source-string assertions with cold-start behavior tests**

```ts
import {
  createEntryControllerHarness,
  deferred
} from "./helpers/memberBrowserHarness.js";

it("keeps a reloaded locked installation offline until explicit Resume", async () => {
  const env = createEntryControllerHarness({ initialMarker: true });
  const controller = env.createController();

  await controller.bootstrap();

  expect(controller.getState().name).toBe("locked");
  expect(env.api.getWebContext).not.toHaveBeenCalled();
  expect(env.api.renewWebSession).not.toHaveBeenCalled();
  expect(env.workbench.start).not.toHaveBeenCalled();
  expect(env.view.last()).toMatchObject({ showResume: true });
});
```

Add a bootstrap test proving an unresolved SessionStorage Claim is sent as `{ ...pendingClaim, device: deviceDescriptor }` and clears pending material only after success.
Add two stale-pending tests after a peer rotates installation: whether the
mock Claim would have succeeded or returned `DEVICE_REVOKED`, bootstrap clears
the old pending record before fetch, makes zero Claim/Cookie/cache/revoke
calls, and leaves the new installation on the pairing view.
Add a committed-Claim retry test: Claim succeeds once, local identity-cache
open fails, and Retry fetches Context then retries only local activation.
Assert `claimWebPairing` remains at one call, pending SessionStorage stays
cleared, replay count is not consumed by local failures, and the one committed
Claim publishes exactly one new active lifecycle revision; local retries reuse
that exact revision instead of advancing it again.
Add a same-tab double-submit test: two `claim()` calls while the first owns its
intent return the exact same Promise, make one HTTP Claim, consume zero replay
slots, and create one activation. A retry after that Promise settles creates
a new single-flight operation.
Add a Claim Cookie-intent crash matrix. Before the first request byte, assert
the non-secret origin-global intent is durable while the caller owns
Cookie→I1 Entry locks. Cover: backend not committed; backend committed but
the proxy drops the entire `204`; browser accepts the `204` then the tab
closes before the next statement; and a peer tries to Revoke/rotate or Claim
I2 during each deferred phase. A complete `204` clears the exact intent and
fetches Context without parsing a Claim body. Every uncertain outcome keeps
the intent, stops before Context/cache, and lets exactly one
Cookie→I1-Entry owner clear all Cookies before removing it; Revoke cannot
rotate and I2 cannot send Claim until that cleanup completes. A failed clear
stays fail-closed in `recoverable_error` with
`REVOKE_COOKIE_CLEAR_FAILED` and its original cause. Destroy/reload and a peer
wake must resume only that cleanup—never delete an identity database, clear a
new identity pointer, rotate, or consume another replay until the user
explicitly retries the retained pending Claim.
In the successful branch, deliver both real storage events in order: the
intent-set event and the later owner-removal event. Start the peer with active
revision R already applied and a live Product shared-flight lease. The first
receiver turn stops/drains that Product before the Claim can enter its
exclusive flight; after the Claim's `204`, owner CAS and Cookie-lock release,
Claim durably publishes active revision R+1 and the peer re-fetches Context for
that exact snapshot. The queued clear/absent-owner turn must not stop the newly
started Product. Assert one final active Product, zero Cookie-clear requests,
no unpaired transition and no duplicate Product start. In a second schedule,
pause the peer after fetching Context at R but before shared-flight acquisition;
let Claim finish R+1, then prove the old start's lifecycle guard rejects before
cache/Product requests even if the set receiver has not run yet.
Add a distinct response-after-rotation invariant test: seed the otherwise
impossible state I2 current + I1 intent, then prove bootstrap clears the
origin-global Cookies under the global Cookie lock before Context or I2 Claim;
no source-bound error may attribute I1 Cookies to I2.
Add no-Web-Locks tests for both Claim and pending origin-global Cookie cleanup:
Claim sends zero request bytes, cleanup sends zero Cookie-clear requests, both
records remain byte-for-byte, and the UI gives the supported-browser
instruction. Two tabs with deferred clear adapters must therefore have zero
late responses capable of erasing a future Session.
Add a normal-recovery test: without a local marker, an expired Context is rechecked inside the mutation lock, renewed once, re-fetched and started. With a marker, the same 401 performs zero renewal. Add a cold-start test where the installation ID was already rotated but the old-ID tombstone remains; cleanup is resumed and `rotateInstallationId(oldId)` returns the current ID without a second rotation.
Add a legacy-delete-blocked test proving Context, renew, identity-cache open, projection read and workbench start are all skipped until retry succeeds.

- [ ] **Step 2: Write failing Logout and Resume behavior tests**

Cover all of these deterministic cases:

1. Logout writes the marker and stops the local workbench before a deferred server response resolves.
2. The `storage` event makes a peer tab stop immediately.
3. Logout failure leaves both tabs locked and exposes retry/Resume controls.
4. Two simultaneous Resume clicks produce one renew: both use the fixed
   Cookie→Entry order, and the second lock holder re-requests Context and
   observes the first result.
5. Resume failure or no Web Locks preserves marker and locked state; the
   no-lock branch sends zero Context/renew requests.
6. A delayed old Logout response cannot undo the later active lifecycle revision.
7. The lifecycle channel remains open after ProductWorkbench stops and closes only on controller `destroy()`.
8. Duplicate and out-of-order channel messages re-read LocalStorage and ignore `revision <= lastAppliedRevision`.
9. A delayed rev1 `session-locked` wake arriving after shared rev2 is active applies rev2 active; it never branches on the stale message type.
10. Both BroadcastChannel and `storage` wakes share one receiver lane: defer
    rev1’s `workbench.stop()`, persist and enqueue rev2 active, release the
    stop, and assert the controller finishes active without a late rev1
    transition overriding rev2.
11. Bootstrap, Claim, Resume, runtime recovery, and active-wake tests capture
    the installation ID plus exact lifecycle snapshot before their start
    handoff and assert every
    `workbench.start(context, expectedInstallationId, assertEntryStartable)`
    receives that captured ID plus a guard bound to both values. Rotating or
    advancing lifecycle during any deferred Context/start request must
    stop/fail closed
    instead of writing a pointer under the new installation.
12. Defer an active wake’s `workbench.start()`, write a closing tombstone
    before the revoke leader writes its new lifecycle revision, then release
    start. The post-start check must stop immediately and never transition
    active while the queued storage wake waits. Task 13’s deferred-snapshot
    integration test proves the earlier injected guard prevents cached
    projection rendering when the tombstone arrives during Product startup.
13. Defer active-wake Context in one test and `workbench.start()` in another,
    call and await `controller.destroy()`, then resolve the deferred operation.
    Assert no later start/active view is produced, the workbench is stopped,
    and Channel/listeners remain closed.
14. Make an active-wake Context fail with `DEVICE_REVOKED`, defer its Cookie
    and cache cleanup, and assert `whenIdle()` does not resolve until the
    asynchronous Entry handler finishes. A rejected cleanup must be converted
    into controller `recoverable_error` state rather than an unhandled
    rejection, and the next queued wake must not overtake that handling.
15. Defer Resume Context while another Logout writes a newer marker before it
    can acquire the same lock. After Context resolves, Resume must re-read the
    marker, remain locked, perform no start or active publish, and leave the
    newer marker intact; Logout may then acquire the lock and finish.
16. Defer an I1 active-wake Context, rotate storage to I2, then reject the old
    Context with `DEVICE_REVOKED`. The receiver must pass captured I1 to the
    error boundary, which recognizes it as stale and performs zero Cookie
    clear, cache delete, lifecycle write or I2 rotation.
17. Make a current active-wake Context fail with a retryable network/5xx
    error. The serial receiver boundary stops Product, enters
    `recoverable_error`, and retries only that captured installation’s latest
    state; it must not silently swallow the non-Entry error.
18. Start with active revision R already recorded in
    `lastAppliedRevisions` and the peer Product holding a shared flight. Deliver
    the actual Claim-intent set event, let the successful Claim clear that
    owner and publish active R+1, then deliver the actual clear event. The set
    turn must stop/drain the old Product and reconcile R+1 after the Cookie lock;
    the clear turn must act only as a completion barrier. Assert the final
    tracked Product is active for the same installation, no Cookie clear is
    sent, and neither event can leave the controller active while its
    workbench is stopped. Repeat with an R Context ticket queued before shared
    flight: after Claim commits R+1, the ticket must fail its pre-cache
    lifecycle guard and only a new R+1 Context may start.

The simultaneous Resume assertion:

```ts
expect(env.api.renewWebSession).toHaveBeenCalledOnce();
expect(env.storage.readLockMarker(env.installationId)).toBeNull();
expect(env.storage.readLifecycle(env.installationId)).toMatchObject({
  state: "active",
  revision: 2
});
expect(env.workbench.start).toHaveBeenCalledTimes(2);
```

The two `workbench.start` calls are one per tab, both using a freshly fetched Context; they are not duplicate starts in one tab.

- [ ] **Step 3: Write failing Revoke cleanup behavior tests**

Cover:

1. Context, renew, Chat/Work API and Sync callback `DEVICE_REVOKED` or active
   Cookie `DEVICE_AUTH_INVALID` all stop the workbench and enter the same
   fail-closed local revoke cleanup. A Pairing-claim `DEVICE_AUTH_INVALID`
   remains the separate terminal-Claim branch: clear pending material and
   return unpaired because no identity was authenticated. If Claim succeeds
   first and Product startup then returns `DEVICE_AUTH_INVALID`, assert cleanup
   (not the terminal-Claim branch) and no final active transition.
2. `device-revoke-preparing` stops all tabs and closes both database connections before delete success.
3. One leader calls Cookie clear, deletes exactly one identity database and rotates installation exactly once.
4. `deleteDatabase.onblocked` retains tombstone, pointer, old installation and revoked view.
5. Cookie-clear network failure is wrapped as
   `REVOKE_COOKIE_CLEAR_FAILED` with the transport error as `cause`, retains
   the same tombstone/pointer/old installation, and allows
   `retryCleanup(expectedInstallationId)`.
6. Cold start with a tombstone finishes deletion without needing server Context.
7. `device-revoke-complete` makes peers read the single new installation ID and show pairing.
8. No-Web-Locks keeps the tombstone and revoked state without deleting or rotating.
9. No-Web-Locks Logout still writes the marker, stops peers through the storage event and calls exact Session Logout, but writes no authoritative lifecycle revision or revision-bearing Channel message.
10. `removeDevice()` writes the lock marker, stops the workbench and calls the formal Device DELETE; a lost/failed response remains locked without starting destructive local cleanup, while success or authoritative `DEVICE_REVOKED` enters the one-leader cleanup path.
11. A Pairing `DEVICE_REVOKED` clears pending material and enters revoke cleanup; with no validated identity pointer it clears Cookies and rotates once without calling `deleteIdentity(undefined)`. Other terminal Pairing errors clear pending and return to `unpaired`.
12. Logout→new Pairing→reload clears the old locked lifecycle under the mutation lock and restores active instead of relocking.
13. If the leader crashes after installation rotation but before complete Broadcast, peers use the installation-key/tombstone-removal storage event to reach `unpaired`.
14. No-identity cleanup resumes after simulated crashes immediately after revoked revision and immediately after Cookie clear; it rotates the old installation exactly once.
    In both cases bootstrap must detect the signal before legacy deletion,
    pending Claim, Context, renew, or cache open. Once the
    `cookiesCleared: true` checkpoint is durable, a reload—even after
    installation rotation—must make zero additional Cookie-clear requests.
15. A successful Claim waiting for the mutation lock re-reads tombstone and
    lifecycle inside the lock. If another tab writes a `closing` tombstone
    while Claim waits, Claim must not clear the marker, advance active, start
    the workbench, or publish restore; it enters the existing revoke cleanup.
16. A fresh Claim with no prior marker defers `workbench.start`; another tab
    writes a lock marker or closing tombstone before start resolves. The
    universal post-start gate stops the workbench and finishes locked/revoked,
    never active. The Task 13 guard test separately proves no Renderer is
    created when the state change occurs during an awaited startup phase.
17. No-identity Cookie-clear failure exposes
    `REVOKE_COOKIE_CLEAR_FAILED` with its cause, keeps the old installation and
    revoked crash signal, and retries the same wrapper without rotating.
18. Product holds shared Product-flight and cache-open, then pauses after exact
    Context validation but before pointer publication. Revoke writes only the
    immediate marker, acquires Cookie→Entry, creates its in-lock `closing`
    tombstone with `identity: null`, then waits for exclusive Product-flight.
    The marker storage wake must really call `stopProductWorkbench()`, abort
    and drain Product requests, and invalidate its generation. Release Product:
    despite that supersession, it publishes the exact pointer while still
    holding cache-open, its trailing ownership guard fails closed, closes the
    cache and releases the shared flight last. Only then may Revoke enter
    exclusive flight and acquire cache-open. Cleanup must promote the same
    tombstone owner to that identity, delete the database, clear the pointer,
    and only then rotate. It must never finish the no-identity branch with a
    pointer still present.
19. Start Claim with marker M1, defer its network response, then let a peer
    write monotonic marker M2. Activation must not clear M2, advance active,
    write a pointer or start Product; a retry retains M1 as its expected
    marker instead of adopting M2.
20. Defer leader A after it writes `cookiesCleared: true`/`deleting`, then
    invoke delayed Revoke B. B may write only the immediate lock marker; it
    cannot replace the tombstone outside the mutation lock. After A completes
    rotation/removal, B acquires the lock, observes current ≠ old and no
    tombstone, and exits stale without recreating one. Direct storage tests
    reject every true→false, deleting→closing, owner and identity regression.
21. Seed the impossible state “current installation rotated away + old
    tombstone has `cookiesCleared: false`”. Cold retry must fail closed with
    `ENTRY_TOMBSTONE_INCONSISTENT`; it must never clear origin-global Cookies,
    rotate again, or silently remove the signal.
22. Defer an uncertain I1 Claim while it owns the global Cookie lock. Revoke
    may write its immediate marker and stop peers, but cannot acquire Cookie,
    create a tombstone, clear, delete, or rotate until Claim resolves. On
    unknown outcome, Revoke next clears the exact intent under
    Cookie→I1-Entry, checkpoints the same clear into its tombstone, performs
    zero duplicate clear requests, deletes the pointer target, then rotates.
23. Defer an old origin-global clear response and attempt an I2 Claim from a
    second tab. Even though I1/I2 Entry lock names differ, the Claim sends
    zero request bytes until the clear response, owner CAS, and global Cookie
    lock release complete. The inverse ordering holds the Claim through its
    `204` and prevents a clear request from starting afterward. The no-lock
    variant performs zero network requests on both sides.
24. Keep tab A's I1 Product request genuinely pending while it owns the I1
    shared Product-flight; start an I1 Claim in tab B and deliver the intent
    wake to A. B must send zero Claim bytes while waiting for exclusive flight.
    A aborts the request, waits for the raw fetch to settle, destroys
    Renderer/Sync/cache and releases its shared lease last. Only then may B
    send Claim and accept `204`. Also run the inverse schedule in which
    lifecycle already owns exclusive flight: no Product request may begin
    until lifecycle releases it. A late I1 response can never apply an expiry
    Cookie over the new Session.
25. Defer `removeDevice()` immediately after its authoritative DELETE succeeds
    and concurrently queue a Claim. The Claim must send zero bytes while
    Remove holds Cookie→Entry→exclusive Product-flight, calls
    `revokeLocked()` without reacquiring, checkpoints cleanup, deletes the
    pointer target and rotates. After release, the queued old-installation
    Claim exits stale; only a newly prepared Claim bound to the one new
    installation may send.
26. During runtime Session recovery, verify the controller first writes its
    own marker and stops local Product, peers release their shared flights, and
    Context→renew→Context runs only after exclusive Product-flight enters.
    Product restart happens only after all lifecycle locks are released.
27. Deliver `entry-revoked` from Sync while its callback enters controller
    Revoke. The Sync source must already be terminal and closed before the
    callback. Reentrant `syncController.stop()` from Product disposal waits
    only the captured pre-callback barrier, never its own callback tail,
    allowing Product to release its shared flight; the outer Sync lane and
    `whenIdle()` still wait for complete Revoke cleanup and final controller
    state. Repeat with an older lane operation deferred so the callback is
    scheduled while stop begins, and with a control-only pending raw fetch:
    the immediate terminal callback must trigger Product Abort itself rather
    than waiting behind the fetch it needs to abort.

The storage-event harness must cover
`family-ai-member-entry-lock:${installationId}`,
`family-ai-member-revoke-cleanup:${installationId}`, the global
`family-ai-member-claim-cookie-intent`, and
`family-ai-member-cookie-clear-pending`. Marker/tombstone creation and a
present global Cookie owner stop/close peers even before a leader can publish;
owner removal is only a Cookie-lock completion barrier and must never stop a
newly active Product.

Assert every lifecycle channel payload has exactly:

```ts
{
  protocolVersion: 2,
  type: expect.stringMatching(
    /^(session-locked|session-restored|device-revoke-preparing|device-revoke-complete)$/
  ),
  installationId: expect.any(String),
  transitionId: expect.any(String),
  revision: expect.any(Number),
  occurredAt: expect.any(String)
}
```

and its serialized form does not match `/token|cookie|credential|pairing|message/iu`.

- [ ] **Step 4: Run lifecycle tests and observe semantic RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberEntryLifecycle.test.ts \
  test/memberEntryStorage.test.ts
```

Expected: current code auto-renews on locked reload, has no shared revision/lock, and allows every tab to perform its own revoke cleanup.

- [ ] **Step 5: Implement the explicit state/view contract and Claim branches**

Keep one non-secret view state:

```js
let state = {
  name: "unpaired",
  busy: false,
  code: null,
  message: null,
  showResume: false,
  showRetry: false,
  cleanupBlocked: false,
  serverLogoutConfirmed: null
};
let retryAction = null;
let activeProductInstallationId = null;

function localEntryError(code, message = "入口状态已经变化，请重试。") {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function stopTrackedWorkbench() {
  activeProductInstallationId = null;
  await workbench.stop();
}

function snapshotLifecycle(record) {
  return {
    revision: record?.revision ?? 0,
    state: record?.state ?? null,
    transitionId: record?.transitionId ?? null
  };
}

function lifecycleMatches(expectedInstallationId, expectedLifecycle) {
  return JSON.stringify(snapshotLifecycle(
    storage.readLifecycle(expectedInstallationId)
  )) === JSON.stringify(expectedLifecycle);
}

async function startWithContext(
  context,
  expectedInstallationId,
  expectedLifecycle
) {
  const assertStartable = () => {
    if (destroyed) {
      throw localEntryError("ENTRY_CONTROLLER_DESTROYED");
    }
    if (storage.readInstallationId() !== expectedInstallationId) {
      throw localEntryError("ENTRY_INSTALLATION_CHANGED");
    }
    if (!lifecycleMatches(
      expectedInstallationId,
      expectedLifecycle
    )) {
      throw localEntryError("ENTRY_LIFECYCLE_CHANGED_DURING_START");
    }
    if (
      storage.readClaimCookieIntent() ||
      storage.readCookieClearPending()
    ) {
      throw localEntryError("ENTRY_COOKIE_CLEAR_PENDING");
    }
    if (
      storage.readCleanupTombstone(expectedInstallationId) ||
      storage.readLifecycle(expectedInstallationId)?.state === "revoked"
    ) {
      throw localEntryError("DEVICE_REVOKED");
    }
    if (
      storage.readLockMarker(expectedInstallationId) ||
      storage.readLifecycle(expectedInstallationId)?.state === "locked"
    ) {
      throw localEntryError("ENTRY_LOCKED_DURING_START");
    }
  };
  try {
    assertStartable();
    const started = await workbench.start(
      context,
      expectedInstallationId,
      assertStartable
    );
    if (!started) return false;
    assertStartable();
    activeProductInstallationId = expectedInstallationId;
    return true;
  } catch (error) {
    await stopTrackedWorkbench();
    if (
      error.code === "ENTRY_LIFECYCLE_CHANGED_DURING_START"
    ) {
      return false;
    }
    throw error;
  }
}

function transition(name, patch = {}, nextRetry = null) {
  if (destroyed) return;
  retryAction = nextRetry;
  state = {
    name,
    busy: false,
    code: null,
    message: null,
    showResume: name === "locked",
    showRetry: name === "recoverable_error" || name === "revoked",
    cleanupBlocked: false,
    serverLogoutConfirmed: null,
    ...patch
  };
  onViewState(structuredClone(state));
}

async function retry() {
  if (typeof retryAction === "function") await retryAction();
}
```

`false` means Product generation arbitration or an exact lifecycle-snapshot
guard superseded this start; every caller returns without an Entry `active`
transition because the newer start/wake owns the final state. Every controller
stop path calls
`stopTrackedWorkbench()` rather than `workbench.stop()` directly. The tracked
installation is an in-memory ownership fact, not persistent state; a revision
fast path is valid only when it still equals the installation being rendered.
Every Context ticket also carries the exact non-secret lifecycle snapshot
(`revision`, `state`, `transitionId`) observed or committed under Entry lock.
`startWithContext()` checks that snapshot before Product requests shared flight,
inside cache-open through the injected guard, and after startup; no caller may
start from a Context fetched before a later Claim/lifecycle transition.

Never put Context, identity refs, pending Claim, Token/Cookie/Credential, or business content into this object. Implement Claim branches:

```js
function persistClaimCookieIntent(expectedInstallationId) {
  const existing = storage.readClaimCookieIntent();
  if (existing) return existing;
  return storage.writeClaimCookieIntent({
    protocolVersion: 2,
    transitionId: uuid(),
    installationId: expectedInstallationId,
    createdAt: now().toISOString()
  });
}

async function retryOriginCookieCleanup(kind, expectedTransitionId) {
  const readRecord = kind === "claim-intent"
    ? () => storage.readClaimCookieIntent()
    : () => storage.readCookieClearPending();
  const clearRecord = kind === "claim-intent"
    ? () => storage.clearClaimCookieIntent(expectedTransitionId)
    : () => storage.clearCookieClearPending(expectedTransitionId);
  if (!mutationLock.available) {
    transition("recoverable_error", {
      code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
      message: "请使用支持 Web Locks 的浏览器完成安全入口清理。",
      showRetry: true
    }, () => retryOriginCookieCleanup(kind, expectedTransitionId));
    return "blocked";
  }
  try {
    const beforeStop = readRecord();
    if (!beforeStop ||
        beforeStop.transitionId !== expectedTransitionId) {
      return "gone";
    }
    await stopTrackedWorkbench();
    let cleared = false;
    await mutationLock.runCookieMutation(async () => {
      const record = readRecord();
      if (!record || record.transitionId !== expectedTransitionId) return;
      await mutationLock.run(record.installationId, async () => {
        await mutationLock.runProductDrain(
          record.installationId,
          async () => {
            const latest = readRecord();
            if (!latest ||
                latest.transitionId !== expectedTransitionId) return;
            await api.clearWebEntryCookies();
            cleared = clearRecord();
          }
        );
      });
    });
    if (cleared) {
      transition("unpaired", { code: "ENTRY_INSTALLATION_CHANGED" });
      return "cleared";
    }
    if (!readRecord()) return "gone";
    transition("recoverable_error", {
      code: "ENTRY_COOKIE_OWNER_CHANGED",
      message: "入口 Cookie 清理所有者已经变化，请重试。",
      showRetry: true
    }, () => retryOriginCookieCleanup(kind, expectedTransitionId));
    return "blocked";
  } catch (cause) {
    const error = localEntryError(
      "REVOKE_COOKIE_CLEAR_FAILED",
      "无法清除已失配的浏览器入口，请重试。"
    );
    error.cause = cause;
    transition("recoverable_error", {
      code: error.code,
      message: error.message,
      showRetry: true
    }, () => retryOriginCookieCleanup(kind, expectedTransitionId));
    return "blocked";
  }
}

async function runCookieAndEntry(expectedInstallationId, operation) {
  if (!mutationLock.available) {
    throw localEntryError("ENTRY_MUTATION_LOCK_UNAVAILABLE");
  }
  return mutationLock.runCookieMutation(
    () => mutationLock.run(expectedInstallationId, operation)
  );
}

async function runCookieEntryAndDrain(
  expectedInstallationId,
  operation
) {
  if (!mutationLock.available) {
    throw localEntryError("ENTRY_MUTATION_LOCK_UNAVAILABLE");
  }
  return mutationLock.runCookieMutation(
    () => mutationLock.run(
      expectedInstallationId,
      () => mutationLock.runProductDrain(
        expectedInstallationId,
        operation
      )
    )
  );
}

async function prepareClaimedActivationLocked(
  context,
  expectedInstallationId,
  activationState
) {
  if (storage.readInstallationId() !== expectedInstallationId) {
    throw localEntryError("ENTRY_INSTALLATION_CHANGED");
  }
  const marker = storage.readLockMarker(expectedInstallationId);
  if (
    JSON.stringify(marker) !==
      JSON.stringify(activationState.expectedMarker)
  ) {
    await stopForLockedState();
    transition("locked", { showResume: true });
    return;
  }
  const lifecycle = storage.readLifecycle(expectedInstallationId);
  if (
    storage.readCleanupTombstone(expectedInstallationId) ||
    lifecycle?.state === "revoked"
  ) {
    throw localEntryError("DEVICE_REVOKED");
  }
  if (activationState.committedLifecycle) {
    if (
      !lifecycleMatches(
        expectedInstallationId,
        activationState.committedLifecycle
      ) ||
      storage.readLockMarker(expectedInstallationId)
    ) {
      throw localEntryError("ENTRY_LIFECYCLE_CHANGED_DURING_START");
    }
    return {
      context,
      expectedInstallationId,
      expectedLifecycle: activationState.committedLifecycle
    };
  }
  const latestTombstone =
    storage.readCleanupTombstone(expectedInstallationId);
  const latestLifecycle =
    storage.readLifecycle(expectedInstallationId);
  if (latestTombstone || latestLifecycle?.state === "revoked") {
    throw localEntryError("DEVICE_REVOKED");
  }
  const latestMarker = storage.readLockMarker(expectedInstallationId);
  if (
    JSON.stringify(latestMarker) !==
      JSON.stringify(activationState.expectedMarker)
  ) {
    await stopForLockedState();
    transition("locked", { showResume: true });
    return false;
  }
  if (
    latestMarker &&
    (
      !storage.clearLockMarker(
        expectedInstallationId,
        latestMarker
      ) ||
      storage.readLockMarker(expectedInstallationId)
    )
  ) {
    await stopForLockedState();
    transition("locked", { showResume: true });
    return false;
  }
  activationState.expectedMarker = null;
  const active = storage.advanceLifecycle(
    expectedInstallationId,
    "active",
    uuid()
  );
  activationState.committedLifecycle = snapshotLifecycle(active);
  publish("session-restored", active, expectedInstallationId);
  if (
    storage.readClaimCookieIntent() ||
    storage.readCookieClearPending()
  ) {
    throw localEntryError("ENTRY_COOKIE_CLEAR_PENDING");
  }
  return {
    context,
    expectedInstallationId,
    expectedLifecycle: activationState.committedLifecycle
  };
}

async function retryCommittedClaim(
  expectedInstallationId,
  activationState
) {
  let activationTicket = null;
  try {
    await stopTrackedWorkbench();
    await runCookieAndEntry(expectedInstallationId, async () => {
      if (storage.readInstallationId() !== expectedInstallationId) {
        throw localEntryError("ENTRY_INSTALLATION_CHANGED");
      }
      if (
        storage.readClaimCookieIntent() ||
        storage.readCookieClearPending()
      ) {
        throw localEntryError("ENTRY_COOKIE_CLEAR_PENDING");
      }
      const response = await api.getWebContext();
      activationTicket = await prepareClaimedActivationLocked(
        response.context,
        expectedInstallationId,
        activationState
      );
    });
    if (activationTicket) {
      const started = await startWithContext(
        activationTicket.context,
        activationTicket.expectedInstallationId,
        activationTicket.expectedLifecycle
      );
      if (started) transition("active");
    }
  } catch (error) {
    await handleCommittedClaimFailure(
      error,
      expectedInstallationId,
      activationState
    );
  }
}

async function handleCommittedClaimFailure(
  error,
  expectedInstallationId,
  activationState
) {
  if (storage.readInstallationId() !== expectedInstallationId) {
    return;
  }
  if (error.code === "ENTRY_COOKIE_CLEAR_PENDING") {
    const intent = storage.readClaimCookieIntent();
    const signal = storage.readCookieClearPending();
    const pending = intent ?? signal;
    if (pending) {
      await retryOriginCookieCleanup(
        intent ? "claim-intent" : "cookie-clear",
        pending.transitionId
      );
    }
    return;
  }
  if (
    error.code === "DEVICE_REVOKED" ||
    error.code === "DEVICE_AUTH_INVALID"
  ) {
    await revoke(error, expectedInstallationId);
    return;
  }
  if (error.code === "ENTRY_LOCKED_DURING_START") {
    await stopForLockedState();
    transition("locked", { showResume: true });
    return;
  }
  if (
    error.code === "ENTRY_SESSION_INVALID" ||
    error.code === "ENTRY_SESSION_EXPIRED"
  ) {
    await recoverAuthenticatedSession(expectedInstallationId);
    return;
  }
  transition("recoverable_error", {
    code: error.code ?? "GATEWAY_UNAVAILABLE",
    message: error.message,
    showRetry: true
  }, () => retryCommittedClaim(
    expectedInstallationId,
    activationState
  ));
}

let activeClaimAbort = null;
let activeClaimPromise = null;

function claim(pendingClaim, activationState) {
  if (activeClaimPromise) return activeClaimPromise;
  const operation = claimOnce(pendingClaim, activationState);
  activeClaimPromise = operation;
  operation.then(
    () => {
      if (activeClaimPromise === operation) activeClaimPromise = null;
    },
    () => {
      if (activeClaimPromise === operation) activeClaimPromise = null;
    }
  );
  return operation;
}

async function claimOnce(
  pendingClaim,
  activationState = {
    expectedMarker: storage.readLockMarker(pendingClaim.installationId)
  }
) {
  const expectedInstallationId = pendingClaim.installationId;
  if (storage.readInstallationId() !== expectedInstallationId) {
    pendingClaims.clear();
    transition("unpaired", { code: "ENTRY_INSTALLATION_CHANGED" });
    return;
  }
  if (!mutationLock.available) {
    transition("recoverable_error", {
      code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
      message: "请使用支持 Web Locks 的浏览器完成安全配对。",
      showRetry: true
    }, () => claim(pendingClaim, activationState));
    return;
  }
  transition("pairing", { busy: true });
  const claimAbort = new AbortControllerClass();
  activeClaimAbort = claimAbort;
  let claimCommitted = false;
  let uncertainIntent = null;
  let activationTicket = null;
  try {
    await stopTrackedWorkbench();
    await runCookieAndEntry(expectedInstallationId, async () => {
      if (storage.readInstallationId() !== expectedInstallationId) {
        throw localEntryError("ENTRY_INSTALLATION_CHANGED");
      }
      if (
        storage.readClaimCookieIntent() ||
        storage.readCookieClearPending()
      ) {
        throw localEntryError("ENTRY_COOKIE_CLEAR_PENDING");
      }
      const intent = persistClaimCookieIntent(expectedInstallationId);
      await mutationLock.runProductDrain(
        expectedInstallationId,
        async () => {
          try {
            await api.claimWebPairing({
              ...pendingClaim,
              device: deviceDescriptor
            }, {
              signal: claimAbort.signal
            });
          } catch (error) {
            if (error.claimOutcome === "rejected") {
              if (!storage.clearClaimCookieIntent(intent.transitionId)) {
                throw localEntryError("ENTRY_CLAIM_INTENT_CHANGED");
              }
            } else {
              uncertainIntent = intent;
            }
            throw error;
          }
          if (!storage.clearClaimCookieIntent(intent.transitionId)) {
            throw localEntryError("ENTRY_CLAIM_INTENT_CHANGED");
          }
          claimCommitted = true;
          pendingClaims.clear();
          const response = await api.getWebContext();
          activationTicket = await prepareClaimedActivationLocked(
            response.context,
            expectedInstallationId,
            activationState
          );
        }
      );
    });
    if (activationTicket) {
      const started = await startWithContext(
        activationTicket.context,
        activationTicket.expectedInstallationId,
        activationTicket.expectedLifecycle
      );
      if (started) transition("active");
    }
  } catch (error) {
    if (destroyed && uncertainIntent) {
      await stopTrackedWorkbench();
      return;
    }
    if (
      uncertainIntent &&
      storage.readClaimCookieIntent()?.transitionId ===
        uncertainIntent.transitionId
    ) {
      await stopTrackedWorkbench();
      await retryOriginCookieCleanup(
        "claim-intent",
        uncertainIntent.transitionId
      );
      if (storage.readClaimCookieIntent()) return;
    }
    if (storage.readInstallationId() !== expectedInstallationId) {
      pendingClaims.clear();
      transition("unpaired", { code: "ENTRY_INSTALLATION_CHANGED" });
      return;
    }
    if (claimCommitted) {
      await handleCommittedClaimFailure(
        error,
        expectedInstallationId,
        activationState
      );
      return;
    }
    if (error.code === "ENTRY_COOKIE_CLEAR_PENDING") {
      const intent = storage.readClaimCookieIntent();
      const signal = storage.readCookieClearPending();
      const pending = intent ?? signal;
      if (pending) {
        await retryOriginCookieCleanup(
          intent ? "claim-intent" : "cookie-clear",
          pending.transitionId
        );
      }
      return;
    }
    if (error.claimOutcome === "unknown") {
      transition("recoverable_error", {
        code: error.code ?? "PAIRING_OUTCOME_UNKNOWN",
        message: "配对结果未确认，浏览器入口已安全清理，请重试。",
        showRetry: true
      }, () => claim(pendingClaim, activationState));
      return;
    }
    if (error.code === "DEVICE_REVOKED") {
      pendingClaims.clear();
      await revoke(error, expectedInstallationId);
      return;
    }
    if (pendingClaims.isTerminalError(error)) {
      pendingClaims.clear();
      transition("unpaired", {
        code: error.code,
        message: error.message
      });
      return;
    }
    if (!pendingClaims.shouldRetain(error)) {
      pendingClaims.clear();
      transition("unpaired", {
        code: error.code ?? "PAIRING_FAILED",
        message: error.message
      });
      return;
    }
    transition("recoverable_error", {
      code: error.code ?? "GATEWAY_UNAVAILABLE",
      message: error.message,
      showRetry: true
    }, () => claim(pendingClaim, activationState));
  } finally {
    if (activeClaimAbort === claimAbort) {
      activeClaimAbort = null;
    }
  }
}
```

`runCookieAndEntry()` is deliberately limited to source-bound Context
validation and the outer portion of Claim before its explicit drain. It may
not renew, install a positive Session, clear an owner, rotate or activate
Product. A Context invalid/revoked result is still serialized against every
Claim by the origin-global Cookie lock; the controller then writes its own
marker, stops/drains Product and performs recovery or cleanup through
`runCookieEntryAndDrain()`. This restriction avoids taking exclusive flight
for harmless active-state revalidation without reopening the old-response
Cookie race.

`api.claimWebPairing()` resolves only for an exact bodyless `204`. A parsed
non-2xx v2 error sets the non-enumerable diagnostic
`error.claimOutcome = "rejected"`; the server contract guarantees that branch
did not install authentication Cookies, so the exact intent can be removed.
Transport failure, abort, malformed response, or any unexpected 2xx status
sets `"unknown"` and retains the intent. The client uses
`keepalive: false` plus a controller-owned AbortSignal; page destruction
aborts the request, while the durable intent survives. Pending pairing
material is cleared only after the `204`; an uncertain outcome first clears
Cookies under Cookie→Entry→exclusive Product-flight, then retains the pending Claim for the bounded
idempotent retry.

Claim first drains its own Product, then holds Cookie→Entry, persists the
intent to wake peers, and waits for exclusive Product-flight before sending
any request. It keeps all three through the complete `204` decision, exact
intent clear, Context re-fetch and authoritative lifecycle preparation.
Every committed Claim advances and publishes one new `active` lifecycle
revision even when the prior record was already active. This durable revision
is the cross-tab startup epoch: any pre-Claim Context ticket fails its exact
lifecycle guard before Product/cache work. `activationState.committedLifecycle`
memoizes that one persisted snapshot, so `retryCommittedClaim()` retries only
Context/local activation and neither advances a second revision nor consumes
another Claim replay.
`prepareClaimedActivationLocked()` never starts Product. Claim releases
exclusive flight, Entry and Cookie first; only then does
`startWithContext()` acquire a new shared Product-flight and cache-open. Its
source-bound pre/post guards fail closed if Revoke wins that deliberate
handoff gap.
Every Revoke/rotation path must inspect and finish any origin-global intent or
clear signal while it owns the same outer Cookie lock, before it may clear
Cookies or rotate. Thus a Claim intent exists before any possible Cookie
commit and cannot first appear after an I1→I2 rotation.

Define the authenticated ProductWorkbench callback as an awaited, non-rejecting
controller boundary:

```js
async function handleEntryFailure(error, expectedInstallationId) {
  const invalidating =
    error.code === "DEVICE_REVOKED" ||
    error.code === "DEVICE_AUTH_INVALID";
  const recoverableSession =
    error.code === "ENTRY_SESSION_INVALID" ||
    error.code === "ENTRY_SESSION_EXPIRED";
  if (!invalidating && !recoverableSession) return false;
  if (
    destroyed ||
    storage.readInstallationId() !== expectedInstallationId
  ) {
    return true;
  }
  try {
    if (invalidating) {
      await revoke(error, expectedInstallationId);
    } else {
      await recoverAuthenticatedSession(expectedInstallationId);
    }
  } catch (recoveryError) {
    try {
      await stopTrackedWorkbench();
    } catch {
      // The original recovery failure remains the visible cause.
    }
    const retryAction = () => {
      const tombstone =
        storage.readCleanupTombstone(expectedInstallationId);
      const lifecycle =
        storage.readLifecycle(expectedInstallationId);
      if (tombstone || lifecycle?.state === "revoked") {
        return retryCleanup(expectedInstallationId);
      }
      return invalidating
        ? revoke(error, expectedInstallationId)
        : recoverAuthenticatedSession(expectedInstallationId);
    };
    transition("recoverable_error", {
      code: recoveryError.code ?? "GATEWAY_UNAVAILABLE",
      message: recoveryError.message,
      showRetry: true
    }, retryAction);
  }
  return true;
}
```

This exact `Promise<boolean>` resolves only after stop/cleanup and the final
controller state are stable. Cleanup errors are represented by controller
state and retry ownership; they never escape as an unhandled rejection from a
BroadcastChannel, storage listener, Renderer callback, or Sync callback.
`expectedInstallationId` is mandatory and comes from the operation that
originated the error. A stale error whose source no longer equals the current
installation resolves as handled without mutating Cookies, lifecycle,
pointer, cache, or installation; the handler never re-samples a new target.

`bootstrap()` uses this decision order:

1. origin-global `claim-cookie-intent` or `cookie-clear-pending` → stop
   Product and retry only the exact owner’s Cookie cleanup under
   Cookie→source-Entry before legacy deletion, pending Claim, Context or
   cache; if another owner already removed it, restart this decision from
   current storage instead of rendering unpaired; without Web Locks retain
   the record and send zero clear requests;
2. valid old/current tombstone, or current-ID `revoked` lifecycle with no
   tombstone and no identity pointer → `revoked` and
   `retryCleanup(expectedInstallationId)`;
3. legacy delete failure → `recoverable_error`, no fetch/cache open;
4. scrubbed fragment error → `unpaired` with non-reflective error;
5. pending Claim → `claim(pendingClaim)`;
6. marker or shared locked/revoked record → `locked`/`revoked`, no Context/renew;
7. Context success → start workbench and `active`;
8. Context `DEVICE_REVOKED` or active Cookie `DEVICE_AUTH_INVALID` →
   `revoke(error, expectedInstallationId)`;
9. Context 401 without marker → locked recovery helper;
10. retryable/network error → `recoverable_error`;
11. other permission error → `unpaired`.

Each recoverable branch assigns `retryAction` to the exact operation that
failed: `bootstrap`, `claim`, `logout`, `removeDevice`, or `retryCleanup`;
success/terminal branches clear it. `handleEntryFailure()` is an
already-authenticated ProductWorkbench path: both `DEVICE_REVOKED` and
`DEVICE_AUTH_INVALID` call `revoke(error, expectedInstallationId)`.
`claim()` distinguishes where the
error occurred: a `DEVICE_AUTH_INVALID` response from the Claim request itself
is terminal and returns unpaired; after Claim has committed, the same code
from ProductWorkbench startup is an active-Cookie failure and enters cleanup.
After Claim success, local/cache/render failure assigns
`retryCommittedClaim`: it re-fetches Context and retries local activation, and
must never call Claim again.
The handler always stops the workbench before
locked/revoked/recoverable states and returns `true` for handled Entry errors,
`false` for non-Entry product errors.

- [ ] **Step 6: Implement Channel/storage receivers, revision filtering and destruction**

At controller construction:

```js
const channel = typeof BroadcastChannelClass === "function"
  ? new BroadcastChannelClass("family-ai-member-entry-lifecycle")
  : null;
let destroyed = false;
const initialInstallationId = storage.readInstallationId();
const lastAppliedRevisions = new Map([
  [
    initialInstallationId,
    storage.readLifecycle(initialInstallationId)?.revision ?? 0
  ]
]);

function publish(type, lifecycle, installationId) {
  channel?.postMessage({
    protocolVersion: 2,
    type,
    installationId,
    transitionId: lifecycle.transitionId,
    revision: lifecycle.revision,
    occurredAt: now().toISOString()
  });
}
```

Every publish call passes the operation’s captured installation ID; there is no
“read whatever is current now” default. BroadcastChannel and `storage` events
feed the same serial receiver lane:

```js
let receiverLane = Promise.resolve();

async function handleReceiverFailure(error, expectedInstallationId) {
  if (await handleEntryFailure(error, expectedInstallationId)) return;
  if (storage.readInstallationId() !== expectedInstallationId) return;
  await stopTrackedWorkbench();
  transition("recoverable_error", {
    code: error.code ?? "GATEWAY_UNAVAILABLE",
    message: error.message,
    showRetry: true
  }, () => applyLatestInstallationState(expectedInstallationId));
}

function enqueueReceiver(expectedInstallationId, operation) {
  receiverLane = receiverLane
    .then(() => destroyed ? undefined : operation())
    .catch((error) =>
      destroyed
        ? undefined
        : handleReceiverFailure(error, expectedInstallationId)
    );
  return receiverLane;
}

channel?.addEventListener("message", (event) => {
  const message = event.data;
  if (!validLifecycleWake(message)) return;
  void enqueueReceiver(
    message.installationId,
    () => applyLatestInstallationState(message.installationId)
  );
});

eventTarget.addEventListener("storage", (event) => {
  if (
    event.key === CLAIM_COOKIE_INTENT_KEY ||
    event.key === COOKIE_CLEAR_PENDING_KEY
  ) {
    const wake = storage.readCookieOwnerWakeFromEvent(event);
    if (!wake) return;
    const sourceId = wake.owner.installationId;
    void enqueueReceiver(sourceId, async () => {
      const intent = storage.readClaimCookieIntent();
      const signal = storage.readCookieClearPending();
      const pending = intent ?? signal;
      if (pending) {
        const result = await retryOriginCookieCleanup(
          intent ? "claim-intent" : "cookie-clear",
          pending.transitionId
        );
        if (result === "gone" && !destroyed) {
          if (wake.kind === "set") {
            await stopTrackedWorkbench();
          }
          if (mutationLock.available) {
            await mutationLock.runCookieMutation(async () => {});
          }
          await applyLatestInstallationState(
            storage.readInstallationId(),
            { forceRefresh: wake.kind === "set" }
          );
        }
      } else if (!destroyed) {
        if (wake.kind === "set") {
          await stopTrackedWorkbench();
        }
        if (mutationLock.available) {
          await mutationLock.runCookieMutation(async () => {});
        }
        await applyLatestInstallationState(
          storage.readInstallationId(),
          { forceRefresh: wake.kind === "set" }
        );
      }
    });
    return;
  }
  const affectedInstallationId = installationIdForStorageKey(event.key);
  if (!affectedInstallationId && event.key !== INSTALLATION_KEY) return;
  const sourceId = affectedInstallationId ?? initialInstallationId;
  void enqueueReceiver(
    sourceId,
    () => applyLatestInstallationState(sourceId)
  );
});
```

`readCookieOwnerWakeFromEvent()` strictly parses only the non-secret owner
shape. A valid `newValue` returns `{ kind: "set", owner }`; only
`newValue === null` with a valid `oldValue` returns
`{ kind: "clear", owner }`; invalid JSON/update shapes return null. The
receiver preserves that event kind even though it re-reads live storage when
its lane turn begins. A set wake always invalidates/stops any active or
in-flight Product generation, even if the owner was already cleared before
this turn. It then crosses the global Cookie-lock completion barrier and
forces current-state reconciliation. A clear wake never stops Product; it is
only the barrier plus normal reconciliation. A live owner still uses
`retryOriginCookieCleanup()` and exclusive Product-flight.

`applyLatestInstallationState(id)` loops until the record it is about to render
is still the newest record after every await:

```js
async function applyLatestInstallationState(
  installationId,
  { forceRefresh = false } = {}
) {
  for (;;) {
    const lifecycle = storage.readLifecycle(installationId);
    const revision = lifecycle?.revision ?? 0;
    const expectedLifecycle = snapshotLifecycle(lifecycle);
    const lastApplied = lastAppliedRevisions.get(installationId) ?? 0;
    const marker = storage.readLockMarker(installationId);
    const tombstone = storage.readCleanupTombstone(installationId);
    const intent = storage.readClaimCookieIntent();
    const cookieSignal = storage.readCookieClearPending();

    if (intent || cookieSignal) {
      const pending = intent ?? cookieSignal;
      const result = await retryOriginCookieCleanup(
        intent ? "claim-intent" : "cookie-clear",
        pending.transitionId
      );
      if (result === "gone") continue;
      return;
    }
    if (storage.readInstallationId() !== installationId && !tombstone) {
      await stopTrackedWorkbench();
      if (destroyed) return;
      transition("unpaired");
      return;
    }
    if (tombstone || lifecycle?.state === "revoked") {
      await stopTrackedWorkbench();
      if (destroyed) return;
      if (
        JSON.stringify(storage.readCleanupTombstone(installationId)) !==
          JSON.stringify(tombstone) ||
        storage.readLifecycle(installationId)?.revision !== revision
      ) continue;
      lastAppliedRevisions.set(installationId, revision);
      transition("revoked", { showRetry: true });
      return;
    }
    if (
      !forceRefresh &&
      revision <= lastApplied &&
      !marker &&
      activeProductInstallationId === installationId
    ) return;
    if (marker || lifecycle?.state === "locked") {
      await stopForLockedState();
      if (destroyed) return;
      if (
        JSON.stringify(storage.readLockMarker(installationId)) !==
          JSON.stringify(marker) ||
        storage.readLifecycle(installationId)?.revision !== revision
      ) continue;
      lastAppliedRevisions.set(installationId, revision);
      transition("locked", { showResume: true });
      return;
    }
    if (lifecycle?.state === "active") {
      let contextTicket = null;
      const result = await runCookieAndEntry(
        installationId,
        async () => {
          if (
            storage.readInstallationId() !== installationId ||
            !lifecycleMatches(installationId, expectedLifecycle) ||
            storage.readLockMarker(installationId) ||
            storage.readCleanupTombstone(installationId) ||
            storage.readClaimCookieIntent() ||
            storage.readCookieClearPending()
          ) return "retry";
          const response = await api.getWebContext();
          if (destroyed) {
            await stopTrackedWorkbench();
            return "handled";
          }
          if (
            storage.readInstallationId() !== installationId ||
            !lifecycleMatches(installationId, expectedLifecycle) ||
            storage.readLockMarker(installationId) ||
            storage.readCleanupTombstone(installationId)
          ) {
            return "retry";
          }
          contextTicket = {
            context: response.context,
            installationId,
            expectedLifecycle
          };
          return "active";
        }
      );
      if (result === "retry") continue;
      if (result !== "active") return;
      const started = await startWithContext(
        contextTicket.context,
        contextTicket.installationId,
        contextTicket.expectedLifecycle
      );
      if (!started) return;
      if (
        storage.readInstallationId() !== installationId ||
        !lifecycleMatches(installationId, expectedLifecycle) ||
        storage.readLockMarker(installationId) ||
        storage.readCleanupTombstone(installationId)
      ) {
        await stopTrackedWorkbench();
        continue;
      }
      lastAppliedRevisions.set(installationId, revision);
      transition("active");
      return;
    }
    return;
  }
}
```

The message is only a wakeup. State comes from the latest lifecycle record plus
tombstone/current-installation records; stale `message.type`, `revision`, or
`transitionId` never overrides newer storage. `lastAppliedRevisions` is updated
only after the exact revision survives the post-await recheck. The storage
listener handles:

- the exact old-installation lock key → stop and locked;
- tombstone creation/update → stop and revoked;
- the global installation key changing away from this tab’s old ID → stop and unpaired;
- old tombstone removal after installation changed → stop and unpaired.

These storage wakes never renew, delete, rotate, or advance a revision. They
make completion independent of delivery of the final Broadcast. Active-state
Context failure is awaited through
`handleReceiverFailure(error, expectedInstallationId)`. Entry failures use
the source-bound authenticated handler; a current retryable/non-Entry failure
stops and enters recoverable state, while a stale source is ignored. It never
auto-renews when a marker still exists. The handler catches its own cleanup
failure, moves the controller into the corresponding recoverable state, and
resolves only after that state is stable; it does not leak a rejected Promise.
Because the
receiver lane returns this Promise, no later wake and no `whenIdle()` result
can overtake revoke/lock cleanup. The controller exposes a test-only
`whenIdle()` seam that returns `receiverLane`, allowing the deferred rev1→rev2
race and deferred Entry cleanup to be asserted without timers.

`retryCleanup(expectedInstallationId)` re-reads the tombstone, returns to
`unpaired` if another
leader already completed, or invokes the same
Cookie→Entry→exclusive Product-flight→cache-open protected cleanup routine.
`retry()` executes only the controller-owned `retryAction`; the DOM adapter
never guesses recovery semantics. `destroy()` sets `destroyed` synchronously,
aborts `activeClaimAbort`, removes the storage listener, nulls Channel
handlers, closes the Channel exactly once, awaits the in-flight Claim
settlement plus `stopTrackedWorkbench()`, and returns that Promise. An aborted
uncertain Claim deliberately leaves its already-durable intent for a live
peer/cold-start owner; destruction never attempts a last-moment Cookie clear.
Every
in-flight receiver checks `destroyed` after each await, while
`startWithContext` checks it both before and after start; neither can render
after destruction. Logout only stops the workbench and intentionally leaves
the controller/Channel alive.

- [ ] **Step 7: Implement fail-closed bootstrap and Logout**

`bootstrap()` first checks the origin-global Claim intent and Cookie-clear
signal and retries only the exact owner’s cleanup. If neither exists, it scans
valid cleanup tombstones and
resumes revoke cleanup. If none exist, it also checks whether the current installation has a
`revoked` lifecycle but no pointer—the no-identity crash signal—and resumes
Cookie clear/rotation before legacy deletion, pending Claim, Context, renew,
or cache work. If neither signal remains, it calls
`cacheLifecycle.deleteLegacy()`; a blocked/error result enters
`recoverable_error` and retry re-enters the same bootstrap without opening an
identity cache. Only then does it capture the current installation ID, check
that ID’s marker plus stored `locked`/`revoked` lifecycle, and run the Context
request plus exact post-response lifecycle recheck under Cookie→Entry. It
returns `{ context, installationId, expectedLifecycle }`, releases those
locks, and calls `startWithContext()` with all three fields. `logout()`
executes this order:

```js
const installationId = storage.readInstallationId();
storage.writeLockMarker(installationId);
await stopForLockedState();

const transitionId = uuid();
const performLogout = async () => {
  const lifecycle = storage.advanceLifecycle(
    installationId,
    "locked",
    transitionId
  );
  publish("session-locked", lifecycle, installationId);
  try {
    await api.logoutWebSession();
  } catch (error) {
    showLocked({ serverLogoutConfirmed: false, error });
  }
};

if (mutationLock.available) {
  await runCookieEntryAndDrain(installationId, performLogout);
} else {
  try {
    await api.logoutWebSession();
    showLocked({ serverLogoutConfirmed: true });
  } catch (error) {
    showLocked({ serverLogoutConfirmed: false, error });
  }
}
```

The supported path has already stopped the local Product and uses the marker
storage wake to stop peers, then holds Cookie→Entry→exclusive Product-flight
around the authoritative lifecycle write and exact Session Logout response.
The no-lock exception applies only
to immediate fail-closed Logout and its exact server request. Because Pair
and Resume send no requests without Web Locks, this response cannot race a
new Session. The fallback does not call `advanceLifecycle()` or publish a
revision-bearing message. Resume and cleanup never bypass the lock.

- [ ] **Step 8: Implement explicit Resume with a Context recheck**

Fail before Context when Web Locks are unavailable. Otherwise first
`await stopTrackedWorkbench()`, then execute the entire
Context→optional renew→Context→authoritative lifecycle sequence inside
`runCookieEntryAndDrain(installationId, ...)`. The existing Logout marker
wakes peers before the exclusive barrier. Return a start ticket, release all
three locks, and only then acquire Product shared flight:

```js
const installationId = storage.readInstallationId();
const sharedLifecycle = snapshotLifecycle(
  storage.readLifecycle(installationId)
);
const sharedMarker = storage.readLockMarker(installationId);
let context;
let renewed = false;
let activationTicket = null;
try {
  context = await api.getWebContext();
} catch (error) {
  if (error.code !== "ENTRY_SESSION_INVALID" &&
      error.code !== "ENTRY_SESSION_EXPIRED") throw error;
  await api.renewWebSession();
  renewed = true;
  context = await api.getWebContext();
}

const currentInstallationId = storage.readInstallationId();
const latestLifecycle = storage.readLifecycle(installationId);
const latestMarker = storage.readLockMarker(installationId);
const latestTombstone = storage.readCleanupTombstone(installationId);
if (
  currentInstallationId !== installationId ||
  latestTombstone ||
  latestLifecycle?.state === "revoked"
) {
  await stopTrackedWorkbench();
  return;
}
if (
  JSON.stringify(latestMarker) !== JSON.stringify(sharedMarker) ||
  !lifecycleMatches(installationId, sharedLifecycle)
) {
  await stopForLockedState();
  transition("locked", { showResume: true });
  return;
}

if (!latestMarker && latestLifecycle?.state === "active" && !renewed) {
  activationTicket = {
    context,
    installationId,
    expectedLifecycle: snapshotLifecycle(latestLifecycle)
  };
  return;
}

if (!latestMarker) {
  await stopForLockedState();
  transition("locked", { showResume: true });
  return;
}
if (
  !storage.clearLockMarker(installationId, latestMarker) ||
  storage.readLockMarker(installationId)
) {
  await stopForLockedState();
  transition("locked", { showResume: true });
  return;
}
const lifecycle = storage.advanceLifecycle(
  installationId,
  "active",
  transitionId
);
publish("session-restored", lifecycle, installationId);
activationTicket = {
  context,
  installationId,
  expectedLifecycle: snapshotLifecycle(lifecycle)
};
```

After `runCookieEntryAndDrain()` returns, call
`startWithContext(context, installationId, expectedLifecycle)` with the three
ticket fields
outside every lifecycle lock; transition active only on `true`. The Product's
first shared-flight guard catches any Revoke that wins this handoff gap.

Any failure before the marker is cleared returns to locked and does not start
the workbench. Logout deliberately writes its marker before it waits for the
mutation lock, so Resume must re-read installation, lifecycle, marker and
tombstone after the last Context/renew await and immediately before clearing
anything. A newer or removed marker, changed lifecycle revision, rotated
installation, or tombstone makes Resume fail closed; it never clears the
newer Logout marker or publishes active. The expected-marker clear must also
succeed and be followed by a null re-read before advancing lifecycle.
The second simultaneous Resume holder therefore starts only its own tab from fresh Context; it does not renew, advance the shared revision or publish another restore.
If Context, renew, or Product startup returns `DEVICE_REVOKED` or active
`DEVICE_AUTH_INVALID`, Resume calls
`revoke(error, installationId)` and must not fall through
to locked/retry or transition active. `ENTRY_LOCKED_DURING_START` stops and
returns to the existing locked view.

Name the shared helper
`recoverAuthenticatedSession(expectedInstallationId)`. For a runtime
`ENTRY_SESSION_INVALID` or `ENTRY_SESSION_EXPIRED`, capture the installation
ID before the first await. If no marker exists, write and retain one exact
monotonic recovery marker, stop the local Product, let its storage wake stop
peers, then run Context→renew→Context→active lifecycle under
Cookie→Entry→exclusive Product-flight. Release every lock before passing the
ticket—including the exact newly persisted active lifecycle snapshot—to
`startWithContext`. If a marker already exists, remain locked and wait for
explicit Resume; never adopt it as the recovery helper's owner.
Resume itself
uses the same helper with an `explicit = true` branch that is allowed to clear
the marker after successful Context. Claim uses
`pendingClaim.installationId`; active wakes use the validated wake
installation; bootstrap and every retry capture their ID before the first
await. No caller may omit any of the three `startWithContext` arguments.
Retryable
network/5xx errors enter `recoverable_error` without deleting identity or
renewing. No lifecycle-owned Context, renew, Claim, Logout, Device DELETE or
Cookie-clear request may execute outside the global Cookie lane; helpers that
already own Cookie→Entry call explicit `...Locked` variants and never
reacquire either lock.

- [ ] **Step 9: Implement two-phase Revoke cleanup**

Use one unified branch whether or not an identity pointer exists:

1. Receive a mandatory source `expectedInstallationId`. Before any write,
   re-read current installation and that old ID’s tombstone. If current is
   different and no tombstone exists, this is a stale delayed callback:
   return without even recreating a marker/tombstone.
2. Write only a fresh monotonic lock marker outside Web Locks, then stop/hide
   the local workbench and await its generation drain. The marker’s storage
   event gives peers the immediate fail-closed signal; supported browsers do
   **not** create or replace a cleanup tombstone outside the mutation lock.
3. If Web Locks are unavailable, create the null-identity closing tombstone
   only when current still equals expected, no tombstone exists, and no
   origin-global Claim intent/Cookie-clear signal exists; otherwise preserve
   every existing owner byte-for-byte. Show the
   supported-browser cleanup instruction and do not clear Cookies, delete,
   rotate, write lifecycle, or publish.
4. Acquire the origin-global Cookie mutation lock. Before acquiring the
   Revoke target’s Entry lock, re-read any Claim intent/Cookie-clear signal.
   If one exists, acquire only that record’s source Entry lock, re-read its
   exact owner, acquire that source installation’s exclusive Product-flight
   barrier, clear all Cookies once, clear that owner by transition ID, then
   release flight and source Entry. A failure retains the record and blocks
   Revoke/rotation. Never hold two Entry locks at once.
5. Still holding the Cookie lock, acquire the old installation’s Entry
   mutation lock and re-read current, lifecycle and tombstone. If current
   differs and no tombstone exists, exit stale. If current differs while the
   old tombstone says
   `cookiesCleared: false`, fail closed with
   `ENTRY_TOMBSTONE_INCONSISTENT`; never clear origin-global Cookies.
6. When current still equals expected and no tombstone exists, create exactly
   one owner record
   `{ phase: "closing", identity: null, cookiesCleared: false }`. If a record
   already exists, reuse its transition ID and monotonic fields; never write a
   fresh false/closing value over it.
7. Write the authoritative `revoked` lifecycle and publish
   `device-revoke-preparing` with the captured old installation ID.
8. Still holding Cookie→Entry, acquire exclusive
   `family-ai-member-product-flight:${expectedInstallationId}`. The marker
   wake plus the leader's prior local stop guarantees every shared Product
   lease eventually releases; entry into this callback is the proof that all
   tabs closed Sync and drained Cookie-bearing Product requests.
9. Still holding Cookie→Entry→exclusive Product-flight, acquire
   `family-ai-member-cache-open:${expectedInstallationId}` and keep it through
   pointer selection, optional delete, rotation and tombstone removal. This
   fixed Cookie→Entry→Product-flight→cache-open order is the linearization
   boundary with Claim/Cookie cleanup, late Product responses and Product
   open/validate/pointer publication.
10. If step 4 already cleared Cookies, durably advance the Revoke owner to
   `cookiesCleared: true` without a second request. Otherwise, when current
   still equals expected and the tombstone has `cookiesCleared: false`, call
   `clearCookiesForRevoke()` and durably advance the same owner to true before
   delete/rotation. If already true, skip Cookie clear. A rotated old
   tombstone may proceed only when this bit is already true.
11. Re-read the pointer under all four locks. While one exists, advance the same
   tombstone to
   `{ phase: "deleting", identity, cookiesCleared: true }`, await
   `cacheLifecycle.deleteIdentity(identity, { onBlocked })`, and clear only
   that exact unchanged pointer. Re-read until null.
12. If current still equals expected, clear the lock marker and rotate the old
    installation exactly once; if already rotated, never rotate again.
13. While still holding cache-open ownership, assert the old pointer remains
    null, clear only this tombstone owner, advance the old `revoked` lifecycle
    once more, and publish `device-revoke-complete`.
14. Release cache-open, exclusive Product-flight, Entry mutation, then Cookie
    mutation. Any delayed
    second Revoke or new Claim can acquire only afterward; the Revoke observes
    the rotated installation and absent tombstone and exits stale, while the
    Claim observes no old origin-global Cookie owner. Neither can regress
    `cookiesCleared`, rebuild an old cleanup record, or deliver a late clear
    response over a new Session.

Wrap Cookie clearing at the boundary:

```js
async function clearCookiesForRevoke() {
  try {
    await api.clearWebEntryCookies();
  } catch (cause) {
    const error = localEntryError(
      "REVOKE_COOKIE_CLEAR_FAILED",
      "无法清除浏览器入口，请重试。"
    );
    error.cause = cause;
    throw error;
  }
}
```

If steps 10–13 fail, keep the monotonic tombstone and revoked state. Before
rotation, also keep pointer and old installation. After rotation, keep the old
tombstone so bootstrap blocks the new installation; Retry skips Cookie clear,
deletes only the old target if needed, and must not rotate again.
Preserve `REVOKE_COOKIE_CLEAR_FAILED` and
`MEMBER_CACHE_DELETE_FAILED` as the visible retry code; do not collapse either
to a generic network error.
The complete message targets the old installation ID so every old tab wakes, then each tab reads the one current installation ID from storage.
The closing tombstone is also the no-identity crash-recovery signal. On cold
start/retry, `retryCleanup(expectedInstallationId)` resumes the same in-lock
pointer re-read, Cookie clear and optional delete before rotation. Keep the
older “revoked lifecycle + no tombstone + no pointer” recovery only as a
defensive compatibility branch for a crash from an earlier implementation.

Implement `finishOriginCookieOwnerLocked()` as the Cookie-lock-only prelude:
it reads the one global intent/signal, acquires that owner's source Entry and
exclusive Product-flight, clears Cookies/CASes the owner once, records
`cookiesAlreadyCleared = true`, then releases both source locks. It must run
before any target Entry lock is acquired, so source and target Entry locks are
never nested.

Implement
`revokeLocked(error, expectedInstallationId, { cookiesAlreadyCleared })` as
the common body that assumes
Cookie→target-Entry→target-exclusive-Product-flight and acquires only
cache-open; it never reacquires an outer lock or stops Product. If the prelude
already cleared Cookies, this helper durably copies that fact into the target
tombstone before delete/rotation and sends no second clear request.
`revoke()` writes the marker, awaits `stopTrackedWorkbench()`, then uses this
shape:

```js
await mutationLock.runCookieMutation(async () => {
  const cookiesAlreadyCleared =
    await finishOriginCookieOwnerLocked();
  await mutationLock.run(expectedInstallationId, () =>
    mutationLock.runProductDrain(
      expectedInstallationId,
      () => revokeLocked(error, expectedInstallationId, {
        cookiesAlreadyCleared
      })
    )
  );
});
```

`removeDevice()` captures its installation, writes the normal lock marker and
awaits local stop while peers drain from the marker wake. The supported path
first runs the same Cookie-lock prelude, then holds
Cookie→target-Entry→target-exclusive-Product-flight while sending
`api.revokeWebDevice()`. On success or an authoritative `DEVICE_REVOKED`
response, it directly invokes `revokeLocked()` with the prelude checkpoint in
that same target-lock callback, creates/reuses the tombstone, and completes
cache cleanup/rotation before releasing any outer lock. On network/timeout it
releases without a tombstone, stays locked, keeps the old installation/cache
pointer, and offers the same DELETE retry. There is no DELETE→Revoke
reacquisition gap, and a queued Claim cannot adopt the marker or send until
rotation has completed.
Authenticated Context/Chat/Work/Sync paths do the same with their captured
source; `revoke` never samples a replacement target. `claim()` checks
`DEVICE_REVOKED` before the generic terminal-pairing branch and passes
`pendingClaim.installationId`.

- [ ] **Step 10: Run lifecycle, cache and route regressions**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberEntryLifecycle.test.ts \
  test/memberEntryStorage.test.ts \
  test/memberIdentityCache.test.ts \
  test/webEntryRoutes.test.ts
```

Expected: PASS for fail-closed reload, one renew, exact Session Logout, one revoke leader, blocked cleanup and monotonic message handling.

- [ ] **Step 11: Commit**

```bash
git add \
  apps/gateway/member-public/entry-lifecycle.js \
  apps/gateway/test/helpers/memberBrowserHarness.ts \
  apps/gateway/test/memberEntryLifecycle.test.ts
git commit -m "fix(member): make entry lifecycle deterministic"
```

---

### Task 13: Integrate identity cache, Entry controller and Sync revoke

**Files:**
- Create: `apps/gateway/test/memberProductWorkbenchLifecycle.test.ts`
- Modify: `apps/gateway/member-public/cache.js`
- Modify: `apps/gateway/member-public/product.js:240-445`
- Modify: `apps/gateway/member-public/entry.js:1-305`
- Modify: `apps/gateway/member-public/sync.js:65-281`
- Modify: `apps/gateway/member-public/api.js`
- Modify: `apps/gateway/member-public/index.html`
- Modify: `apps/gateway/src/memberWeb.ts:43-60`
- Modify: `apps/gateway/test/memberSyncAuth.test.ts`
- Modify: `apps/gateway/test/memberApiStore.test.ts`
- Modify: `apps/gateway/test/memberCacheModel.test.ts`
- Modify: `apps/gateway/test/memberWebModules.test.ts`
- Modify: `apps/gateway/test/memberPersistenceReview.test.ts`

**Interfaces:**
- Changes ProductWorkbench entry to:

```js
startProductWorkbench(context, options = {})
```

with optional `openCache`, `rendererFactory`, `syncFactory`, `globalTarget`,
`acquireProductFlight`, `withIdentityOpenLock`, `assertEntryStartable`,
`onCacheValidated`, `onEntryInvalid`, `onEntryRevoked`, and
`AbortControllerClass` seams in addition to the current `fetchImpl`, `now`,
`uuid`, `timeZone`, `EventSourceClass`, and `BroadcastChannelClass` options.
It resolves the owned workbench for the winning generation and resolves
`null` when a newer start or explicit stop supersedes it.

- Adds to Sync input:

```js
onEntryRevoked: () => undefined
```

- [ ] **Step 1: Write failing ProductWorkbench ordering tests**

```ts
import {
  fakeIdentityCache,
  fakeRenderer,
  fakeSync,
  memberContextFixture,
  memberProductFetchFixture
} from "./helpers/memberBrowserHarness.js";

it("validates identity before reading or rendering projections", async () => {
  const calls: string[] = [];
  const contextA = memberContextFixture();
  const identityA = {
    familyRef: contextA.family.familyRef,
    personRef: contextA.person.personRef,
    deviceRef: contextA.device.deviceRef
  };
  const cache = fakeIdentityCache({ calls });

  await startProductWorkbench(contextA, {
    fetchImpl: memberProductFetchFixture(calls),
    timeZone: "UTC",
    openCache: async () => {
      calls.push("validate");
      return { cache, identity: identityA };
    },
    rendererFactory: () => {
      calls.push("renderer");
      return fakeRenderer();
    },
    syncFactory: () => fakeSync(calls),
    onCacheValidated: () => calls.push("pointer")
  });

  expect(calls.indexOf("validate")).toBeLessThan(calls.indexOf("pointer"));
  expect(calls.indexOf("pointer")).toBeLessThan(calls.indexOf("snapshot"));
  expect(calls.indexOf("pointer")).toBeLessThan(calls.indexOf("renderer"));
  expect(calls).toContain("chat:init");
  expect(calls).toContain("work:init");
  expect(calls.indexOf("chat:init")).toBeLessThan(calls.indexOf("sync:start"));
  expect(calls.indexOf("work:init")).toBeLessThan(calls.indexOf("sync:start"));
});
```

Add Context-identity/installation and origin-global Cookie-owner mismatch
behavior: reject before snapshot, renderer, Sync, identity pointer or ACK.
Do not apply this no-pointer expectation to generation/marker/tombstone
supersession after a successful validation; those cases must publish the
cleanup locator. Add start/stop/start behavior proving the first cache
connection and Renderer are closed before the second starts.
Add two truly concurrent starts: defer the first during cache open and during
Chat/Work initialization, request the second before releasing it, then assert
the first resolves `null` as superseded, every first-generation
cache/Renderer/Sync/listener closes exactly once, and only the second
generation remains in `activeWorkbench`. An Entry-controller integration test
asserts the superseded caller receives `false` and never performs a late
`active` transition. When the deferred cache open has already validated an
identity, the superseded generation must still publish that cleanup locator
under cache-open before its trailing ownership guard returns `null`; the next
generation may safely replace it only after the first releases the lock.
For both deferred phases, call `stopProductWorkbench()` and assert its Promise
does not resolve until the in-flight generation has observed invalidation and
disposed; two concurrent stop calls must await the same memoized disposal and
neither may resolve before shared-flight release. Only after that Promise
resolves may a Revoke delete begin.
Add regressions proving Chat and Work initialize exactly once before awaited Sync start, a saved valid Work/section is reopened, a missing saved Work falls back to Chat and persists that fallback, and `EventSourceClass`, `BroadcastChannelClass`, `onError`, and `onCacheUpdated` reach the Sync factory.
Add a runtime action regression where `openWork()` rejects with a non-Entry
domain error: `handleEntryFailure()` must synchronously return `false`, the
Renderer must show the existing error toast, and no Entry recovery callback
may run.
Inject `DEVICE_AUTH_INVALID` independently from Chat initialization, Work
initialization/action, and Sync catch-up. During initial startup, Product must
close and reject the original error to its Entry-controller caller without
starting its runtime callback; an Entry-controller integration test proves the
caller performs exactly one invalidating transition and never subsequently
transitions active. After startup, the same error from Chat, Work, or Sync
starts one shared recovery promise/callback and stops the rendered cache. Keep
a control test proving an unrelated product error still follows the existing
toast/degraded path.
Add a rotate-during-open case: `onCacheValidated` observes that installation
changed, throws `ENTRY_INSTALLATION_CHANGED`, and the just-opened cache closes
exactly once before any Renderer, Chat/Work initialization, Sync, ACK or
identity-pointer write. Also make `rendererFactory` and `syncFactory` throw in
separate cases and prove every partially acquired Renderer/listener/cache is
destroyed exactly once.
Add a Product+Entry+Revoke lock integration case. Product first acquires
shared `family-ai-member-product-flight:install-a`, then cache-open, validates
the Context database and pauses immediately before pointer publication.
Revoke acquires the global Cookie lock and
`family-ai-member-entry-mutation:install-a`, writes the marker storage event
that really invokes Product stop/generation invalidation, and waits for
exclusive Product-flight before cache-open. Product still publishes the exact
pointer, aborts/drains all raw requests, closes cache and releases its shared
flight last. Revoke then enters exclusive flight, acquires cache-open, observes
and deletes that database before rotation. Assert the requested order is
Product shared-flight, Product cache-open, Revoke Cookie, Revoke Entry,
Revoke exclusive-flight, Revoke cache-open, with no deadlock or late pointer.
Add the inverse ordering case: Revoke owns
Cookie→Entry→exclusive Product-flight→cache-open first, writes its closing
tombstone and rotates. Product may acquire shared flight only after Revoke
releases exclusive flight; its immediate `assertEntryStartable()` then rejects
before cache-open or `openCache()`. Assert Product never requests Cookie or
Entry while holding shared flight/cache-open and no test path permits a
reverse lock order.
Add a real Product+Entry integration case that defers
`readBootstrapSnapshot()`, writes a closing tombstone, then releases the
snapshot. The injected `assertEntryStartable` must fail before
`rendererFactory`, Chat/Work initialization, Sync or ACK; if the validated
pointer was already persisted before the deferred snapshot, Revoke owns and
deletes it. The opened cache closes exactly once and no cached projection is
rendered.
Add a stale-generation network-drain case: defer an I1 Chat/Work fetch while
Product holds shared flight, call Product stop, assert the generation
AbortSignal fires and stop does not resolve until the raw fetch settles and
the shared lease is released last. Only then rotate/re-pair into I2. The
aborted I1 transport can deliver no later Set-Cookie/error response; its
disposed closure calls no Entry callback. In the cross-tab integration
variant, tab B writes Claim intent and waits on exclusive flight while tab A's
request remains deferred: B sends zero Claim bytes until A's storage receiver
stops/drains/releases. An already-captured I1 callback after that point is
handled as stale and leaves I2 Cookies, pointer, database, lifecycle and
installation unchanged.

Add a low-level opener test proving `openMemberCache()` with no database name
now rejects `MEMBER_CACHE_NAME_REQUIRED` without calling `indexedDB.open`;
the final production tree contains no no-argument caller.

- [ ] **Step 2: Write failing Sync revoke-control tests**

```ts
it("stops without reconnecting and reports one entry-revoked control", async () => {
  const onEntryRevoked = vi.fn();
  const controller = createSyncController({
    ...syncInput(),
    onEntryRevoked
  });
  await controller.start();
  source.emit("entry-revoked", {
    protocolVersion: 2,
    type: "device_revoked"
  });
  source.emit("entry-revoked", {
    protocolVersion: 2,
    type: "device_revoked"
  });

  await controller.whenIdle();
  expect(source.closed).toBe(true);
  expect(onEntryRevoked).toHaveBeenCalledOnce();
  expect(clock.pendingTimers()).toBe(0);
});
```

Also prove ordinary EventSource disconnect still follows existing
catch-up/reconnect behavior and is not treated as revoke. The terminal revoke
callback must start on its own immediate microtask and the controller's full
`lane` must join both that callback and all predecessor settlement, so
`whenIdle()` cannot resolve before cleanup notification finishes.
Add three self-deadlock cases. First, let the callback enter controller Revoke
and have Product disposal call `syncController.stop()`. Second, defer an older
Sync lane operation, accept `entry-revoked`, then call Product stop externally.
Third—and critically—defer an older raw Sync fetch and deliver only the
control: the immediate revoke callback itself must enter controller Revoke,
trigger Product Abort, settle the predecessor, release shared flight and
finish cleanup without an external stop. On control acceptance Sync captures a
pre-callback `revokeStopBarrier`; stop calls await at most that predecessor,
never the callback Promise, while the joined full lane/`whenIdle()` waits both.

- [ ] **Step 3: Run integration tests and observe RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberProductWorkbenchLifecycle.test.ts \
  test/memberSyncAuth.test.ts \
  test/memberApiStore.test.ts \
  test/memberWebModules.test.ts
```

Expected: current ProductWorkbench overwrites Context before validation, Sync ignores `entry-revoked`, and new browser modules are not served.

- [ ] **Step 4: Fix ProductWorkbench startup ownership**

Serialize and version every start at module scope:

```js
let activeWorkbench = null;
let requestedGeneration = 0;
let startLane = Promise.resolve();
let detachedTeardown = null;

function detachActiveWorkbench() {
  const current = activeWorkbench;
  if (current) {
    activeWorkbench = null;
    const prior = detachedTeardown ?? Promise.resolve();
    const teardown = prior.then(() => current.stop());
    detachedTeardown = teardown;
    const clearIfOwned = () => {
      if (detachedTeardown === teardown) detachedTeardown = null;
    };
    teardown.then(clearIfOwned, clearIfOwned);
  }
  return detachedTeardown ?? Promise.resolve();
}

export function startProductWorkbench(context, options = {}) {
  const generation = ++requestedGeneration;
  const eagerStop = detachActiveWorkbench();
  const result = startLane.then(
    () => startWorkbenchGeneration(
      context,
      options,
      generation,
      eagerStop
    )
  );
  startLane = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function stopProductWorkbench() {
  const stopGeneration = ++requestedGeneration;
  const pendingAtStop = startLane;
  await detachActiveWorkbench();
  await pendingAtStop;
  if (requestedGeneration === stopGeneration) {
    await detachActiveWorkbench();
  }
}
```

`detachedTeardown` is module-level disposal ownership, distinct from one
generation's internal `disposePromise`. Clearing `activeWorkbench` transfers
ownership to this tracked Promise before `current.stop()` can run. Every
concurrent stop and every later start therefore receives/awaits the same
pending teardown through shared-flight release; a rejected teardown is
reported to its callers but the settlement handler clears only its own slot,
so it cannot poison future generations.

`startWorkbenchGeneration()` first awaits `eagerStop`, then uses:

```js
function assertCurrentGeneration() {
  if (generation !== requestedGeneration) {
    const error = new Error("Product start was superseded.");
    error.code = "PRODUCT_START_SUPERSEDED";
    throw error;
  }
}

function assertStartupOwnership() {
  assertCurrentGeneration();
  assertEntryStartable();
}
```

Call the combined `assertStartupOwnership()` after every startup await except
that a successfully opened/Context-validated database must first publish its
cleanup locator as shown below. Call it immediately after pointer publication,
after snapshot read, before creating Renderer/Sync, before assigning
`activeWorkbench`, and immediately before returning. Its outer catch always
disposes the generation; `PRODUCT_START_SUPERSEDED` returns `null` after
cleanup while any other setup error is rethrown. A later call therefore
invalidates an in-flight generation immediately, and the one `startLane`
prevents overlapping resource acquisition.

Within `startWorkbenchGeneration`, perform this exact order:

```js
await eagerStop;
const assertEntryStartable =
  options.assertEntryStartable ?? (() => {});
assertStartupOwnership();
const openCache = options.openCache ?? openIdentityMemberCache;
const rendererFactory = options.rendererFactory ?? createRenderer;
const syncFactory = options.syncFactory ?? createSyncController;
const globalTarget = options.globalTarget ?? globalThis;
const withIdentityOpenLock =
  options.withIdentityOpenLock ??
  (async (operation) => operation());
const acquireProductFlight =
  options.acquireProductFlight ??
  (async () => ({ release: async () => {} }));
const onCacheValidated = options.onCacheValidated ?? (() => {});
const onEntryInvalid = options.onEntryInvalid ?? (() => {});
const onEntryRevoked = options.onEntryRevoked ?? (() => {});
const AbortControllerClass =
  options.AbortControllerClass ?? globalThis.AbortController;
const requestAbort = new AbortControllerClass();
const pendingRequests = new Set();
const api = createApiClient(options.fetchImpl, {
  defaultSignal: requestAbort.signal,
  onRequest(promise) {
    pendingRequests.add(promise);
    promise.then(
      () => pendingRequests.delete(promise),
      () => pendingRequests.delete(promise)
    );
  }
});
let disposed = false;
let cache = null;
let identity = null;
let renderer = null;
let syncController = null;
let onlineAttached = false;
let offlineAttached = false;
let ownedWorkbench = null;
let productFlightLease = null;
let disposePromise = null;
let online = () => undefined;
let offline = () => undefined;

async function releaseProductFlight() {
  const lease = productFlightLease;
  productFlightLease = null;
  await lease?.release?.();
}

function disposeOwnedResources() {
  if (disposePromise) return disposePromise;
  disposed = true;
  disposePromise = Promise.resolve().then(async () => {
    requestAbort.abort();
    try {
      await syncController?.stop?.();
    } finally {
      try {
        while (pendingRequests.size > 0) {
          await Promise.allSettled([...pendingRequests]);
        }
      } finally {
        try {
          renderer?.destroy?.();
        } finally {
          try {
            if (onlineAttached) {
              globalTarget.removeEventListener?.("online", online);
              onlineAttached = false;
            }
          } finally {
            try {
              if (offlineAttached) {
                globalTarget.removeEventListener?.("offline", offline);
                offlineAttached = false;
              }
            } finally {
              try {
                cache?.close();
              } finally {
                await releaseProductFlight();
              }
            }
          }
        }
      }
    }
  });
  return disposePromise;
}

try {
  productFlightLease = await acquireProductFlight();
  assertStartupOwnership();
  await withIdentityOpenLock(async () => {
    assertStartupOwnership();
    const opened = await openCache(context);
    cache = opened.cache;
    identity = opened.identity;
    await onCacheValidated(identity);
    assertStartupOwnership();
  });
  assertStartupOwnership();
  const snapshot = await readBootstrapSnapshot(cache);
  assertStartupOwnership();
```

Do not close this `try` after the excerpt: keep all startup acquisition and
initialization inside it. Assign the real `online`/`offline` closures after
Store and Sync creation; the initialized no-op variables let cleanup safely
reference them before listener registration. Extend `createApiClient()` with
optional `defaultSignal` and `onRequest` inputs; every Product fetch merges
the default signal with any request-local signal and reports only its raw
fetch-settlement Promise. Controller recovery callbacks, Sync lanes and
`onEntryInvalid`/`onEntryRevoked` Promises are never inserted into
`pendingRequests`, because Product disposal may be called from those callbacks.
Inside `rawApiRequest()`, create the raw `fetchImpl()` Promise, invoke
`onRequest?.(rawFetchPromise)` synchronously before the first await, and only
then await it; reporting a Promise after response headers have arrived does
not close the Cookie race. The `onRequest` observer itself never awaits or
wraps the Promise.
Stop aborts first and does not resolve until the raw-fetch set is empty, then
destroys Renderer/listeners/cache and releases the shared Product-flight lease
last, so an I1 response cannot apply Cookie side effects after I2 pairing.
Entry's separate API client remains unaffected unless it supplies these
options. Product acquires shared Product-flight before the identity/cache lock
and runs `assertStartupOwnership()` immediately after that potentially awaited
acquisition. The identity lock covers the
entire open/Context-validation/pointer-publication interval. The first guard
inside the lock prevents opening after a completed Revoke. After `openCache`
returns, do not run any generation/marker/tombstone guard before locator
publication: a Revoke marker or explicit stop may already have superseded the
generation, but the validated database still requires a deletion locator.
The adapter first rejects only an installation change or origin-global Claim
intent/Cookie-clear signal, then publishes the pointer; the trailing
`assertStartupOwnership()` handles generation, marker and tombstone while the
lock is still held.
`onCacheValidated` therefore persists the exact identity pointer before
releasing cache-open and before any projection read. Revoke, which already
owns Entry mutation, can acquire cache-open only afterward and is guaranteed
to observe that pointer. If snapshot or later startup fails, Revoke can still
locate and delete the private database. After validated snapshot creation,
build:

```js
const store = createStore(initialState(context, snapshot));
const threadController = createThreadController({
  api,
  cache,
  store,
  isOnline: () => store.getState().network.online,
  now: options.now,
  uuid: options.uuid
});
const timeZone =
  options.timeZone ??
  Intl.DateTimeFormat().resolvedOptions().timeZone ??
  "UTC";
const chatController = createChatController({
  api,
  cache,
  store,
  threadController,
  timeZone
});
const workController = createWorkController({
  api,
  cache,
  store,
  threadController
});
const applyEvent = createEventApplier({ api, cache, store, timeZone });
```

Retain the complete current `actions` object—`navigate`, `openWork`, `createWork`, `send`, `saveDraft`, `loadEarlier`, `retry`, `toggleMessageSelection`, and `convertChatToWork`—with its existing cache writes and guarded error paths. After that object is defined, assert the generation again:

```js
assertStartupOwnership();
renderer = rendererFactory({ store, actions });
assertStartupOwnership();
syncController = syncFactory({
  api,
  cache,
  store,
  applyEvent,
  EventSourceClass: options.EventSourceClass,
  BroadcastChannelClass: options.BroadcastChannelClass,
  onError: handleEntryFailure,
  onCacheUpdated: () => void reloadCacheIntoStore(cache, store),
  onEntryRevoked: () => awaitEntryRecovery(deviceRevokedError())
});

online = () => {
  store.setState((current) => ({
    ...current,
    network: { online: true }
  }));
  void syncController.reconnectNow();
};
offline = () => {
  store.setState((current) => ({
    ...current,
    network: { online: false },
    sync: { ...current.sync, status: "offline" }
  }));
};
globalTarget.addEventListener?.("online", online);
onlineAttached = true;
globalTarget.addEventListener?.("offline", offline);
offlineAttached = true;
assertStartupOwnership();
ownedWorkbench = {
  async stop() {
    await disposeOwnedResources();
  },
  store,
  actions,
  cache
};
activeWorkbench = ownedWorkbench;
```

Route product errors exactly:

```js
let startupSettled = false;
let startupEntryFailure = null;
let entryRecoveryPromise = null;

function deviceRevokedError() {
  const error = new Error("当前浏览器入口已被移除。");
  error.code = "DEVICE_REVOKED";
  return error;
}

function routeEntryFailure(error) {
  if (!isEntryFailure(error)) return null;
  if (disposed || generation !== requestedGeneration) {
    return Promise.resolve();
  }
  if (!startupSettled) {
    startupEntryFailure ??= error;
    return Promise.resolve();
  }
  if (!entryRecoveryPromise) {
    const callback =
      error.code === "DEVICE_REVOKED" ||
      error.code === "DEVICE_AUTH_INVALID"
        ? onEntryRevoked
        : onEntryInvalid;
    entryRecoveryPromise = Promise.resolve().then(() => callback(error));
  }
  return entryRecoveryPromise;
}

function handleEntryFailure(error) {
  return routeEntryFailure(error) !== null;
}

async function awaitEntryRecovery(error) {
  const recovery = routeEntryFailure(error);
  if (!recovery) return false;
  await recovery;
  return true;
}
```

Extend `isEntryFailure()` with `DEVICE_AUTH_INVALID`. This invalidating branch
is only for an already-open active ProductWorkbench; Pairing claim errors are
classified in Task 12 before product startup. Keep
`handleEntryFailure(error): boolean` synchronous because existing guarded
Product actions use its false result to preserve ordinary domain-error toasts.
An Entry error from a disposed or superseded generation returns a resolved
handled Promise without invoking either callback, so it cannot retarget a new
installation and cannot fall through to a stale Renderer toast.
Use `awaitEntryRecovery(error): Promise<boolean>` only at ownership boundaries
that must await complete recovery, including Sync revoke control. The injected
Entry-controller callbacks are the non-rejecting `Promise<boolean>` boundary
defined in Task 12, so the returned recovery Promise settles only after the
complete stop/cleanup/state transition.

Use `globalTarget.addEventListener()` and `globalTarget.removeEventListener()`
for online/offline ownership. Install `ownedWorkbench` before any
initialization request so Entry recovery can stop it. Preserve, after that
assignment:

```js
try {
  await Promise.all([
    chatController.initialize(),
    workController.initialize()
  ]);
  assertStartupOwnership();
  if (startupEntryFailure) throw startupEntryFailure;
  const savedWork =
    snapshot.selectedWorkRef &&
    store.getState().works.some(
      (work) => work.workConversationRef === snapshot.selectedWorkRef
    )
      ? snapshot.selectedWorkRef
      : null;
  if (snapshot.selectedSection === "work" && savedWork) {
    await workController.open(savedWork);
    assertStartupOwnership();
    if (startupEntryFailure) throw startupEntryFailure;
    store.setState((current) => nextNavigationState(current, "work"));
  } else {
    store.setState((current) => nextNavigationState(current, "chat"));
    if (snapshot.selectedSection === "work") {
      await saveMeta(cache, "selectedSection", "chat");
      assertStartupOwnership();
      if (startupEntryFailure) throw startupEntryFailure;
    }
  }
  if (startupEntryFailure) throw startupEntryFailure;
  await syncController.start();
  assertStartupOwnership();
  if (startupEntryFailure) throw startupEntryFailure;
} catch (error) {
  assertCurrentGeneration();
  const entryFailure =
    startupEntryFailure ?? (isEntryFailure(error) ? error : null);
  if (entryFailure) throw entryFailure;
  renderer.showToast(error.message ?? "工作台加载失败。", "error");
  store.setState((current) => ({
    ...current,
    sync: { ...current.sync, status: "degraded" }
  }));
}
startupSettled = true;
assertStartupOwnership();
return ownedWorkbench;
} catch (error) {
  if (activeWorkbench === ownedWorkbench) activeWorkbench = null;
  await disposeOwnedResources();
  if (error.code === "PRODUCT_START_SUPERSEDED") return null;
  throw error;
}
```

Wrap the entire acquisition and initialization body in one outer `try/catch`.
On an exception before `ownedWorkbench` is assigned, call
`disposeOwnedResources()`. On an exception after assignment that must escape
(including `ENTRY_INSTALLATION_CHANGED`), clear
`activeWorkbench` only when it is the same object, then call
`ownedWorkbench.stop()` and rethrow. Existing non-Entry Chat/Work startup
errors may keep the initialized workbench in its tested degraded state. Entry
failures during startup—including an error delivered internally through
Chat/Work initialization or Sync’s `onError`—are checked after every
initialization await and immediately before Sync start, then fully disposed
and rejected to the Entry-controller caller. Product does not continue into
catch-up/ACK or start a competing callback. Only after
`startupSettled = true` can runtime Chat/Work/Sync errors start the one
memoized `entryRecoveryPromise`.
The memoized `disposePromise` makes every concurrent stop await the exact same
abort/drain/teardown/lease-release completion and makes Sync, Renderer,
listeners, cache and Product-flight close/release exactly once on every path,
including a throw from `onCacheValidated`, `rendererFactory`, or
`syncFactory`.

`stopProductWorkbench()` remains idempotent. Remove
`clearProductWorkbenchCache()`; Revoke deletion is owned by the Entry
controller.

Finally change the Task 8 compatibility signature to
`openMemberCache(databaseName, { indexedDBImpl = globalThis.indexedDB } = {})`
and insert this exact guard before checking IndexedDB availability or calling
`indexedDBImpl.open(databaseName, DATABASE_VERSION)`:

```js
if (typeof databaseName !== "string" || databaseName.length === 0) {
  const error = new Error("Member cache name is required.");
  error.code = "MEMBER_CACHE_NAME_REQUIRED";
  throw error;
}
```

Search every production/test caller in this task, pass an explicit identity
database name where low-level behavior is under test, and assert no
`openMemberCache()` call remains.

- [ ] **Step 5: Handle the SSE control without confusing network failure**

Initialize `let revokeCallbackScheduled = false`,
`let revokeStopBarrier = Promise.resolve()` and
`let revokeCallbackPromise = Promise.resolve()` with the existing Sync
terminal flags. Register exactly one `entry-revoked` listener per EventSource.
On the first valid v2 payload:

```js
revoked = true;
stopped = true;
revokeCallbackScheduled = true;
cancelReconnect();
eventSource.close();
source = null;
const beforeRevokeCallback = lane;
revokeStopBarrier = beforeRevokeCallback.then(
  () => undefined,
  (error) => reportError(error)
);
revokeCallbackPromise = Promise.resolve()
  .then(() => onEntryRevoked())
  .catch((error) => reportError(error));
lane = Promise.all([
  revokeStopBarrier,
  revokeCallbackPromise
]).then(() => undefined);
return lane;
```

Add `revoked` guards to `catchUp()`, `connect()`, `scheduleReconnect()` and
`reconnectNow()`. Set terminal `revoked`/`stopped` state synchronously before
`close()` so an `onerror` emitted during close cannot schedule a reconnect.
From the instant `revokeCallbackScheduled` becomes true, `stop()` closes any
remaining source/timer ownership and returns `revokeStopBarrier`, not `lane`.
That barrier waits older catch-up work but excludes the revoke callback.
Crucially, `revokeCallbackPromise` is not chained after that predecessor: it
starts immediately and enters controller Revoke, whose Product stop aborts raw
API requests before calling Sync stop. The abort lets a stuck predecessor
settle; Product then drains and releases shared flight. Awaiting the joined full
lane from Sync stop would self-deadlock:
callback→controller Revoke→Product disposal→Sync stop. The full `lane` instead
joins the predecessor barrier and callback Promise only for duplicate controls
and `whenIdle()`, which therefore cannot report completion early. A duplicate
control returns that existing full lane without invoking the callback again.
Do not ACK the control, write it to the projection cache, or broadcast it on the projection-sync channel.

- [ ] **Step 6: Reduce `entry.js` to the page adapter and enforce boot order**

At module evaluation, before constructing the API client:

```js
const storage = createEntryStorage();
const installationId = storage.getOrCreateInstallationId();
let pendingClaim;
let fragmentError;
try {
  pendingClaim = capturePairingFragment({
    href: globalThis.location.href,
    historyRef: globalThis.history,
    installationId,
    sessionStorage: globalThis.sessionStorage,
    cryptoImpl: globalThis.crypto
  });
} catch (error) {
  fragmentError = error;
}
```

Only after this synchronous block:

1. create the API and Entry controller;
2. retry legacy database deletion;
3. wire Pair, Logout, Resume, Remove This Browser, `controller.retry()` and unload handlers;
4. call `controller.bootstrap({ pendingClaim, fragmentError })`.

Construct the controller adapters without giving it direct DOM or storage globals:

```js
const api = createApiClient();
const mutationLock = createEntryMutationLock();
let controller;
controller = createEntryController({
  api,
  storage,
  mutationLock,
  cacheLifecycle: {
    deleteLegacy: () => deleteLegacyMemberCache(),
    deleteIdentity: (identity, options) =>
      deleteIdentityMemberCache(identity, options)
  },
  workbench: {
    start: async (
      context,
      expectedInstallationId,
      assertEntryStartable
    ) => {
      assertEntryStartable();
      const result = await startProductWorkbench(context, {
        assertEntryStartable,
        acquireProductFlight: () =>
          mutationLock.acquireProductFlight(
            expectedInstallationId
          ),
        withIdentityOpenLock: (operation) =>
          mutationLock.runCacheOpen(
            expectedInstallationId,
            operation
          ),
        onCacheValidated: (identity) => {
          if (
            storage.readInstallationId() !== expectedInstallationId ||
            storage.readClaimCookieIntent() ||
            storage.readCookieClearPending()
          ) {
            assertEntryStartable();
            const error = new Error(
              "Entry startup invariant changed before pointer publication."
            );
            error.code = "ENTRY_START_INVARIANT_CHANGED";
            throw error;
          }
          storage.writeIdentityPointer(expectedInstallationId, identity);
          assertEntryStartable();
        },
        onEntryInvalid: (error) =>
          controller.handleEntryFailure(
            error,
            expectedInstallationId
          ),
        onEntryRevoked: (error) =>
          controller.handleEntryFailure(
            error,
            expectedInstallationId
          )
      });
      return result !== null;
    },
    stop: () => stopProductWorkbench()
  },
  pendingClaims: {
    clear: () => clearPendingClaim(globalThis.sessionStorage),
    isTerminalError: isTerminalPairingError,
    shouldRetain: shouldRetainPendingClaim
  },
  deviceDescriptor: browserDescriptor(),
  onViewState: renderEntryState
});

async function bootstrapMemberPage() {
  await controller.bootstrap({ pendingClaim, fragmentError });
}

async function submitManualPairing(code) {
  const currentInstallationId = storage.readInstallationId();
  const manualClaim = preparePendingClaim({
    code,
    installationId: currentInstallationId,
    sessionStorage: globalThis.sessionStorage,
    cryptoImpl: globalThis.crypto
  });
  await controller.claim(manualClaim);
}
```

The adapter and controller share this one `mutationLock` instance. Product
takes shared `acquireProductFlight()` and then `runCacheOpen()`; Revoke takes
`runCookieMutation()`, then `run()`, exclusive `runProductDrain()`, then
`runCacheOpen()` on the same expected installation. Product retains its shared
lease through Sync stop, raw-request abort/drain, Renderer/listener teardown
and cache close, and releases it last. The pointer callback
rejects an installation change or origin-global Claim intent/Cookie-clear
signal before writing. A same-installation closing tombstone instead permits the exact
validated pointer write and is caught by the trailing
`assertEntryStartable()`, so Revoke waiting on cache-open can delete the
database. `ENTRY_START_INVARIANT_CHANGED` is a defensive impossible-state
fallback if the injected assertion fails to reject a changed invariant; it
never enters a retry/renew path.

Delete the private `api()` implementation from `entry.js`. All Context, Claim, renew, Logout, Revoke and Cookie-clear requests use `createApiClient()`.
Keep the existing `revokeButton` confirmation copy, but its confirmed action is only `controller.removeDevice()`; it must not directly clear cache, cookies or the installation key.
The module-level `installationId` is only the synchronous fragment-capture
snapshot. Every later manual Pair submission calls
`storage.readInstallationId()` as above. Add an adapter test that completes
Revoke rotation, submits a manual code without reloading, and asserts the
Claim contains the one new shared installation ID—not the captured old ID.

- [ ] **Step 7: Serve every new module and keep static security checks**

Add these assets to `productModules`:

```ts
["/member/assets/cache-identity.js", "cache-identity.js"],
["/member/assets/pairing.js", "pairing.js"],
["/member/assets/entry-storage.js", "entry-storage.js"],
["/member/assets/entry-mutation.js", "entry-mutation.js"],
["/member/assets/entry-lifecycle.js", "entry-lifecycle.js"],
```

Update module syntax/import-route tests. Keep CSP, `no-store`, no inline script, no `innerHTML`, accessibility and secret-term scans as static supplements; remove checks that assert private function names or implementation strings.

- [ ] **Step 8: Run the complete browser behavior slice**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberIdentityCache.test.ts \
  test/memberCacheModel.test.ts \
  test/memberApiStore.test.ts \
  test/memberEntryStorage.test.ts \
  test/memberPairingClient.test.ts \
  test/memberEntryLifecycle.test.ts \
  test/memberProductWorkbenchLifecycle.test.ts \
  test/memberRenderLifecycle.test.ts \
  test/memberSyncModel.test.ts \
  test/memberSyncAuth.test.ts \
  test/memberPersistenceReview.test.ts \
  test/memberWebModules.test.ts \
  test/memberWeb.test.ts
```

Expected: PASS with behavior assertions replacing the former
lifecycle/Renderer source-string checks, no implicit global cache opener, and
active `DEVICE_AUTH_INVALID` fail-closed across Chat, Work and Sync.

- [ ] **Step 9: Commit**

```bash
git add \
  apps/gateway/member-public \
  apps/gateway/src/memberWeb.ts \
  apps/gateway/test/memberApiStore.test.ts \
  apps/gateway/test/memberCacheModel.test.ts \
  apps/gateway/test/memberProductWorkbenchLifecycle.test.ts \
  apps/gateway/test/memberSyncAuth.test.ts \
  apps/gateway/test/memberWebModules.test.ts \
  apps/gateway/test/memberPersistenceReview.test.ts
git commit -m "feat(member): integrate secure entry lifecycle"
```

---

### Task 14: Move every formal pairing handoff to a non-logging fragment

**Files:**
- Create: `scripts/write-member-handoff.mjs`
- Create: `apps/gateway/test/memberHandoff.test.ts`
- Modify: `scripts/acceptance-onboarding.sh`
- Modify: `scripts/dev-up.sh`
- Modify: `scripts/verify-foundation.sh`
- Modify: `apps/gateway/test/memberWebOneClick.test.ts`
- Modify: `scripts/static-check.sh`
- Modify: `docs/development/2026-07-25-member-web-product-workbench.md`

**Interfaces:**
- Formal handoff format:

```text
http://127.0.0.1:8791/member/#pairingRef=pairing%3Aweb-alice-0001&code=ABCD-EFGH
```

- Formal stdout may name the `0600` handoff file path, but never the URL, pairing ref, code, Device Credential, Entry Token or Cookie.

- [ ] **Step 1: Write failing handoff and captured-output tests**

In `memberWebOneClick.test.ts`, replace the query-string assertion with:

```ts
expect(onboardingSource).toContain("scripts/write-member-handoff.mjs");
expect(onboardingSource).not.toContain("/member/?pairingRef=");
expect(devUpSource).not.toContain("ACCEPTANCE_URL");
expect(devUpSource).not.toContain("#token=");
expect(devUpSource).not.toMatch(/xdg-open|gio open/u);
expect(devUpSource).not.toMatch(/cat .*member-web-url|printf .*MEMBER_WEB_URL/u);
expect(verifySource).not.toMatch(/tee .*onboarding|cat .*member-web-url/u);
expect(verifySource).not.toMatch(/\$MEMBER_WEB_URL\b/u);
```

In `memberHandoff.test.ts`, execute the helper with pairing material on stdin, not argv:

```ts
const result = spawnSync(
  process.execPath,
  [helperPath, handoff],
  {
    input:
      "http://127.0.0.1:8791\\0" +
      "pairing:sentinel\\0" +
      "SENT-INEL\\0",
    encoding: "utf8"
  }
);
expect(result.status).toBe(0);
expect(readFileMode(handoff)).toBe(0o600);
expect(readFileSync(handoff, "utf8")).toContain(
  "/member/#pairingRef=pairing%3Asentinel&code=SENT-INEL"
);
expect(result.stdout + result.stderr).toBe("");
```

- [ ] **Step 2: Run handoff tests and observe RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberHandoff.test.ts \
  test/memberWebOneClick.test.ts
```

Expected: FAIL because the helper does not exist, onboarding writes a query URL, `dev-up.sh` prints/opens a Bootstrap Token URL, and verification pipes secret-capable output through `tee`.

- [ ] **Step 3: Implement an atomic, silent handoff writer**

`write-member-handoff.mjs` exports `writeMemberHandoff()` for Task 15 and has a CLI that reads exactly three NUL-delimited fields from stdin:

```js
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function writeMemberHandoff({
  outputPath,
  baseUrl,
  pairingRef,
  code
}) {
  const url = new URL("/member/", baseUrl);
  url.hash = new URLSearchParams({ pairingRef, code }).toString();
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${url.href}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporaryPath, outputPath);
    await chmod(outputPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const fields = Buffer.concat(chunks).toString("utf8").split("\0");
  if (
    fields.length !== 4 ||
    fields[3] !== "" ||
    fields.slice(0, 3).some((value) => value.length === 0) ||
    typeof process.argv[2] !== "string"
  ) {
    throw new Error("MEMBER_HANDOFF_INPUT_INVALID");
  }
  await writeMemberHandoff({
    outputPath: process.argv[2],
    baseUrl: fields[0],
    pairingRef: fields[1],
    code: fields[2]
  });
}
```

The successful CLI writes nothing to stdout/stderr. `acceptance-onboarding.sh` invokes it without secret argv:

```bash
printf '%s\0%s\0%s\0' \
  "$BASE_URL" "$PAIRING_REF" "$PAIRING_CODE" |
  node "$ROOT_DIR/scripts/write-member-handoff.mjs" "$MEMBER_WEB_URL_FILE"
printf 'Member Web handoff: %s\n' "$MEMBER_WEB_URL_FILE"
```

Delete `ACCEPTANCE_URL`, its `#token=` output, and both `xdg-open`/`gio open` branches from `dev-up.sh`; print only non-secret next commands. `verify-foundation.sh` must not pipe onboarding through `tee`, read the handoff contents into a shell variable, or print the URL. It validates format in a silent child process and prints the handoff path only. Do not include the URL or secret variables in `record()` evidence, markdown reports, command tracing or error output.

- [ ] **Step 4: Add static release guards**

`scripts/static-check.sh` must fail on:

- `/member/?pairingRef=`;
- `ACCEPTANCE_URL=`, executable `#token=` handoffs, and `xdg-open`/`gio open` secret URLs;
- reads of `MEMBER_WEB_URL_FILE` whose bytes reach stdout, stderr or `tee`;
- onboarding output piped through `tee`;
- tracked paths under `.runtime-preview`;
- imports of the response-loss proxy from `apps/`, `packages/` or production build scripts.

- [ ] **Step 5: Run handoff and static tests**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberHandoff.test.ts \
  test/memberWebOneClick.test.ts \
  test/memberWebModules.test.ts
bash scripts/static-check.sh
```

Expected: PASS; formal URLs use fragments and captured output contains no pairing sentinel.

- [ ] **Step 6: Commit**

```bash
git add \
  scripts/write-member-handoff.mjs \
  scripts/acceptance-onboarding.sh \
  scripts/dev-up.sh \
  scripts/verify-foundation.sh \
  scripts/static-check.sh \
  apps/gateway/test/memberHandoff.test.ts \
  apps/gateway/test/memberWebOneClick.test.ts \
  docs/development/2026-07-25-member-web-product-workbench.md
git commit -m "fix(scripts): keep pairing handoffs out of logs"
```

---

### Task 15: Build an isolated direct-experience Preview and claim-loss proxy

**Files:**
- Create: `scripts/member-preview-up.sh`
- Create: `scripts/member-preview-pair.mjs`
- Create: `scripts/member-preview-revoke.mjs`
- Create: `scripts/member-preview-secret-audit.mjs`
- Create: `scripts/member-preview-down.sh`
- Create: `scripts/member-preview-claim-loss-proxy.mjs`
- Create: `apps/gateway/test/memberPreviewScripts.test.ts`
- Create: `apps/gateway/test/memberPreviewProxy.test.ts`
- Create: `apps/gateway/test/memberSecretBoundary.test.ts`
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `scripts/static-check.sh`

**Interfaces:**
- `bash scripts/member-preview-up.sh` starts only `127.0.0.1:8791`.
- `bash scripts/member-preview-up.sh --with-claim-loss-proxy` also starts `127.0.0.1:8792`.
- `node scripts/member-preview-pair.mjs --port 8791` creates a normal fragment handoff.
- `node scripts/member-preview-pair.mjs --port 8792` creates the guided response-loss handoff.
- `node scripts/member-preview-revoke.mjs --port 8791` revokes the Web Device consumed by the last `8791` pairing through the formal Admin endpoint.
- `node scripts/member-preview-secret-audit.mjs` runs the protected five-sentinel audit and prints only PASS/failure labels.
- `bash scripts/member-preview-down.sh` stops only PIDs recorded under this worktree’s `.runtime-preview/run/`.

- [ ] **Step 1: Write failing Preview isolation tests**

```ts
it("defines a compose-free, loopback-only preview", () => {
  expect(upSource).toContain("GATEWAY_HOST=127.0.0.1");
  expect(upSource).toContain("GATEWAY_PORT=8791");
  expect(upSource).toContain(".runtime-preview/data/gateway.sqlite");
  expect(upSource).not.toMatch(/docker compose|dev-reset|verify-foundation/u);
  expect(upSource).not.toMatch(/0\.0\.0\.0|GATEWAY_PORT=8790/u);
  expect(downSource).not.toMatch(/pkill|killall|lsof .*8790|docker/u);
});

it("keeps all Preview runtime material out of Git and Docker contexts", () => {
  expect(gitignore).toMatch(/^\.runtime-preview\/$/mu);
  expect(dockerignore).toMatch(/^\.runtime-preview\/$/mu);
});
```

Add tests for:

- `umask 077` plus explicit `chmod 700` on reused directories and `chmod 600` on reused config/handoff/PID/log files;
- `cd "$ROOT_DIR"` before build or spawn;
- an atomic start lock;
- idempotent reuse of a live, owned PID record;
- rejection of stale/reused PID records and unowned `8791`/`8792` listeners;
- PID plus `/proc/${pid}/stat` starttime ownership validation;
- a `0600` PID manifest containing launch commit, built-dist SHA-256 and
  non-printing config SHA-256; reuse fails when any fingerprint differs;
- post-health confirmation that the new PID is alive and `ss -ltnp` attributes the listener to that PID;
- stdout redaction and no production import of the proxy.
- pairing helper rejects a handoff with less than 240 seconds remaining and
  stores only non-secret `pairingRef`/`expiresAt` metadata beside the protected
  URL.
- on an empty runtime, both the Pair helper and secret audit import the same
  `loadOrInitializePreviewAdmin()` owner; exactly one initialization writes
  the shared protected Admin material, and the later caller verifies/reuses
  it rather than creating an incompatible Family.

- [ ] **Step 2: Write the failing whole-site proxy behavior test**

Use Node `http` servers on OS-assigned ports:

1. upstream records request count and returns the formal bodyless Claim
   `204` plus two `Set-Cookie` values;
2. proxy forwards a static asset and a normal API unchanged;
3. first Claim reaches upstream and finishes there, while the client receives a connection failure;
4. second identical Claim receives the exact upstream `204`, cookies and
   empty body;
5. upstream count is `2`;
6. an SSE upstream writes one frame and stays open; the client receives that frame before upstream end;
7. hop-by-hop headers are removed while `Host`, `Origin`, status, `Set-Cookie` and end-to-end headers retain formal semantics;
8. two simultaneous first Claims produce exactly one dropped downstream and one pass-through response;
9. resetting a consumed state re-arms exactly one later failure, while a live `in_flight` state refuses reset;
10. proxy log bytes contain none of request body, Cookie, Set-Cookie, Device Credential, pairing code or full fragment sentinels.

Expected assertion:

```ts
await expect(firstClaim()).rejects.toThrow();
const replay = await secondClaim();
expect(replay.status).toBe(204);
expect(replay.headers.getSetCookie()).toEqual(upstreamCookies);
expect(await replay.text()).toBe("");
```

- [ ] **Step 3: Run Preview tests and observe RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberPreviewScripts.test.ts \
  test/memberPreviewProxy.test.ts \
  test/memberSecretBoundary.test.ts
```

Expected: FAIL because the Preview scripts, proxy and ignore entries do not exist.

- [ ] **Step 4: Implement the isolated runtime layout and secret-safe start**

`member-preview-up.sh`:

1. asserts `hostname -s` is `Admin-YR`;
2. asserts its repository root equals the approved worktree;
3. resolves
   `ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"`, changes
   to it, sets `umask 077`, creates
   `.runtime-preview/{config,data,run,logs}`, and creates/tightens every
   directory to `0700`;
4. only after `run/` exists, acquires the atomic
   `.runtime-preview/run/start.lock` directory with trap cleanup;
5. snapshots `127.0.0.1:8790/health` plus the one
   `docker ps --filter publish=8790` row and exact loopback mapping;
6. creates one 32-byte Gateway token and `gateway.env` only when missing;
   otherwise validates and reuses the protected config, then explicitly sets
   config/token/log/PID modes to `0600`;
7. runs `npm run build:gateway`, computes the current Git commit, a SHA-256
   over the sorted built Gateway files, and the config SHA-256 without
   printing any content;
8. validates any existing PID/starttime manifest; reuse is allowed only when
   cwd, cmdline, listener ownership, health, launch commit, dist fingerprint
   and config fingerprint all match;
9. rejects an unowned listener before replacing a stale PID record; a
   fingerprint mismatch may stop only the fully validated recorded PID, then
   starts a new process;
10. starts `apps/gateway/dist/index.js` with the environment sourced inside the child shell, not placed in argv;
11. records PID, `/proc/${pid}/stat` starttime and all three fingerprints,
    waits for `8791/health`, confirms that same PID still owns `8791`, and
    compares the `8790` snapshot;
12. starts and validates the proxy with the same ownership/fingerprint rules
    only when `--with-claim-loss-proxy` is present.

Use:

```bash
nohup /bin/bash -c \
  'set -a; . "$1"; set +a; exec node "$2"' \
  preview-runtime \
  "$RUNTIME_DIR/config/gateway.env" \
  "$ROOT_DIR/apps/gateway/dist/index.js" \
  >>"$RUNTIME_DIR/logs/gateway.log" 2>&1 </dev/null &
```

The environment file contains:

```text
GATEWAY_MODE=development
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=8791
GATEWAY_DATABASE_PATH=/home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening/.runtime-preview/data/gateway.sqlite
```

The script appends `GATEWAY_DEVICE_TOKEN=` followed by a freshly generated canonical 32-byte Base64URL value read from `.runtime-preview/config/device-token`; neither value is printed.

- [ ] **Step 5: Implement exact PID-scoped shutdown**

For each recorded PID:

1. parse a positive decimal PID and recorded starttime;
2. compare `/proc/${pid}/stat` starttime, `/proc/${pid}/cwd` and `/proc/${pid}/cmdline`;
3. require the cwd to equal the approved worktree;
4. require the command to name either `apps/gateway/dist/index.js` or `member-preview-claim-loss-proxy.mjs`;
5. send `TERM`, wait up to ten seconds, then report failure rather than killing any wider target.

Never stop by port, `pkill`, Docker/Compose project or image name. Leave `8790` untouched.
No recorded Preview process is a successful no-op with exit status `0`;
ownership mismatch, a surviving owned PID, or any other shutdown failure exits
nonzero so Task 16’s `set -e` prevents a false “forced restart”.

- [ ] **Step 6: Implement provisioning and the `0600` handoff**

`member-preview-pair.mjs` uses built-in `fetch` and reads the Gateway token
from `.runtime-preview/config/gateway.env`. It exports
`loadOrInitializePreviewAdmin()` without executing the CLI main path when
imported. That shared owner:

1. initializes the Preview family only when onboarding status is empty;
2. stores the Admin Entry material in `.runtime-preview/config/admin-entry.json` with `0600`;
3. when the Family already exists, requires that file and verifies its Admin Session through `/api/v1/portal/context`; missing/stale material fails closed with a non-secret instruction to stop the Preview and archive/reset only `.runtime-preview`;
4. serializes initialization with one exclusive runtime lock so Pair and audit
   cannot both bootstrap.

The Pair CLI calls that shared owner, then:

5. creates a new member pairing code through the real Admin API;
6. verifies the returned `expiresAt` leaves at least 240 seconds, then writes
   `{ protocolVersion: 2, pairingRef, expiresAt }` without code to
   `.runtime-preview/config/pairing-target-8791.json` or
   `pairing-target-8792.json`;
7. for port `8792`, refuses reset while proxy state is `in_flight`, then atomically removes a prior `consumed` state so the next Claim is armed;
8. calls Task 14 `writeMemberHandoff()` to write `.runtime-preview/config/member-web-url-8791` or `.runtime-preview/config/member-web-url-8792` with `0600`;
9. prints only the handoff file path.

Do not pass Bootstrap/Admin/Pairing secrets in process argv and do not print response bodies.

`member-preview-revoke.mjs --port 8791`:

1. verifies the Admin Session;
2. reads the saved non-secret pairing ref;
3. opens the Preview SQLite database read-only and resolves that Pairing’s `consumed_device_ref`;
4. fails closed if the Pairing has not been consumed or the Device is not one active Web/browser Device;
5. calls `DELETE /api/v1/admin/devices/{encodedDeviceRef}` with the formal Admin Entry;
6. prints only `Preview Web Device revoke: PASS`.

The helper never updates SQLite directly; the database lookup only supplies the exact Device ref for the real Admin API.

- [ ] **Step 7: Implement the one-shot whole-site proxy**

Export `createClaimLossProxy({ upstreamOrigin, stateFile, log })` for tests. In CLI mode listen on `127.0.0.1:8792` and proxy every path to `127.0.0.1:8791`, preserving downstream `Host` and `Origin`.

Before forwarding a Claim, atomically create an `in_flight` state file with exclusive `wx` semantics. The request that creates it is the sole fault owner; concurrent requests pass through. If upstream fails before a complete response, remove `in_flight` to re-arm. For the sole fault owner after upstream completes:

```js
upstreamResponse.resume();
upstreamResponse.once("end", () => {
  replaceFaultStateAtomically(stateFile, "in_flight", "consumed");
  downstream.destroy();
});
```

On proxy process startup, a leftover `in_flight` file is re-armed because no prior request can still be alive; `consumed` persists until `member-preview-pair.mjs --port 8792` safely resets it. All non-owner requests pass status and end-to-end headers/body through chunk-by-chunk without buffering, including an indefinitely open SSE response. Remove the standard hop-by-hop request/response headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`) while retaining downstream `Host` and `Origin`. Log only lifecycle labels, timestamps and proxy-generated request IDs; never log URLs, headers, request/response bodies or fragments.

- [ ] **Step 8: Implement the executable five-sentinel boundary audit**

`memberSecretBoundary.test.ts` uses distinct fixed, schema-valid sentinels for Bootstrap token, Entry Cookie/token, 32-byte Device Credential, pairing code and full fragment. It asserts:

- PublicError and ordinary JSON never contain any sentinel;
- lifecycle and projection BroadcastChannel payloads never contain any sentinel or business message body;
- LocalStorage and identity IndexedDB contain neither pending Claim material nor HttpOnly secrets;
- SessionStorage retains only the unresolved Claim and clears it on success/terminal error;
- proxy logs exclude all five.

`member-preview-secret-audit.mjs` imports and awaits
`loadOrInitializePreviewAdmin()` before creating a separate audit pairing
through the formal Admin API. This makes the audit executable on a completely
fresh `.runtime-preview` and leaves the same verified
`admin-entry.json` for the later Pair CLI. It submits the valid sentinel
Credential through the formal Claim route, captures responses without
printing them, and scans Gateway/Preview/proxy logs plus
ordinary/PublicError JSON. It treats only `Set-Cookie` and the protected
handoff file as intended carriers for their corresponding values. Output is
one non-secret PASS line or named boundary failures.

- [ ] **Step 9: Run Preview tests and static guards**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberPreviewScripts.test.ts \
  test/memberPreviewProxy.test.ts \
  test/memberSecretBoundary.test.ts
bash scripts/static-check.sh
```

Expected: PASS for one-shot failure, identical replay response, loopback isolation, runtime permissions, PID scope and sentinel redaction.

- [ ] **Step 10: Commit**

```bash
git add \
  .gitignore \
  .dockerignore \
  scripts/member-preview-up.sh \
  scripts/member-preview-pair.mjs \
  scripts/member-preview-revoke.mjs \
  scripts/member-preview-secret-audit.mjs \
  scripts/member-preview-down.sh \
  scripts/member-preview-claim-loss-proxy.mjs \
  scripts/static-check.sh \
  apps/gateway/test/memberPreviewScripts.test.ts \
  apps/gateway/test/memberPreviewProxy.test.ts \
  apps/gateway/test/memberSecretBoundary.test.ts
git commit -m "feat(dev): add isolated member web preview"
```

---

### Task 16: Verify the full story and prepare the user experience

**Files:**
- Create: `docs/superpowers/evidence/2026-07-25-member-web-entry-hardening.md`

**Required skill before completion:** `superpowers:verification-before-completion`

Every block labeled “Run on Linux” in this task is remote shell content issued
from the Mac through `ssh admin-yr`; none of it runs in the Mac checkout.
Before Step 1, verify the remote boundary with `hostname -s` (`Admin-YR`),
`whoami` (`youran`), the exact worktree path, branch and HEAD.

- [ ] **Step 1: Run the full automated quality gate from a clean process**

Run on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
npm run check
```

Record the fresh Vitest file/test totals, failures, skips, typecheck and build results. A prior run or partial test set is not completion evidence.

- [ ] **Step 2: Run the focused security and behavior gate**

Run on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryCrypto.test.ts \
  test/webEntryRepository.test.ts \
  test/webEntryRoutes.test.ts \
  test/webEntryCookies.test.ts \
  test/webEntryBridge.test.ts \
  test/eventStream.test.ts \
  test/eventStreamRoutes.test.ts \
  test/memberIdentityCache.test.ts \
  test/memberCacheModel.test.ts \
  test/memberApiStore.test.ts \
  test/memberPairingClient.test.ts \
  test/memberEntryStorage.test.ts \
  test/memberEntryLifecycle.test.ts \
  test/memberProductWorkbenchLifecycle.test.ts \
  test/memberRenderLifecycle.test.ts \
  test/memberSyncAuth.test.ts \
  test/memberHandoff.test.ts \
  test/memberSecretBoundary.test.ts \
  test/memberPreviewScripts.test.ts \
  test/memberPreviewProxy.test.ts
```

Expected: all focused tests PASS with zero unexpected skips.

- [ ] **Step 3: Prove the existing `8790` instance is unchanged**

Before and after Preview startup, capture on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
curl --silent --show-error --fail http://127.0.0.1:8790/health
docker ps --filter publish=8790 \
  --format '{{.ID}} {{.Names}} {{.Image}} {{.Ports}}'
```

Require exactly one row, an exact `127.0.0.1:8790->8790/tcp` port mapping, identical container ID/name/image/port text, and a healthy Gateway response. Do not run Compose in this worktree.

- [ ] **Step 4: Start the isolated Preview and verify direct product routes**

Run on Linux:

```bash
set -euo pipefail
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
HEADER_DIR="$(mktemp -d /tmp/fai-member-headers.XXXXXX)"
cleanup_headers() {
  find "$HEADER_DIR" -type f -delete
  rmdir "$HEADER_DIR"
}
trap cleanup_headers EXIT
bash scripts/member-preview-down.sh
bash scripts/member-preview-up.sh --with-claim-loss-proxy
curl --silent --show-error --fail http://127.0.0.1:8791/health
curl --silent --show-error --fail \
  --dump-header "$HEADER_DIR/index.headers" \
  --output /dev/null http://127.0.0.1:8791/member/
curl --silent --show-error --fail \
  --dump-header "$HEADER_DIR/entry.headers" \
  --output /dev/null http://127.0.0.1:8791/member/assets/entry.js
curl --silent --show-error --fail \
  --dump-header "$HEADER_DIR/css.headers" \
  --output /dev/null http://127.0.0.1:8791/member/assets/member.css
grep -Eiq '^cache-control:[[:space:]]*no-store' "$HEADER_DIR/index.headers"
grep -Eiq '^cache-control:[[:space:]]*no-store' "$HEADER_DIR/entry.headers"
grep -Eiq '^cache-control:[[:space:]]*no-store' "$HEADER_DIR/css.headers"
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$HEADER_DIR/index.headers"
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$HEADER_DIR/entry.headers"
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$HEADER_DIR/css.headers"
grep -Eiq '^content-security-policy:' "$HEADER_DIR/index.headers"
grep -Eiq '^content-type:[[:space:]]*text/html([;[:space:]]|$)' "$HEADER_DIR/index.headers"
grep -Eiq '^content-type:[[:space:]]*(text|application)/javascript([;[:space:]]|$)' "$HEADER_DIR/entry.headers"
grep -Eiq '^content-type:[[:space:]]*text/css([;[:space:]]|$)' "$HEADER_DIR/css.headers"
ss -ltnp '( sport = :8791 or sport = :8792 )'
stat -c '%a %n' .runtime-preview/config/* .runtime-preview/run/* .runtime-preview/logs/*
```

`member-preview-down.sh` is PID/starttime scoped and may report that no prior
Preview exists; this forced restart binds final evidence to the just-built
HEAD instead of a reusable older process. Require `ss` to show only
`127.0.0.1:8791`/`:8792` and the recorded PIDs. Require index/JS/CSS headers
to contain `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and
the expected content type; require CSP on HTML. Require runtime directories
`0700` and files `0600`. Leave the Preview running for user experience unless
the user asks to stop it.

- [ ] **Step 5: Establish the Mac tunnel without exposing Linux services**

On Mac, run:

```bash
PREVIEW_CONTROL_PATH="/private/tmp/fai-member-preview-${UID}.sock"
MAC_HANDOFF_DIR="/private/tmp/fai-member-preview-${UID}"
if lsof -nP -iTCP:8791 -sTCP:LISTEN; then
  printf 'Mac port 8791 is already in use.\n' >&2
  exit 1
fi
if lsof -nP -iTCP:8792 -sTCP:LISTEN; then
  printf 'Mac port 8792 is already in use.\n' >&2
  exit 1
fi
mkdir -p "$MAC_HANDOFF_DIR"
chmod 700 "$MAC_HANDOFF_DIR"
ssh -fN -M -S "$PREVIEW_CONTROL_PATH" \
  -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8791:127.0.0.1:8791 \
  -L 127.0.0.1:8792:127.0.0.1:8792 \
  admin-yr
```

Both `lsof` checks must produce no listener before tunnel creation; a non-empty result is a blocker, not a process to kill. If the ControlPath already exists, use `ssh -S "$PREVIEW_CONTROL_PATH" -O check admin-yr` to distinguish a live owned tunnel from a stale socket before replacing it. Then verify from Mac:

```bash
curl --silent --show-error --fail http://127.0.0.1:8791/health
curl --silent --show-error --fail http://127.0.0.1:8791/member/ > /dev/null
```

Do not generate or copy a pairing yet; its five-minute lifetime starts only in
Step 8 immediately before the corresponding browser navigation.

After the user finishes both experiences, recompute the path in the cleanup
shell and check ownership before exit:

```bash
PREVIEW_CONTROL_PATH="/private/tmp/fai-member-preview-${UID}.sock"
ssh -S "$PREVIEW_CONTROL_PATH" -O check admin-yr
ssh -S "$PREVIEW_CONTROL_PATH" -O exit admin-yr
```

Keep the tunnel and `0600` Mac handoff files while the user is actively testing; remove the two task-owned temporary files only after they are consumed or the user asks to stop.

- [ ] **Step 6: Run the dynamic five-sentinel secrecy audit**

Run on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
node scripts/member-preview-secret-audit.mjs
npm exec --workspace @family-ai/gateway -- vitest run \
  test/memberSecretBoundary.test.ts
```

The executable audit uses distinct values for:

1. Bootstrap token;
2. Entry token/Cookie;
3. Device Credential;
4. pairing code;
5. full fragment.

Scan final bytes from Gateway/Preview/proxy logs, PublicError JSON, lifecycle/projection BroadcastChannel payloads and ordinary JSON responses. Require no sentinel matches. Exclude only the intended `Set-Cookie` transport and the `0600` handoff files from the corresponding checks.

- [ ] **Step 7: Write non-secret evidence and rollback notes**

The evidence document records:

- branch and commit SHA;
- full and focused test totals;
- typecheck/build results;
- `8790` before/after identity and health comparison;
- `8791`/`8792` loopback listeners and Preview PID files;
- after Step 8, the actual handoff file paths and modes, but not their
  contents;
- five-sentinel audit result;
- the exact user experience checklist below;
- rollback warning: migration 6 databases require a V6-compatible binary; back up SQLite before release and do not start the old V5-only binary against an upgraded database;
- acknowledged data behavior: the unsafe legacy global cache is deleted once and is not recoverable through code rollback.

- [ ] **Step 8: Execute the primary user experience checklist**

Immediately before opening the normal experience, run through
`ssh admin-yr` on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
node scripts/member-preview-pair.mjs --port 8791
```

Then on Mac copy the just-created protected handoff:

```bash
MAC_HANDOFF_DIR="/private/tmp/fai-member-preview-${UID}"
scp -q \
  admin-yr:/home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening/.runtime-preview/config/member-web-url-8791 \
  "$MAC_HANDOFF_DIR/normal.url"
chmod 600 "$MAC_HANDOFF_DIR/normal.url"
```

Use `browser:control-in-app-browser` to read `normal.url` without emitting its
contents to command output and navigate the in-app Browser directly. Do not
use `ssh cat`, command substitution, a URL-bearing `open` command, or paste
the URL into the task transcript. Before Claim, visibly verify
`typeof navigator.locks?.request === "function"` in that same browser origin;
otherwise stop with the supported-browser instruction rather than sending a
Pair or cleanup request.

1. Open the normal pairing handoff and enter the real Member Web.
2. Send one Chat and observe the development Provider reply, explicitly labeled as simulated.
3. Create one Work and send one Work message.
4. Logout, reload, verify no auto-login and only explicit Resume.
5. Resume, verify the same Person/history/draft and create one Work exactly once.
6. Open two tabs, Logout in A, verify B locks; Resume once and verify no renew loop.
7. Through `ssh admin-yr`, `cd` to the approved worktree and run
   `node scripts/member-preview-revoke.mjs --port 8791`; verify every tab
   returns to pairing and old history stays hidden.

Guided advanced experience:

Immediately before this check, generate a fresh advanced Pairing on Linux:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
node scripts/member-preview-pair.mjs --port 8792
```

Then on Mac:

```bash
MAC_HANDOFF_DIR="/private/tmp/fai-member-preview-${UID}"
scp -q \
  admin-yr:/home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening/.runtime-preview/config/member-web-url-8792 \
  "$MAC_HANDOFF_DIR/claim-loss.url"
chmod 600 "$MAC_HANDOFF_DIR/claim-loss.url"
```

Use the browser skill to navigate from the protected file without printing
it.

8. Open the fresh `8792` handoff, let the first Claim response be dropped,
   click retry, enter the workbench and confirm the repository/route evidence
   shows no duplicate Device or Session.

- [ ] **Step 9: Inspect Git state and commit the evidence**

Run on Linux through `ssh admin-yr`:

```bash
cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening
git diff --check
git status --short --branch
git log --oneline --decorate -20
```

The only untracked runtime path may be ignored `.runtime-preview/`. Commit the evidence:

```bash
git add docs/superpowers/evidence/2026-07-25-member-web-entry-hardening.md
git commit -m "docs: verify member web entry hardening"
git status --short --branch
```

Expected: the tracked worktree is clean and Preview remains independently
running. The normal handoff is already open in the in-app Browser; the user
receives only the protected handoff file path/status plus the seven primary
experience points, never the URL contents. The response-loss path is
presented separately as an assisted advanced check.
