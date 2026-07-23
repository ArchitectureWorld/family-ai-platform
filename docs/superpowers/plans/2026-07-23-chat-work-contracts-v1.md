# Chat / Work Contracts v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 Gateway、iOS 和 Mobile Entry v1 的前提下，为 Home Chat、Work、Thread Message、Chat 转 Work 和 Work 进度快照建立严格、可版本化的公共协议。

**Architecture:** 新增独立 `chatWork.ts` 模块，领域实体不携带重复协议版本，请求和响应 envelope 统一携带 `CHAT_WORK_PROTOCOL_VERSION = 1`。客户端命令只描述意图，不接受 Person、Agent、Device 或 Origin 等可信身份字段；服务端 read model 保存完整来源事实。

**Tech Stack:** TypeScript 6、Zod 4、Vitest 4、npm workspaces。

## Global Constraints

- 分支必须从最新 `main` 创建并直接向 `main` 提交 PR。
- 不修改 `clients/ios/**`、`apps/gateway/**`、`.github/workflows/**`。
- 不修改 `packages/contracts/src/mobileEntry.ts` 和 `packages/contracts/fixtures/mobile-entry/**`。
- 所有公开对象使用 `.strict()`。
- 请求和响应 envelope 必须携带整数协议版本 `1`。
- 客户端命令不能接受 `personRef`、`agentRef`、`deviceRef`、`connectionRef` 或 `origin`。
- 第一版消息内容只支持文本。
- 不在本 PR 引入 SSE、Outbox、Sync Cursor、附件、Execution 或 Gateway 路由。
- 行为变更先增加失败测试，再实现最小代码。

---

## File Map

- Create: `packages/contracts/src/chatWork.ts` — Chat / Work v1 的全部 Zod schema、约束和 TypeScript 类型。
- Modify: `packages/contracts/src/index.ts` — 从包根导出 `chatWork.ts`，不改变现有导出。
- Create: `packages/contracts/test/chatWork.test.ts` — fixture 解析、严格字段、身份边界和跨字段约束测试。
- Create: `packages/contracts/fixtures/chat-work/home-chat-response.json` — HomeChatStream 与开放 DailyEpisode 规范响应。
- Create: `packages/contracts/fixtures/chat-work/work-list-response.json` — 多个 Work 状态规范响应。
- Create: `packages/contracts/fixtures/chat-work/thread-message-list-response.json` — Person 与 Assistant 文本消息规范响应。
- Create: `packages/contracts/fixtures/chat-work/create-work-request.json` — 最小 Work 创建命令。
- Create: `packages/contracts/fixtures/chat-work/create-work-from-chat-request.json` — Chat 转 Work 结构化命令。
- Create: `packages/contracts/fixtures/chat-work/work-progress-response.json` — Work 回流 Chat 的阶段快照。

---

### Task 1: Add canonical fixtures and failing read-model tests

**Files:**
- Create: `packages/contracts/fixtures/chat-work/home-chat-response.json`
- Create: `packages/contracts/fixtures/chat-work/work-list-response.json`
- Create: `packages/contracts/fixtures/chat-work/thread-message-list-response.json`
- Create: `packages/contracts/test/chatWork.test.ts`

**Interfaces:**
- Consumes: package root exports from `../src/index.js`.
- Produces: failing tests naming `homeChatStreamResponseSchema`, `workConversationListResponseSchema`, and `threadMessageListResponseSchema` before those exports exist.

- [ ] **Step 1: Add canonical Home Chat fixture**

```json
{
  "protocolVersion": 1,
  "chat": {
    "threadRef": "thread:home-alice",
    "threadKind": "home_chat",
    "personRef": "person:alice",
    "lastSequence": 2,
    "createdAt": "2026-07-23T08:00:00.000Z",
    "lastActiveAt": "2026-07-23T08:02:00.000Z",
    "homeChatStreamRef": "home-chat:alice",
    "status": "active",
    "currentEpisodeRef": "daily-episode:alice-2026-07-23"
  },
  "currentEpisode": {
    "dailyEpisodeRef": "daily-episode:alice-2026-07-23",
    "homeChatStreamRef": "home-chat:alice",
    "threadRef": "thread:home-alice",
    "localDate": "2026-07-23",
    "timezone": "America/Los_Angeles",
    "startedAt": "2026-07-23T08:00:00.000Z",
    "endedAt": null,
    "boundaryReason": "initial",
    "archiveStatus": "open",
    "archiveVersion": 0,
    "lastMessageSequence": 2
  }
}
```

- [ ] **Step 2: Add canonical Work list fixture**

Use two conversations so both active and archived invariants are covered:

```json
{
  "protocolVersion": 1,
  "conversations": [
    {
      "threadRef": "thread:work-family-ai",
      "threadKind": "work",
      "personRef": "person:alice",
      "lastSequence": 4,
      "createdAt": "2026-07-23T09:00:00.000Z",
      "lastActiveAt": "2026-07-23T09:10:00.000Z",
      "workConversationRef": "work:family-ai-platform",
      "title": "家庭 AI 平台",
      "goal": "完成 Chat 与 Work 的统一协议。",
      "summary": "协议设计已确认。",
      "status": "active",
      "archivedAt": null
    },
    {
      "threadRef": "thread:work-finished",
      "threadKind": "work",
      "personRef": "person:alice",
      "lastSequence": 8,
      "createdAt": "2026-07-20T09:00:00.000Z",
      "lastActiveAt": "2026-07-22T09:10:00.000Z",
      "workConversationRef": "work:finished-example",
      "title": "已完成事项",
      "goal": "验证归档约束。",
      "summary": "事项已经归档。",
      "status": "archived",
      "archivedAt": "2026-07-22T09:10:00.000Z"
    }
  ]
}
```

- [ ] **Step 3: Add canonical message-list fixture**

Include one Person message with a device origin and one Assistant message without a device origin. Both messages use strictly increasing `threadSequence`.

- [ ] **Step 4: Write failing fixture tests**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  homeChatStreamResponseSchema,
  threadMessageListResponseSchema,
  workConversationListResponseSchema
} from "../src/index.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/chat-work/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Chat / Work protocol v1 read models", () => {
  it("accepts canonical read-model fixtures", () => {
    homeChatStreamResponseSchema.parse(fixture("home-chat-response.json"));
    workConversationListResponseSchema.parse(fixture("work-list-response.json"));
    threadMessageListResponseSchema.parse(fixture("thread-message-list-response.json"));
  });
});
```

- [ ] **Step 5: Run the focused test and verify it fails**

Run:

```bash
npm run test -w @family-ai/contracts -- chatWork.test.ts
```

Expected: FAIL because the three Chat / Work schemas are not exported.

- [ ] **Step 6: Commit the failing tests and fixtures**

```bash
git add packages/contracts/fixtures/chat-work packages/contracts/test/chatWork.test.ts
git commit -m "test(contracts): define Chat Work v1 fixtures"
```

---

### Task 2: Implement thread, Chat, Episode, Work, and Message read models

**Files:**
- Create: `packages/contracts/src/chatWork.ts`

**Interfaces:**
- Consumes: Zod only; no dependency on `mobileEntry.ts`.
- Produces: `interactionThreadSchema`, `homeChatStreamSchema`, `dailyEpisodeSchema`, `workConversationSchema`, `threadMessageSchema`, and the three read-response schemas used by Task 1.

- [ ] **Step 1: Add protocol, private identity refs, and public Thread refs**

```ts
import { z } from "zod";

export const CHAT_WORK_PROTOCOL_VERSION = 1 as const;

const protocolVersionSchema = z.literal(CHAT_WORK_PROTOCOL_VERSION);
const timestampSchema = z.string().datetime({ offset: true });
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timezoneSchema = z.string().trim().min(1).max(80);
const clientMessageIdSchema = z.string().trim().min(8).max(128);

function refSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`));
}

const personRefSchema = refSchema("person");
const assignmentRefSchema = refSchema("assignment");
const agentRefSchema = refSchema("agent");
const deviceRefSchema = refSchema("device");
const connectionRefSchema = refSchema("connection");
const systemRefSchema = refSchema("system");
const messageRefSchema = refSchema("message");

export const interactionThreadRefSchema = refSchema("thread");
export const homeChatStreamRefSchema = refSchema("home-chat");
export const dailyEpisodeRefSchema = refSchema("daily-episode");
export const workConversationRefSchema = refSchema("work");
export const chatWorkConversionRefSchema = refSchema("chat-work-conversion");
```

- [ ] **Step 2: Implement InteractionThread and HomeChatStream**

```ts
export const interactionThreadSchema = z.object({
  threadRef: interactionThreadRefSchema,
  threadKind: z.enum(["home_chat", "work"]),
  personRef: personRefSchema,
  lastSequence: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  lastActiveAt: timestampSchema
}).strict();

export const homeChatStreamSchema = interactionThreadSchema.extend({
  threadKind: z.literal("home_chat"),
  homeChatStreamRef: homeChatStreamRefSchema,
  status: z.enum(["active", "suspended"]),
  currentEpisodeRef: dailyEpisodeRefSchema.nullable()
}).strict();
```

- [ ] **Step 3: Implement DailyEpisode with archive invariants**

Create the strict object, then add `superRefine` so open episodes cannot have `endedAt`, and archived episodes require both `endedAt` and `archiveVersion >= 1`.

- [ ] **Step 4: Implement WorkConversation with archived-state invariants**

Create `workConversationStatusSchema` and a strict Work object extending `interactionThreadSchema`. Use `superRefine` to require `archivedAt` exactly when status is `archived`.

- [ ] **Step 5: Implement text content, actor, origin, and message invariants**

```ts
export const threadMessageContentSchema = z.object({
  type: z.literal("text"),
  text: z.string().trim().min(1).max(12000),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).optional()
}).strict();

export const threadActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), personRef: personRefSchema }).strict(),
  z.object({
    type: z.literal("assistant"),
    assignmentRef: assignmentRefSchema,
    agentRef: agentRefSchema
  }).strict(),
  z.object({ type: z.literal("agent"), agentRef: agentRefSchema }).strict(),
  z.object({ type: z.literal("system"), systemRef: systemRefSchema }).strict()
]);

export const threadMessageOriginSchema = z.object({
  deviceRef: deviceRefSchema.nullable(),
  connectionRef: connectionRefSchema.nullable(),
  entryAudience: z.enum(["personal", "family_admin", "system"])
}).strict();
```

Add `threadMessageSchema.superRefine` rules:

- `actor.type === "person"` requires non-null `origin.deviceRef`;
- `actor.type === "system"` requires `origin.entryAudience === "system"`.

- [ ] **Step 6: Implement read response envelopes**

```ts
export const homeChatStreamResponseSchema = z.object({
  protocolVersion: protocolVersionSchema,
  chat: homeChatStreamSchema,
  currentEpisode: dailyEpisodeSchema.nullable()
}).strict();

export const workConversationListResponseSchema = z.object({
  protocolVersion: protocolVersionSchema,
  conversations: z.array(workConversationSchema).max(500)
}).strict();

export const threadMessageListResponseSchema = z.object({
  protocolVersion: protocolVersionSchema,
  threadRef: interactionThreadRefSchema,
  messages: z.array(threadMessageSchema).max(200),
  nextBeforeSequence: z.number().int().positive().nullable()
}).strict();
```

- [ ] **Step 7: Run the focused test**

Run:

```bash
npm run test -w @family-ai/contracts -- chatWork.test.ts
```

Expected: the fixture test still fails only because `index.ts` has not exported the new module.

- [ ] **Step 8: Commit read models**

```bash
git add packages/contracts/src/chatWork.ts
git commit -m "feat(contracts): add Chat Work read models"
```

---

### Task 3: Add command and conversion tests before implementations

**Files:**
- Create: `packages/contracts/fixtures/chat-work/create-work-request.json`
- Create: `packages/contracts/fixtures/chat-work/create-work-from-chat-request.json`
- Create: `packages/contracts/fixtures/chat-work/work-progress-response.json`
- Modify: `packages/contracts/test/chatWork.test.ts`

**Interfaces:**
- Consumes: read model refs and status schemas from Task 2.
- Produces: failing tests for Work commands, message commands, Chat-to-Work conversion, Work progress, strict unknown-field rejection, and cross-field rules.

- [ ] **Step 1: Add the three command/progress fixtures**

`create-work-request.json`:

```json
{
  "protocolVersion": 1,
  "title": "家庭 AI 平台",
  "goal": "完成 Chat 与 Work 的统一协议。"
}
```

`create-work-from-chat-request.json`:

```json
{
  "protocolVersion": 1,
  "title": "家庭 AI 平台",
  "goal": "把已确认的协议讨论转为独立 Work。",
  "source": {
    "homeChatStreamRef": "home-chat:alice",
    "dailyEpisodeRef": "daily-episode:alice-2026-07-23",
    "messageRefs": [
      "message:chat-0001",
      "message:chat-0002"
    ]
  },
  "decisions": ["Chat 与 Work 保持独立生命周期。"],
  "openQuestions": ["何时加入同步 Cursor？"]
}
```

`work-progress-response.json` must contain status `active`, a non-empty phase summary, one incomplete task, one risk, one pending confirmation, and one UTC deadline.

- [ ] **Step 2: Extend tests with canonical command parsing**

Import all command and progress schemas and parse the new fixtures.

- [ ] **Step 3: Add strict identity-boundary tests**

For each request below, spread a valid fixture and inject one forbidden field; every parse must fail:

```ts
{ ...createWork, personRef: "person:alice" }
{ ...createWork, agentRef: "agent:personal-assistant" }
{ ...createWork, deviceRef: "device:web" }
{ ...sendMessage, origin: { deviceRef: "device:web" } }
```

- [ ] **Step 4: Add invariant tests**

Test all of the following:

- open DailyEpisode with an `endedAt` is rejected;
- archived DailyEpisode without `endedAt` is rejected;
- archived Work without `archivedAt` is rejected;
- active Work with `archivedAt` is rejected;
- Person message with null `deviceRef` is rejected;
- System message using `personal` audience is rejected;
- Chat-to-Work request with duplicate `messageRefs` is rejected;
- unsupported `protocolVersion: 2` is rejected;
- an unknown `databaseId` field is rejected.

- [ ] **Step 5: Run focused tests and verify failure**

Run:

```bash
npm run test -w @family-ai/contracts -- chatWork.test.ts
```

Expected: FAIL because command, conversion, and progress schemas are not implemented or exported.

- [ ] **Step 6: Commit failing command tests**

```bash
git add packages/contracts/fixtures/chat-work packages/contracts/test/chatWork.test.ts
git commit -m "test(contracts): cover Chat Work commands and invariants"
```

---

### Task 4: Implement commands, Chat-to-Work conversion, progress snapshots, and type exports

**Files:**
- Modify: `packages/contracts/src/chatWork.ts`

**Interfaces:**
- Consumes: Task 2 refs, message content, Work schema, and Work status.
- Produces: all request/response schemas named in the design and their `z.infer` TypeScript types.

- [ ] **Step 1: Implement Work create request and response**

The request contains only `protocolVersion`, `title`, and `goal`. The response contains `protocolVersion` and `conversation`.

- [ ] **Step 2: Implement message send request and response**

The request contains only `protocolVersion`, `clientMessageId`, `occurredAt`, and `content`. The response contains the persisted `threadMessageSchema` object.

- [ ] **Step 3: Implement Chat-to-Work request with unique message refs**

Build a strict request object and use `superRefine`:

```ts
const refs = value.source.messageRefs;
if (new Set(refs).size !== refs.length) {
  context.addIssue({
    code: "custom",
    path: ["source", "messageRefs"],
    message: "source messageRefs must be unique"
  });
}
```

- [ ] **Step 4: Implement conversion read model and response**

The conversion object contains `conversionRef`, source Chat/Episode refs, the unique source message refs, target Work ref, and `createdAt`. The response returns both `conversation` and `conversion`.

- [ ] **Step 5: Implement Work progress snapshot and response**

Use strict arrays capped at 100 entries, deadline objects with `label` and `dueAt`, and a non-empty `phaseSummary` capped at 4000 characters.

- [ ] **Step 6: Export exact inferred types**

Export `z.infer` types for every public schema, including:

```text
InteractionThread
HomeChatStream
DailyEpisode
WorkConversationStatus
WorkConversation
ThreadMessageContent
ThreadActor
ThreadMessageOrigin
ThreadMessage
HomeChatStreamResponse
WorkConversationListResponse
CreateWorkConversationRequest
CreateWorkConversationResponse
ThreadMessageListResponse
SendThreadMessageRequest
SendThreadMessageResponse
CreateWorkFromChatRequest
ChatWorkConversion
CreateWorkFromChatResponse
WorkProgressSnapshot
WorkProgressSnapshotResponse
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm run test -w @family-ai/contracts -- chatWork.test.ts
```

Expected: tests still cannot import the module from the package root until Task 5.

- [ ] **Step 8: Commit command schemas**

```bash
git add packages/contracts/src/chatWork.ts
git commit -m "feat(contracts): add Chat Work commands and conversions"
```

---

### Task 5: Export the module and verify backward compatibility

**Files:**
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: all exports from `chatWork.ts`.
- Produces: stable package-root imports for Gateway, Web, iOS, and tests.

- [ ] **Step 1: Add the root export without changing existing exports**

Append exactly:

```ts
export * from "./chatWork.js";
```

Keep the existing Mobile Entry export present.

- [ ] **Step 2: Run focused tests**

```bash
npm run test -w @family-ai/contracts -- chatWork.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run all Contracts tests**

```bash
npm run test -w @family-ai/contracts
```

Expected: existing `contracts.test.ts`, `mobileEntry.test.ts`, and new `chatWork.test.ts` all pass.

- [ ] **Step 4: Run Contracts typecheck and build**

```bash
npm run typecheck -w @family-ai/contracts
npm run build -w @family-ai/contracts
```

Expected: both commands exit `0`.

- [ ] **Step 5: Commit the public export**

```bash
git add packages/contracts/src/index.ts
git commit -m "feat(contracts): export Chat Work protocol v1"
```

---

### Task 6: Full verification, conflict guard, and Draft PR

**Files:**
- No source changes expected unless verification reveals a defect.

**Interfaces:**
- Consumes: completed branch.
- Produces: CI-backed Draft PR targeting `main` with an explicit non-conflict statement.

- [ ] **Step 1: Run the repository quality gate**

```bash
npm run check
```

Expected: tests, static checks, typecheck, and build all pass.

- [ ] **Step 2: Verify changed paths**

```bash
git diff --name-only main...HEAD
```

Expected paths are limited to the File Map. The command must not output `clients/ios/`, `apps/gateway/`, `.github/workflows/`, `packages/contracts/src/mobileEntry.ts`, or `packages/contracts/fixtures/mobile-entry/`.

- [ ] **Step 3: Rebase conflict check against current main**

```bash
git fetch origin main
git rebase origin/main
npm run check
```

Expected: rebase completes without conflicts and the full gate remains green.

- [ ] **Step 4: Open a Draft PR**

Title:

```text
feat(contracts): establish Chat Work protocol v1
```

The PR body must state:

- scope is Contracts and design/plan docs only;
- no Gateway, iOS, Mobile Entry, acceptance-console, or workflow files changed;
- Chat and Work remain separate domain objects over shared Thread infrastructure;
- client commands cannot assert Person, Agent, Device, or Origin;
- verification commands and CI results;
- next PR will implement the Gateway domain foundation after this contract merges.

- [ ] **Step 5: Compare the Draft PR file list with every open PR**

Confirm there is no overlapping changed path. If an overlap appears after the PR is opened, stop and re-scope before requesting review.