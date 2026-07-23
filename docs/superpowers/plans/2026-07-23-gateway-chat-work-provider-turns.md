# Gateway Chat / Work Provider Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 Chat / Work Contracts、iOS 和 Mobile Entry 的前提下，让正式 Chat / Work Thread 调用 Provider、延续独立 Context Session，并可靠写入 Assistant 回复。

**Architecture:** 增加 SQLite Migration V5 保存 Thread Provider Context 与可恢复 Provider Turn；新增 `ChatWorkProviderRepository` 管理持久化状态，新增 `ChatWorkMessageService` 管理同 Thread Lane 和 Provider 调用。现有消息 POST 仍返回 Contracts v1 的 Person message，但请求完成前会同步生成并持久化 Assistant message。

**Tech Stack:** TypeScript 6、Fastify、Zod 4、better-sqlite3、Vitest 4、`@family-ai/contracts`、`@family-ai/provider-adapter-sdk`。

## Global Constraints

- 分支基线固定为 `main` commit `fb83074576793d7d4bf17cc3e31ed8c447a83d8e`。
- 不修改 `clients/ios/**`、`.github/workflows/**` 或 `packages/contracts/**`。
- 不修改 `apps/gateway/src/mobilePairing.ts`、`mobileRoutes.ts`、`entrySessionAuth.ts` 或 `apps/gateway/public/**`。
- Provider 网络调用不得位于 SQLite 事务内。
- 同一 `threadRef` 的 Provider 调用必须有序；不同 Thread 不得共享全局锁。
- Person 消息必须先可靠持久化；Provider 失败不得删除 Person 消息。
- 已成功 Turn 的重试不得再次调用 Provider，也不得重复写入 Assistant 消息。
- HTTP 响应继续使用现有 `sendThreadMessageResponseSchema`，不得添加未定义字段。
- 行为变更必须先增加失败测试并观察 RED，再实现最小 GREEN。

---

## File Map

- Modify: `apps/gateway/src/database.ts` — Migration V5 与版本推进。
- Create: `apps/gateway/src/chatWorkProvider.ts` — Thread Provider Context、Turn 状态和 Assistant 原子提交。
- Create: `apps/gateway/src/chatWorkMessageService.ts` — Thread Lane、Provider 请求和错误映射。
- Modify: `apps/gateway/src/chatWorkRoutes.ts` — 消息 POST 使用新 Service。
- Modify: `apps/gateway/src/app.ts` — 实例化 Provider Repository / Service 并注入路由。
- Modify: `apps/gateway/test/database.test.ts` — Migration V5 Schema 回归。
- Create: `apps/gateway/test/chatWorkProvider.test.ts` — Context、Turn、Assistant、重试、重启和 Lane 集成测试。
- Create: `apps/gateway/test/chatWorkProviderRoutes.test.ts` — HTTP 闭环、错误 envelope 和现有路由兼容测试。

---

### Task 1: Add Migration V5 schema through RED → GREEN

**Files:**
- Modify: `apps/gateway/test/database.test.ts`
- Modify: `apps/gateway/src/database.ts`

**Interfaces:**
- Produces tables `thread_provider_contexts` and `thread_provider_turns`.
- Later tasks depend on schema version `5` and the exact column names below.

- [ ] **Step 1: Update the migration ledger expectation and add the failing V5 table test**

Add version 5:

```ts
const migrationVersions = [
  { version: 1 },
  { version: 2 },
  { version: 3 },
  { version: 4 },
  { version: 5 }
];
```

Add a test that expects both tables and key columns:

```ts
it("creates durable Thread Provider contexts and turns", () => {
  directory = mkdtempSync(join(tmpdir(), "family-ai-provider-turn-schema-"));
  db = openGatewayDatabase(join(directory, "gateway.sqlite"));

  const tables = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN ('thread_provider_contexts', 'thread_provider_turns')
     ORDER BY name`
  ).all();
  expect(tables).toEqual([
    { name: "thread_provider_contexts" },
    { name: "thread_provider_turns" }
  ]);

  const turnColumns = db.prepare("PRAGMA table_info(thread_provider_turns)")
    .all()
    .map((column) => String((column as { name: unknown }).name));
  expect(turnColumns).toEqual([
    "user_message_ref",
    "thread_ref",
    "invocation_ref",
    "correlation_ref",
    "idempotency_key",
    "assignment_ref",
    "agent_ref",
    "provider_profile_ref",
    "status",
    "attempt_count",
    "assistant_message_ref",
    "error_json",
    "requested_at",
    "completed_at"
  ]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
```

- [ ] **Step 2: Run CI and verify RED**

Expected failure: migration ledger returns only versions 1–4 and V5 tables do not exist.

- [ ] **Step 3: Add Migration V5**

Append to `database.ts`:

```ts
const MIGRATION_V5 = `
CREATE TABLE thread_provider_contexts (
  thread_ref TEXT PRIMARY KEY REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  provider_conversation_ref TEXT NOT NULL UNIQUE,
  assignment_ref TEXT NOT NULL REFERENCES assistant_assignments(assignment_ref),
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  external_session_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX thread_provider_context_person_idx
  ON thread_provider_contexts(person_ref, thread_ref);

CREATE TABLE thread_provider_turns (
  user_message_ref TEXT PRIMARY KEY REFERENCES thread_messages(message_ref) ON DELETE CASCADE,
  thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  invocation_ref TEXT NOT NULL UNIQUE,
  correlation_ref TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  assignment_ref TEXT NOT NULL REFERENCES assistant_assignments(assignment_ref),
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  assistant_message_ref TEXT UNIQUE REFERENCES thread_messages(message_ref),
  error_json TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'pending' AND assistant_message_ref IS NULL AND error_json IS NULL AND completed_at IS NULL) OR
    (status = 'succeeded' AND assistant_message_ref IS NOT NULL AND error_json IS NULL AND completed_at IS NOT NULL) OR
    (status = 'failed' AND assistant_message_ref IS NULL AND error_json IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX thread_provider_turns_thread_status_idx
  ON thread_provider_turns(thread_ref, status, requested_at);
`;
```

Update migration bounds from 4 to 5 and add:

```ts
if (latest === 4) {
  db.transaction(() => {
    db.exec(MIGRATION_V5);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)")
      .run(new Date().toISOString());
  })();
  latest = 5;
}
if (latest !== 5) throw new Error(`Unsupported Gateway schema version: ${latest}`);
```

- [ ] **Step 4: Run full quality gate and verify GREEN**

Run: `npm run check`
Expected: all existing tests plus the new migration test pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/database.ts apps/gateway/test/database.test.ts
git commit -m "feat(gateway): add Thread Provider persistence"
```

---

### Task 2: Implement `ChatWorkProviderRepository`

**Files:**
- Create: `apps/gateway/src/chatWorkProvider.ts`
- Create: `apps/gateway/test/chatWorkProvider.test.ts`

**Interfaces:**

```ts
export interface ThreadProviderContext {
  threadRef: string;
  personRef: string;
  providerConversationRef: string;
  assignmentRef: string;
  agentRef: string;
  providerProfileRef: string;
  externalSessionRef: string | null;
}

export interface PreparedProviderTurn {
  userMessageRef: string;
  threadRef: string;
  invocationRef: string;
  correlationRef: string;
  idempotencyKey: string;
  assignmentRef: string;
  agentRef: string;
  providerProfileRef: string;
  providerConversationRef: string;
  externalSessionRef: string | null;
  requestedAt: string;
  status: "pending" | "succeeded";
  attemptCount: number;
  assistantMessageRef: string | null;
}
```

Repository methods:

```ts
resolveContext(personRef: string, threadRef: string): ThreadProviderContext
prepareTurn(input: { personRef: string; userMessage: ThreadMessage }): PreparedProviderTurn
markTurnFailed(input: { userMessageRef: string; error: PublicError; completedAt: string }): void
commitTurnSucceeded(input: {
  personRef: string;
  userMessage: ThreadMessage;
  turn: PreparedProviderTurn;
  output: TextPayload;
  externalSessionRef: string;
  completedAt: string;
}): string
```

- [ ] **Step 1: Add failing repository tests**

Tests must create a real family, Home Chat and Person message, then assert:

```ts
const context = providerRepository.resolveContext(ownerPersonRef, chat.chat.threadRef);
expect(context).toMatchObject({
  personRef: ownerPersonRef,
  assignmentRef: expect.stringMatching(/^assignment:/),
  agentRef: "agent:personal-assistant",
  providerProfileRef: "provider-profile:fake-local",
  externalSessionRef: null
});
expect(context.providerConversationRef).toMatch(/^conversation:/);

const turn = providerRepository.prepareTurn({ personRef: ownerPersonRef, userMessage });
expect(turn).toMatchObject({ status: "pending", attemptCount: 1 });
expect(providerRepository.prepareTurn({ personRef: ownerPersonRef, userMessage }))
  .toMatchObject({ status: "pending", attemptCount: 2 });
```

Add a success-commit assertion that the new Assistant message is sequence 2 and records Assignment, Agent and Provider Profile.

- [ ] **Step 2: Run CI and verify RED**

Expected failure: module `chatWorkProvider.ts` does not exist.

- [ ] **Step 3: Implement context resolution**

Resolve `interaction_threads` ownership and active `assistant_assignments`. Create a stable `conversation:${randomUUID()}` row if absent. If Assignment / Agent / Provider changes, update the row and set `external_session_ref = NULL` while preserving `provider_conversation_ref`.

- [ ] **Step 4: Implement Turn preparation and failure state**

Generate stable Provider material for a new Turn:

```ts
const invocationRef = `invocation:${randomUUID()}`;
const correlationRef = `correlation:${randomUUID()}`;
const idempotencyKey = `thread-turn:${sha256(
  `${input.userMessage.threadRef}:${input.userMessage.messageRef}:${context.assignmentRef}:${context.providerProfileRef}`
).slice(0, 48)}`;
```

A `failed` or crash-left `pending` Turn is reset to `pending` with `attempt_count + 1`. A `succeeded` Turn is returned without mutation.

- [ ] **Step 5: Implement atomic success commit**

Inside one SQLite transaction:

1. re-read the Turn;
2. return the existing Assistant ref if already succeeded;
3. increment `interaction_threads.last_sequence`;
4. insert Assistant `thread_messages` using `client_message_id = assistant:<user_message_ref>`;
5. update an open DailyEpisode when the Thread is Home Chat;
6. update `thread_provider_contexts.external_session_ref`;
7. set Turn to `succeeded` with Assistant ref and completion time.

- [ ] **Step 6: Run full quality gate and verify GREEN**

Run: `npm run check`
Expected: repository tests and all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/chatWorkProvider.ts apps/gateway/test/chatWorkProvider.test.ts
git commit -m "feat(gateway): persist formal Provider turns"
```

---

### Task 3: Implement `ChatWorkMessageService` and Thread lanes

**Files:**
- Create: `apps/gateway/src/chatWorkMessageService.ts`
- Extend: `apps/gateway/test/chatWorkProvider.test.ts`

**Interfaces:**

```ts
export interface SendChatWorkMessageInput {
  personRef: string;
  deviceRef: string;
  threadRef: string;
  clientMessageId: string;
  content: ThreadMessageContent;
  occurredAt: string;
}

export interface SendChatWorkMessageResult {
  message: ThreadMessage;
  assistantMessageRef: string;
  replayedProviderTurn: boolean;
}

export class ChatWorkMessageService {
  constructor(
    domainRepository: ChatWorkDomainRepository,
    providerRepository: ChatWorkProviderRepository,
    providerAdapter: ProviderAdapter,
    now?: () => Date
  );
  sendPersonMessage(input: SendChatWorkMessageInput): Promise<SendChatWorkMessageResult>;
}
```

- [ ] **Step 1: Add failing Fake Provider integration tests**

Verify first call has no `externalSessionRef`, second call on the same Thread includes the first result's session, and a different Work Thread starts at Fake Provider turn 1.

Verify successful replay:

```ts
const first = await service.sendPersonMessage(command);
const repeated = await service.sendPersonMessage(command);
expect(repeated.message).toEqual(first.message);
expect(adapter.calls).toHaveLength(1);
expect(domainRepository.listThreadMessages({ personRef, threadRef }).messages)
  .toHaveLength(2);
```

- [ ] **Step 2: Run CI and verify RED**

Expected failure: service module does not exist.

- [ ] **Step 3: Implement a keyed `ThreadLane`**

Use a `Map<string, Promise<void>>` equivalent to the existing legacy Conversation queue, keyed strictly by `threadRef`. Release and delete each tail in `finally`.

- [ ] **Step 4: Implement Provider request construction**

Within the lane, call `prepareTurn()`. For a succeeded Turn, return without invoking. Otherwise construct and validate:

```ts
const request = providerInvocationRequestSchema.parse({
  protocolVersion: PROTOCOL_VERSION,
  invocationRef: turn.invocationRef,
  correlationRef: turn.correlationRef,
  idempotencyKey: turn.idempotencyKey,
  requestedAt: turn.requestedAt,
  providerProfileRef: turn.providerProfileRef,
  targetAgentRef: turn.agentRef,
  conversationRef: turn.providerConversationRef,
  ...(turn.externalSessionRef ? { externalSessionRef: turn.externalSessionRef } : {}),
  content: [userMessage.content],
  timeoutMs: 30000
});
```

Parse the adapter result with `providerInvocationResultSchema`.

- [ ] **Step 5: Implement success and failure mapping**

Success requires `output[0]` and `externalSessionRef`, then calls `commitTurnSucceeded()`.

For `timed_out`, mark failed and throw 504. For other non-success results, mark failed and throw 502 with the Provider error. Invalid adapter results use:

```ts
new GatewayDomainError(
  "PROVIDER_RESPONSE_INVALID",
  502,
  "internal",
  true,
  "个人助理返回了无法识别的结果。"
)
```

- [ ] **Step 6: Add controlled concurrency tests**

Use a test `ControlledProviderAdapter` whose invocation promises are resolved manually. Assert:

- second call on the same Thread has not reached the adapter until the first completes;
- calls on two different Threads both reach the adapter before either is resolved.

- [ ] **Step 7: Run full quality gate and verify GREEN**

Run: `npm run check`
Expected: all service, lane and existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/chatWorkMessageService.ts apps/gateway/test/chatWorkProvider.test.ts
git commit -m "feat(gateway): run ordered Provider turns"
```

---

### Task 4: Connect the service to HTTP routes

**Files:**
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/src/chatWorkRoutes.ts`
- Create: `apps/gateway/test/chatWorkProviderRoutes.test.ts`

**Interfaces:**
- `registerChatWorkRoutes` receives `messageService: ChatWorkMessageService`.
- Existing route paths and response contracts remain unchanged.

- [ ] **Step 1: Add failing HTTP tests**

Test flow:

```text
onboarding
→ GET /api/v1/chat?timezone=UTC
→ POST Person message
→ response remains the Person message
→ GET Thread messages
→ returns Person sequence 1 + Assistant sequence 2
```

Use an injected `FakeProviderAdapter` and assert its first request uses the authenticated Assistant Assignment / Provider Profile. Add a Work route case to prove Chat and Work Provider sessions are separate.

- [ ] **Step 2: Run CI and verify RED**

Expected failure: current route writes only the Person message and adapter calls remain empty.

- [ ] **Step 3: Instantiate the new components in `app.ts`**

```ts
const chatWorkProviderRepository = new ChatWorkProviderRepository(db, options.now);
const chatWorkMessageService = new ChatWorkMessageService(
  chatWorkRepository,
  chatWorkProviderRepository,
  providerAdapter,
  options.now
);
```

Pass `messageService` into `registerChatWorkRoutes`.

- [ ] **Step 4: Replace direct append in message POST**

Call:

```ts
const result = await input.messageService.sendPersonMessage({
  personRef: context.person.personRef,
  deviceRef: context.device.deviceRef,
  threadRef: params.threadRef,
  clientMessageId: command.clientMessageId,
  content: command.content,
  occurredAt: command.occurredAt
});
```

Continue returning only:

```ts
sendThreadMessageResponseSchema.parse({
  protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
  message: result.message
})
```

- [ ] **Step 5: Run full quality gate and verify GREEN**

Run: `npm run check`
Expected: new HTTP tests and every existing route test pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/chatWorkRoutes.ts \
  apps/gateway/test/chatWorkProviderRoutes.test.ts
git commit -m "feat(gateway): generate Assistant Thread replies"
```

---

### Task 5: Verify failure retry, restart recovery and compatibility

**Files:**
- Extend: `apps/gateway/test/chatWorkProvider.test.ts`
- Extend: `apps/gateway/test/chatWorkProviderRoutes.test.ts`

- [ ] **Step 1: Add Provider failure retry test**

Use `FakeProviderAdapter({ failNext: true })`:

1. first POST returns 502 and message list has only the Person message;
2. retry the exact body;
3. second POST succeeds without duplicating Person message;
4. final message list has exactly Person + Assistant;
5. adapter calls equal 2.

- [ ] **Step 2: Add restart session continuity test**

After the first successful turn, close the Gateway, reopen the same database with a fresh Fake Provider adapter, send a second message, and assert the new adapter request contains the first adapter's `externalSessionRef`; final output is Fake Provider turn 2.

- [ ] **Step 3: Add invalid Provider response test**

Inject an adapter returning a malformed success without `externalSessionRef`. Expect common unwrapped `PublicError`:

```json
{
  "code": "PROVIDER_RESPONSE_INVALID",
  "category": "internal",
  "retryable": true
}
```

Person message must remain stored.

- [ ] **Step 4: Run targeted and full verification**

Run:

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

Expected: zero failures.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/test/chatWorkProvider.test.ts \
  apps/gateway/test/chatWorkProviderRoutes.test.ts
git commit -m "test(gateway): verify Provider turn recovery"
```

---

### Task 6: Final review, PR #14 conflict scan and PR publication

**Files:**
- Update design/plan only if implementation decisions changed.

- [ ] **Step 1: Review the complete diff against the design**

Confirm no Provider call occurs inside a database transaction, no response contract was extended, and no global Person-wide lock was introduced.

- [ ] **Step 2: Run final fresh verification**

Run: `npm run check`
Expected: exit 0 with all tests, static checks, typechecks and builds passing.

- [ ] **Step 3: Compare changed paths with PR #14**

Expected intersection: empty. Explicitly verify no changes under:

```text
clients/ios/**
.github/workflows/**
packages/contracts/**
```

- [ ] **Step 4: Create a Draft PR, record RED → GREEN evidence, then mark Ready**

PR title:

```text
feat(gateway): generate Chat Work Assistant turns
```

The PR body must list the exact head SHA, CI run, Secret Scan run, changed paths, Provider failure semantics, synchronous limitation and deferred Outbox/SSE work.
