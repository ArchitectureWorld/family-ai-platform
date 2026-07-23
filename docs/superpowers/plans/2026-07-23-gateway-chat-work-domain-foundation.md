# Gateway Chat / Work Domain Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变任何现有 HTTP 行为、不触碰 iOS 和 Mobile Entry v1 的前提下，为正式 Chat / Work 模型建立 SQLite Migration V4 和可独立测试的 `ChatWorkDomainRepository`。

**Architecture:** `database.ts` 只负责 V4 表和数据库级约束；新建 `chatWorkDomain.ts` 负责 Person 所有权、Home Chat、DailyEpisode、Work、Thread Message、Chat→Work 和 Work Progress 的事务规则。外部路由、Provider、Outbox、SSE 和终端 UI 全部留在后续 PR。

**Tech Stack:** Node.js 22.16.0、TypeScript 6、Fastify 5、better-sqlite3 12、Zod 4、Vitest 4、npm workspaces。

## Global Constraints

- 分支基线必须是 `main` 的 `3de270aa26d3fdef4c51c0edf9e2c0b84a1b65d9`。
- 只修改设计中列出的 Gateway、测试和文档文件。
- 不修改 `clients/ios/**`、`.github/workflows/**`、`packages/contracts/**`、`apps/gateway/public/**`。
- 不修改 `apps/gateway/src/app.ts`、Mobile Pairing、Mobile Routes 或 Entry Session Auth。
- 不改变现有 Foundation `/api/v1/conversations`、Family onboarding 和 Mobile Entry 行为。
- 所有行为变更先提交失败测试并观察 RED，再提交最小实现并观察 GREEN。
- 所有数据库写入使用短事务；不得在事务内调用 Provider。
- 原始消息文本不得 trim、标准化或重写。
- `thread_sequence` 从 1 开始并在同一 Thread 内严格递增。
- 同一个逻辑消息键是 `thread_ref + client_message_id`。
- CI 和 Secret Scan 通过之前，PR 保持 Draft。

---

## File Map

- Modify: `apps/gateway/src/database.ts` — 增加 Migration V4，并把支持的最新 Schema 版本提升到 4。
- Create: `apps/gateway/src/chatWorkDomain.ts` — Chat / Work 领域类型、映射、事务和仓储方法。
- Modify: `apps/gateway/test/database.test.ts` — V4 migration、索引、约束和重启测试。
- Create: `apps/gateway/test/chatWorkDomain.test.ts` — Home Chat、Work、Message、转换、快照、隔离和恢复测试。
- Create: `docs/superpowers/specs/2026-07-23-gateway-chat-work-domain-foundation-design.md` — 已批准设计。
- Create: `docs/superpowers/plans/2026-07-23-gateway-chat-work-domain-foundation.md` — 本实施计划。

---

### Task 1: Add Migration V4 with database-level invariants

**Files:**
- Modify: `apps/gateway/test/database.test.ts`
- Modify: `apps/gateway/src/database.ts`

**Interfaces:**
- Consumes: `openGatewayDatabase(databasePath)` and existing migrations V1–V3.
- Produces: Schema version 4 and tables consumed by `ChatWorkDomainRepository`.

- [ ] **Step 1: Update the expected migration ledger and add a failing V4 schema test**

Add `4` to `migrationVersions` and add a test that checks the exact V4 tables, critical indexes, and foreign-key integrity:

```ts
const migrationVersions = [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }];

it("creates the formal Chat Work domain schema with thread-scoped uniqueness", () => {
  directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-chat-work-schema-"));
  db = openGatewayDatabase(join(directory, "gateway.sqlite"));

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'interaction_threads',
         'home_chat_streams',
         'daily_episodes',
         'work_conversations',
         'thread_messages',
         'chat_work_conversions',
         'chat_work_conversion_messages',
         'work_progress_snapshots'
       ) ORDER BY name`
    )
    .all()
    .map((row) => String((row as { name: unknown }).name));

  expect(tables).toEqual([
    "chat_work_conversion_messages",
    "chat_work_conversions",
    "daily_episodes",
    "home_chat_streams",
    "interaction_threads",
    "thread_messages",
    "work_conversations",
    "work_progress_snapshots"
  ]);

  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name IN (
         'person_active_home_chat_idx',
         'home_chat_open_episode_idx',
         'thread_messages_sequence_idx',
         'thread_messages_client_id_idx'
       ) ORDER BY name`
    )
    .all()
    .map((row) => String((row as { name: unknown }).name));

  expect(indexes).toEqual([
    "home_chat_open_episode_idx",
    "person_active_home_chat_idx",
    "thread_messages_client_id_idx",
    "thread_messages_sequence_idx"
  ]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
```

- [ ] **Step 2: Run the Gateway database test and observe RED**

Run:

```bash
npm run test -w @family-ai/gateway -- database.test.ts
```

Expected: FAIL because the ledger still ends at version 3 and V4 tables do not exist.

- [ ] **Step 3: Add `MIGRATION_V4` to `database.ts`**

Add the following migration after `MIGRATION_V3`:

```ts
const MIGRATION_V4 = `
CREATE TABLE interaction_threads (
  thread_ref TEXT PRIMARY KEY,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  thread_kind TEXT NOT NULL CHECK (thread_kind IN ('home_chat', 'work')),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);
CREATE INDEX interaction_threads_person_kind_active_idx
  ON interaction_threads(person_ref, thread_kind, last_active_at DESC);

CREATE TABLE home_chat_streams (
  home_chat_stream_ref TEXT PRIMARY KEY,
  thread_ref TEXT NOT NULL UNIQUE REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended'))
);
CREATE UNIQUE INDEX person_active_home_chat_idx
  ON home_chat_streams(person_ref) WHERE status = 'active';

CREATE TABLE daily_episodes (
  daily_episode_ref TEXT PRIMARY KEY,
  home_chat_stream_ref TEXT NOT NULL REFERENCES home_chat_streams(home_chat_stream_ref) ON DELETE CASCADE,
  thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  boundary_reason TEXT NOT NULL CHECK (
    boundary_reason IN ('initial', 'local_day', 'inactive_gap', 'manual_correction')
  ),
  archive_status TEXT NOT NULL CHECK (archive_status IN ('open', 'pending', 'archived', 'failed')),
  archive_version INTEGER NOT NULL CHECK (archive_version >= 0),
  last_message_sequence INTEGER NOT NULL CHECK (last_message_sequence >= 0),
  CHECK (archive_status <> 'open' OR ended_at IS NULL),
  CHECK (archive_status <> 'archived' OR (ended_at IS NOT NULL AND archive_version >= 1))
);
CREATE UNIQUE INDEX home_chat_open_episode_idx
  ON daily_episodes(home_chat_stream_ref) WHERE archive_status = 'open';
CREATE INDEX daily_episodes_thread_sequence_idx
  ON daily_episodes(thread_ref, last_message_sequence);

CREATE TABLE work_conversations (
  work_conversation_ref TEXT PRIMARY KEY,
  thread_ref TEXT NOT NULL UNIQUE REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN ('active', 'paused', 'waiting_confirmation', 'completed', 'archived')
  ),
  archived_at TEXT,
  CHECK (
    (status = 'archived' AND archived_at IS NOT NULL) OR
    (status <> 'archived' AND archived_at IS NULL)
  )
);
CREATE INDEX work_conversations_person_status_idx
  ON work_conversations(person_ref, status, work_conversation_ref);

CREATE TABLE thread_messages (
  message_ref TEXT PRIMARY KEY,
  thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  thread_sequence INTEGER NOT NULL CHECK (thread_sequence > 0),
  client_message_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('person', 'assistant', 'agent', 'system')),
  actor_person_ref TEXT REFERENCES persons(person_ref),
  actor_assignment_ref TEXT,
  actor_agent_ref TEXT REFERENCES agents(agent_ref),
  actor_provider_profile_ref TEXT REFERENCES provider_profiles(provider_profile_ref),
  actor_system_ref TEXT,
  origin_device_ref TEXT REFERENCES managed_devices(device_ref),
  origin_connection_ref TEXT,
  entry_audience TEXT NOT NULL CHECK (entry_audience IN ('personal', 'family_admin', 'system')),
  content_type TEXT NOT NULL CHECK (content_type = 'text'),
  content_text TEXT NOT NULL CHECK (length(content_text) > 0),
  content_language TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (actor_type = 'person' AND actor_person_ref IS NOT NULL AND origin_device_ref IS NOT NULL
      AND actor_assignment_ref IS NULL AND actor_agent_ref IS NULL
      AND actor_provider_profile_ref IS NULL AND actor_system_ref IS NULL) OR
    (actor_type = 'assistant' AND actor_person_ref IS NULL AND actor_assignment_ref IS NOT NULL
      AND actor_agent_ref IS NOT NULL AND actor_provider_profile_ref IS NOT NULL
      AND actor_system_ref IS NULL) OR
    (actor_type = 'agent' AND actor_person_ref IS NULL AND actor_assignment_ref IS NULL
      AND actor_agent_ref IS NOT NULL AND actor_provider_profile_ref IS NOT NULL
      AND actor_system_ref IS NULL) OR
    (actor_type = 'system' AND actor_person_ref IS NULL AND actor_assignment_ref IS NULL
      AND actor_agent_ref IS NULL AND actor_provider_profile_ref IS NULL
      AND actor_system_ref IS NOT NULL AND entry_audience = 'system')
  )
);
CREATE UNIQUE INDEX thread_messages_sequence_idx
  ON thread_messages(thread_ref, thread_sequence);
CREATE UNIQUE INDEX thread_messages_client_id_idx
  ON thread_messages(thread_ref, client_message_id);
CREATE INDEX thread_messages_page_idx
  ON thread_messages(thread_ref, thread_sequence DESC);

CREATE TABLE chat_work_conversions (
  conversion_ref TEXT PRIMARY KEY,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  home_chat_stream_ref TEXT NOT NULL REFERENCES home_chat_streams(home_chat_stream_ref),
  daily_episode_ref TEXT REFERENCES daily_episodes(daily_episode_ref),
  work_conversation_ref TEXT NOT NULL UNIQUE REFERENCES work_conversations(work_conversation_ref) ON DELETE CASCADE,
  decisions_json TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE chat_work_conversion_messages (
  conversion_ref TEXT NOT NULL REFERENCES chat_work_conversions(conversion_ref) ON DELETE CASCADE,
  message_ref TEXT NOT NULL REFERENCES thread_messages(message_ref),
  source_order INTEGER NOT NULL CHECK (source_order >= 0),
  PRIMARY KEY (conversion_ref, message_ref),
  UNIQUE (conversion_ref, source_order)
);

CREATE TABLE work_progress_snapshots (
  work_conversation_ref TEXT PRIMARY KEY REFERENCES work_conversations(work_conversation_ref) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'paused', 'waiting_confirmation', 'completed', 'archived')
  ),
  phase_summary TEXT NOT NULL,
  incomplete_tasks_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  pending_confirmations_json TEXT NOT NULL,
  deadlines_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
```

Update the migration runner:

```ts
if (latest > 4 || latest < 1) {
  throw new Error(`Unsupported Gateway schema version: ${latest}`);
}
// existing V2 and V3 branches remain unchanged
if (latest === 3) {
  db.transaction(() => {
    db.exec(MIGRATION_V4);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)").run(
      new Date().toISOString()
    );
  })();
  latest = 4;
}
if (latest !== 4) {
  throw new Error(`Unsupported Gateway schema version: ${latest}`);
}
```

- [ ] **Step 4: Run database tests and verify GREEN**

Run:

```bash
npm run test -w @family-ai/gateway -- database.test.ts
```

Expected: PASS with V1–V4 applied once and no foreign-key violations.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/gateway/src/database.ts apps/gateway/test/database.test.ts
git commit -m "feat(gateway): add Chat Work schema migration"
```

---

### Task 2: Implement Home Chat and Work ownership

**Files:**
- Create: `apps/gateway/test/chatWorkDomain.test.ts`
- Create: `apps/gateway/src/chatWorkDomain.ts`

**Interfaces:**
- Consumes: `GatewayDatabase`, `GatewayDomainError`, and Contracts types `HomeChatStream`, `DailyEpisode`, `WorkConversation`.
- Produces:

```ts
class ChatWorkDomainRepository {
  ensureHomeChat(input: { personRef: string; timezone: string; localDate?: string }): HomeChatRecord;
  getHomeChat(personRef: string): HomeChatRecord | null;
  createWorkConversation(input: { personRef: string; title: string; goal: string }): WorkConversation;
  getWorkConversation(personRef: string, workConversationRef: string): WorkConversation | null;
  listWorkConversations(personRef: string): WorkConversation[];
}

type HomeChatRecord = { chat: HomeChatStream; currentEpisode: DailyEpisode | null };
```

- [ ] **Step 1: Add shared test setup and failing Home Chat / Work tests**

Create `chatWorkDomain.test.ts` with a real temporary SQLite database. Initialize one family owner and one additional adult through `FamilyDomainRepository`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const fixedNow = new Date("2026-07-23T12:00:00.000Z");

describe("Chat Work domain ownership", () => {
  let directory = "";
  let databasePath = "";
  let db: GatewayDatabase;
  let repository: ChatWorkDomainRepository;
  let ownerPersonRef = "";
  let adultPersonRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-"));
    databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    const familyRepository = new FamilyDomainRepository(db);
    const onboarding = familyRepository.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "test-device-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    adultPersonRef = familyRepository.createMember({
      familyRef: onboarding.family.familyRef,
      displayName: "另一位成人",
      familyRole: "adult"
    }).personRef;
    repository = new ChatWorkDomainRepository(db, () => fixedNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates one durable Home Chat and one open initial DailyEpisode per Person", () => {
    const first = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "America/Los_Angeles",
      localDate: "2026-07-23"
    });
    const repeated = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "Asia/Shanghai",
      localDate: "2026-07-24"
    });

    expect(repeated).toEqual(first);
    expect(first.chat.threadKind).toBe("home_chat");
    expect(first.chat.personRef).toBe(ownerPersonRef);
    expect(first.chat.currentEpisodeRef).toBe(first.currentEpisode?.dailyEpisodeRef);
    expect(first.currentEpisode).toMatchObject({
      threadRef: first.chat.threadRef,
      homeChatStreamRef: first.chat.homeChatStreamRef,
      localDate: "2026-07-23",
      timezone: "America/Los_Angeles",
      archiveStatus: "open",
      archiveVersion: 0,
      lastMessageSequence: 0
    });
  });

  it("keeps Home Chat and Work ownership isolated by Person", () => {
    const ownerChat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const adultChat = repository.ensureHomeChat({
      personRef: adultPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const ownerWork = repository.createWorkConversation({
      personRef: ownerPersonRef,
      title: "家庭 AI 平台",
      goal: "建立正式 Chat / Work 领域底座"
    });
    const secondOwnerWork = repository.createWorkConversation({
      personRef: ownerPersonRef,
      title: "另一个事项",
      goal: "验证多个 Work 相互隔离"
    });

    expect(ownerChat.chat.threadRef).not.toBe(adultChat.chat.threadRef);
    expect(repository.getWorkConversation(adultPersonRef, ownerWork.workConversationRef)).toBeNull();
    expect(repository.listWorkConversations(ownerPersonRef).map((item) => item.workConversationRef))
      .toEqual([secondOwnerWork.workConversationRef, ownerWork.workConversationRef]);
  });
});
```

- [ ] **Step 2: Run the new test and observe RED**

Run:

```bash
npm run test -w @family-ai/gateway -- chatWorkDomain.test.ts
```

Expected: FAIL because `chatWorkDomain.ts` and `ChatWorkDomainRepository` do not exist.

- [ ] **Step 3: Implement the repository skeleton and ownership mappings**

Create `chatWorkDomain.ts` with imports and stable types:

```ts
import { randomUUID } from "node:crypto";
import type {
  DailyEpisode,
  HomeChatStream,
  ThreadActor,
  ThreadMessage,
  ThreadMessageContent,
  ThreadMessageOrigin,
  WorkConversation,
  WorkProgressSnapshot
} from "@family-ai/contracts";
import type { GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";

export interface HomeChatRecord {
  chat: HomeChatStream;
  currentEpisode: DailyEpisode | null;
}

function requirePerson(db: GatewayDatabase, personRef: string): void {
  const row = db.prepare(
    "SELECT 1 FROM persons WHERE person_ref = ? AND status = 'active'"
  ).get(personRef);
  if (!row) {
    throw new GatewayDomainError(
      "PERSON_NOT_FOUND",
      404,
      "permission",
      false,
      "没有找到这个家庭成员。"
    );
  }
}
```

Implement row mappers that return Contracts-shaped camelCase objects. Implement `ensureHomeChat` in one transaction:

```ts
ensureHomeChat(input: { personRef: string; timezone: string; localDate?: string }): HomeChatRecord {
  const existing = this.getHomeChat(input.personRef);
  if (existing) return existing;

  requirePerson(this.db, input.personRef);
  const now = this.now().toISOString();
  const localDate = input.localDate ?? now.slice(0, 10);
  const threadRef = `thread:${randomUUID()}`;
  const homeChatStreamRef = `home-chat:${randomUUID()}`;
  const dailyEpisodeRef = `daily-episode:${randomUUID()}`;

  this.db.transaction(() => {
    this.db.prepare(
      `INSERT INTO interaction_threads
       (thread_ref, person_ref, thread_kind, last_sequence, created_at, last_active_at)
       VALUES(?, ?, 'home_chat', 0, ?, ?)`
    ).run(threadRef, input.personRef, now, now);
    this.db.prepare(
      `INSERT INTO home_chat_streams
       (home_chat_stream_ref, thread_ref, person_ref, status)
       VALUES(?, ?, ?, 'active')`
    ).run(homeChatStreamRef, threadRef, input.personRef);
    this.db.prepare(
      `INSERT INTO daily_episodes
       (daily_episode_ref, home_chat_stream_ref, thread_ref, local_date, timezone,
        started_at, ended_at, boundary_reason, archive_status, archive_version,
        last_message_sequence)
       VALUES(?, ?, ?, ?, ?, ?, NULL, 'initial', 'open', 0, 0)`
    ).run(dailyEpisodeRef, homeChatStreamRef, threadRef, localDate, input.timezone, now);
  })();

  return this.getHomeChat(input.personRef)!;
}
```

Implement `createWorkConversation`, `getWorkConversation`, and `listWorkConversations` with one thread row per Work and no Project dependency.

- [ ] **Step 4: Run Home Chat / Work tests and verify GREEN**

Run:

```bash
npm run test -w @family-ai/gateway -- chatWorkDomain.test.ts
```

Expected: PASS for the two ownership tests.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/gateway/src/chatWorkDomain.ts apps/gateway/test/chatWorkDomain.test.ts
git commit -m "feat(gateway): add Home Chat and Work repository"
```

---

### Task 3: Add ordered messages, logical idempotency, and pagination

**Files:**
- Modify: `apps/gateway/test/chatWorkDomain.test.ts`
- Modify: `apps/gateway/src/chatWorkDomain.ts`

**Interfaces:**
- Consumes: Home Chat and Work methods from Task 2.
- Produces:

```ts
appendThreadMessage(input: {
  personRef: string;
  threadRef: string;
  clientMessageId: string;
  actor: ThreadActor;
  origin: ThreadMessageOrigin;
  content: ThreadMessageContent;
  occurredAt: string;
}): ThreadMessage;

listThreadMessages(input: {
  personRef: string;
  threadRef: string;
  beforeSequence?: number;
  limit?: number;
}): {
  threadRef: string;
  messages: ThreadMessage[];
  nextBeforeSequence: number | null;
};
```

- [ ] **Step 1: Add failing message behavior tests**

Append tests that verify sequence, exact text preservation, duplicate handling, conflict, ownership, and pagination:

```ts
it("allocates stable sequences and preserves raw text", () => {
  const chat = repository.ensureHomeChat({
    personRef: ownerPersonRef,
    timezone: "UTC",
    localDate: "2026-07-23"
  });
  const first = repository.appendThreadMessage({
    personRef: ownerPersonRef,
    threadRef: chat.chat.threadRef,
    clientMessageId: "owner-chat-0001",
    actor: { type: "person", personRef: ownerPersonRef },
    origin: {
      deviceRef: "device:test-origin",
      connectionRef: "connection:web-1",
      entryAudience: "personal"
    },
    content: { type: "text", text: "  保留两侧空格。  ", language: "zh-CN" },
    occurredAt: "2026-07-23T12:00:00.000Z"
  });
  const repeated = repository.appendThreadMessage({
    personRef: ownerPersonRef,
    threadRef: chat.chat.threadRef,
    clientMessageId: "owner-chat-0001",
    actor: { type: "person", personRef: ownerPersonRef },
    origin: {
      deviceRef: "device:test-origin",
      connectionRef: "connection:web-1",
      entryAudience: "personal"
    },
    content: { type: "text", text: "  保留两侧空格。  ", language: "zh-CN" },
    occurredAt: "2026-07-23T12:00:00.000Z"
  });

  expect(first.threadSequence).toBe(1);
  expect(first.content.text).toBe("  保留两侧空格。  ");
  expect(repeated).toEqual(first);
  expect(repository.getHomeChat(ownerPersonRef)?.currentEpisode?.lastMessageSequence).toBe(1);
});

it("rejects a reused client message ID with different content", () => {
  // create the first message as above
  expect(() => repository.appendThreadMessage({
    ...sameIdentity,
    content: { type: "text", text: "不同内容" }
  })).toThrowError(expect.objectContaining({ code: "THREAD_MESSAGE_CONFLICT" }));
});

it("keeps message pages ordered and inaccessible to another Person", () => {
  // append five messages with client IDs owner-chat-0001 through owner-chat-0005
  const latest = repository.listThreadMessages({
    personRef: ownerPersonRef,
    threadRef: chat.chat.threadRef,
    limit: 2
  });
  expect(latest.messages.map((message) => message.threadSequence)).toEqual([4, 5]);
  expect(latest.nextBeforeSequence).toBe(4);

  const older = repository.listThreadMessages({
    personRef: ownerPersonRef,
    threadRef: chat.chat.threadRef,
    beforeSequence: latest.nextBeforeSequence!,
    limit: 2
  });
  expect(older.messages.map((message) => message.threadSequence)).toEqual([2, 3]);
  expect(older.nextBeforeSequence).toBe(2);

  expect(() => repository.listThreadMessages({
    personRef: adultPersonRef,
    threadRef: chat.chat.threadRef
  })).toThrowError(expect.objectContaining({ code: "THREAD_NOT_FOUND" }));
});
```

Before creating Person messages, insert the test origin device into `managed_devices` and `device_bindings`, or use the onboarding device reference returned from `initializeFamily`. Keep the real onboarding `deviceRef` in test setup and use it as `origin.deviceRef`.

- [ ] **Step 2: Run tests and observe RED**

Run:

```bash
npm run test -w @family-ai/gateway -- chatWorkDomain.test.ts
```

Expected: FAIL because message methods do not exist.

- [ ] **Step 3: Implement exact-message fingerprinting and row mapping**

Use a stable fingerprint of the client-supplied logical message fields:

```ts
function logicalMessageFingerprint(input: {
  actor: ThreadActor;
  origin: ThreadMessageOrigin;
  content: ThreadMessageContent;
  occurredAt: string;
}): string {
  return JSON.stringify({
    actor: input.actor,
    origin: input.origin,
    content: input.content,
    occurredAt: input.occurredAt
  });
}
```

Map actor columns according to the discriminated union and reconstruct the same shape on reads. Never trim `content.text`.

- [ ] **Step 4: Implement transactional sequence allocation and idempotency**

Within one SQLite transaction:

```ts
const existing = this.findMessageByClientId(input.threadRef, input.clientMessageId);
if (existing) {
  if (logicalMessageFingerprint(existing) !== logicalMessageFingerprint(input)) {
    throw new GatewayDomainError(
      "THREAD_MESSAGE_CONFLICT",
      409,
      "conflict",
      false,
      "同一个客户端消息编号已经用于不同内容。"
    );
  }
  return existing;
}

const now = this.now().toISOString();
const sequenceRow = this.db.prepare(
  `UPDATE interaction_threads
   SET last_sequence = last_sequence + 1, last_active_at = ?
   WHERE thread_ref = ? AND person_ref = ?
   RETURNING last_sequence`
).get(now, input.threadRef, input.personRef) as { last_sequence: number } | undefined;

if (!sequenceRow) throw threadNotFound();
```

Insert the message using `sequenceRow.last_sequence`. If the Thread is a Home Chat, update the unique open DailyEpisode:

```sql
UPDATE daily_episodes
SET last_message_sequence = ?
WHERE thread_ref = ? AND archive_status = 'open'
```

- [ ] **Step 5: Implement ascending pagination**

Query newest rows first for efficient paging, then reverse before returning:

```ts
const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
const rows = input.beforeSequence
  ? statementBefore.all(input.threadRef, input.beforeSequence, limit + 1)
  : statementLatest.all(input.threadRef, limit + 1);
const hasMore = rows.length > limit;
const selected = rows.slice(0, limit).reverse().map(mapThreadMessage);
return {
  threadRef: input.threadRef,
  messages: selected,
  nextBeforeSequence: hasMore && selected.length > 0 ? selected[0]!.threadSequence : null
};
```

- [ ] **Step 6: Run tests and verify GREEN**

Run:

```bash
npm run test -w @family-ai/gateway -- chatWorkDomain.test.ts
```

Expected: PASS for ownership and message tests.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/gateway/src/chatWorkDomain.ts apps/gateway/test/chatWorkDomain.test.ts
git commit -m "feat(gateway): persist ordered Chat Work messages"
```

---

### Task 4: Add Chat to Work conversion, progress snapshot, and restart recovery

**Files:**
- Modify: `apps/gateway/test/chatWorkDomain.test.ts`
- Modify: `apps/gateway/src/chatWorkDomain.ts`

**Interfaces:**
- Consumes: Work creation and Thread Message methods.
- Produces:

```ts
createWorkFromChat(input: {
  personRef: string;
  title: string;
  goal: string;
  source: {
    homeChatStreamRef: string;
    dailyEpisodeRef: string | null;
    messageRefs: string[];
  };
  decisions: string[];
  openQuestions: string[];
}): {
  conversation: WorkConversation;
  conversion: ChatWorkConversion;
};

getChatWorkConversion(personRef: string, conversionRef: string): ChatWorkConversionRecord | null;

saveWorkProgressSnapshot(input: {
  personRef: string;
  snapshot: WorkProgressSnapshot;
}): WorkProgressSnapshot;

getWorkProgressSnapshot(
  personRef: string,
  workConversationRef: string
): WorkProgressSnapshot | null;
```

`ChatWorkConversionRecord` extends the public conversion with `decisions` and `openQuestions` for internal verification.

- [ ] **Step 1: Add failing conversion and atomicity tests**

```ts
it("creates a Work from Chat references without copying message bodies", () => {
  const chat = repository.ensureHomeChat({
    personRef: ownerPersonRef,
    timezone: "UTC",
    localDate: "2026-07-23"
  });
  const first = appendOwnerMessage(chat.chat.threadRef, "owner-chat-0001", "第一个来源消息");
  const second = appendOwnerMessage(chat.chat.threadRef, "owner-chat-0002", "第二个来源消息");

  const result = repository.createWorkFromChat({
    personRef: ownerPersonRef,
    title: "正式领域底座",
    goal: "把 Chat 讨论转为独立 Work",
    source: {
      homeChatStreamRef: chat.chat.homeChatStreamRef,
      dailyEpisodeRef: chat.currentEpisode!.dailyEpisodeRef,
      messageRefs: [first.messageRef, second.messageRef]
    },
    decisions: ["先稳定 Gateway 领域模型"],
    openQuestions: ["何时加入 SSE"]
  });

  expect(result.conversation.threadKind).toBe("work");
  expect(result.conversion).toMatchObject({
    homeChatStreamRef: chat.chat.homeChatStreamRef,
    dailyEpisodeRef: chat.currentEpisode!.dailyEpisodeRef,
    sourceMessageRefs: [first.messageRef, second.messageRef],
    workConversationRef: result.conversation.workConversationRef
  });
  const stored = repository.getChatWorkConversion(ownerPersonRef, result.conversion.conversionRef);
  expect(stored).toMatchObject({
    decisions: ["先稳定 Gateway 领域模型"],
    openQuestions: ["何时加入 SSE"]
  });
  expect(JSON.stringify(stored)).not.toContain("第一个来源消息");
});

it("rolls back the Work when any Chat source reference is invalid", () => {
  const before = repository.listWorkConversations(ownerPersonRef).length;
  expect(() => repository.createWorkFromChat({
    personRef: ownerPersonRef,
    title: "不应保存",
    goal: "验证事务回滚",
    source: {
      homeChatStreamRef: chat.chat.homeChatStreamRef,
      dailyEpisodeRef: chat.currentEpisode!.dailyEpisodeRef,
      messageRefs: [validMessage.messageRef, "message:not-in-this-chat"]
    },
    decisions: [],
    openQuestions: []
  })).toThrowError(expect.objectContaining({ code: "CHAT_SOURCE_INVALID" }));
  expect(repository.listWorkConversations(ownerPersonRef)).toHaveLength(before);
});
```

- [ ] **Step 2: Add failing progress and restart tests**

```ts
it("upserts the latest Work progress and restores the full domain after restart", () => {
  const work = repository.createWorkConversation({
    personRef: ownerPersonRef,
    title: "持续事项",
    goal: "验证状态恢复"
  });
  const snapshot = repository.saveWorkProgressSnapshot({
    personRef: ownerPersonRef,
    snapshot: {
      workConversationRef: work.workConversationRef,
      status: "active",
      phaseSummary: "完成领域模型设计",
      incompleteTasks: ["实现 HTTP 路由"],
      risks: ["不能影响 PR #14"],
      pendingConfirmations: [],
      deadlines: [{ label: "完成 Gateway 底座", dueAt: "2026-07-24T12:00:00.000Z" }],
      updatedAt: "2026-07-23T13:00:00.000Z"
    }
  });
  expect(repository.getWorkProgressSnapshot(ownerPersonRef, work.workConversationRef)).toEqual(snapshot);

  db.close();
  db = openGatewayDatabase(databasePath);
  repository = new ChatWorkDomainRepository(db, () => fixedNow);

  expect(repository.getWorkConversation(ownerPersonRef, work.workConversationRef)).toEqual(work);
  expect(repository.getWorkProgressSnapshot(ownerPersonRef, work.workConversationRef)).toEqual(snapshot);
});
```

- [ ] **Step 3: Run tests and observe RED**

Run:

```bash
npm run test -w @family-ai/gateway -- chatWorkDomain.test.ts
```

Expected: FAIL because conversion and progress methods do not exist.

- [ ] **Step 4: Implement conversion in one transaction**

Validate before any insert:

1. active Home Chat belongs to `personRef`;
2. optional DailyEpisode belongs to that Home Chat;
3. source message refs are non-empty and unique;
4. every source message belongs to the Home Chat Thread.

Then call a private `insertWorkConversation` inside the same transaction, insert the conversion row and ordered message references, and return the public conversion shape.

Use JSON only for structured arrays that are not independently queried:

```ts
JSON.stringify(input.decisions)
JSON.stringify(input.openQuestions)
```

Do not store source message text in conversion tables.

- [ ] **Step 5: Implement progress snapshot upsert**

Verify Work ownership, then execute:

```sql
INSERT INTO work_progress_snapshots
(work_conversation_ref, status, phase_summary, incomplete_tasks_json, risks_json,
 pending_confirmations_json, deadlines_json, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(work_conversation_ref) DO UPDATE SET
  status = excluded.status,
  phase_summary = excluded.phase_summary,
  incomplete_tasks_json = excluded.incomplete_tasks_json,
  risks_json = excluded.risks_json,
  pending_confirmations_json = excluded.pending_confirmations_json,
  deadlines_json = excluded.deadlines_json,
  updated_at = excluded.updated_at
```

Parse arrays back into Contracts-shaped `WorkProgressSnapshot` on read.

- [ ] **Step 6: Run all Gateway tests and verify GREEN**

Run:

```bash
npm run test -w @family-ai/gateway
```

Expected: all Gateway tests pass, including pre-existing Foundation, onboarding and mobile tests.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/gateway/src/chatWorkDomain.ts apps/gateway/test/chatWorkDomain.test.ts
git commit -m "feat(gateway): add Chat to Work persistence"
```

---

### Task 5: Full verification, path isolation, and Draft PR

**Files:**
- No production file changes unless verification exposes a defect.
- Update only the PR body after checks complete.

**Interfaces:**
- Consumes: complete Tasks 1–4.
- Produces: a reviewable Draft PR with evidence and zero path overlap with PR #14.

- [ ] **Step 1: Run targeted test, typecheck, and build**

```bash
npm run test -w @family-ai/gateway -- database.test.ts chatWorkDomain.test.ts
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the repository quality gate**

```bash
npm run check
```

Expected: all workspace tests, static checks, typechecks and builds exit 0.

- [ ] **Step 3: Compare changed paths against PR #14**

Expected current PR paths:

```text
apps/gateway/src/database.ts
apps/gateway/src/chatWorkDomain.ts
apps/gateway/test/database.test.ts
apps/gateway/test/chatWorkDomain.test.ts
docs/superpowers/specs/2026-07-23-gateway-chat-work-domain-foundation-design.md
docs/superpowers/plans/2026-07-23-gateway-chat-work-domain-foundation.md
```

PR #14 paths are restricted to:

```text
.github/workflows/ios-ci.yml
clients/ios/**
```

The intersection must be empty.

- [ ] **Step 4: Open a Draft PR to `main`**

Use title:

```text
feat(gateway): establish Chat Work domain foundation
```

The PR body must state:

- exact base and head SHAs;
- repository-only scope, with no HTTP routes;
- explicit PR #14 non-conflict boundary;
- observed RED → GREEN cycles;
- migration and domain invariants;
- CI and Secret Scan results;
- deferred HTTP, Provider, SSE, Web and iOS work.

- [ ] **Step 5: Keep the PR Draft until all checks are successful**

Do not merge automatically. Do not update PR #14. Do not rebase or force-push PR #14.
