# Gateway Chat / Work HTTP Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已合并的 Chat / Work Contracts v1 和 Gateway 领域仓储增加受个人 Entry Session 保护的正式 HTTP API，同时保持 Provider、SSE、Web、iOS 和 PR #14 完全独立。

**Architecture:** 新增独立 `chatWorkRoutes.ts`，只负责 Entry Session 认证、严格请求解析、服务端身份与来源构造、Repository 调用和 Contracts 响应校验。`app.ts` 仅作为组合根创建 `ChatWorkDomainRepository`、注入统一时钟并注册路由；所有数据继续由 SQLite 和 PR #16 的 Repository 权威管理。

**Tech Stack:** Node.js 22.16.0、TypeScript 6、Fastify 5、Zod 4、Vitest 4、better-sqlite3、npm workspaces。

## Global Constraints

- 分支固定为 `feat/gateway-chat-work-http-routes`，基线固定为 `12452bd59973884ddbe4b933fd6a45cbfbf5a53d`。
- 不修改 `clients/ios/**`、`.github/workflows/**`、`packages/contracts/**`。
- 不修改 `apps/gateway/src/database.ts`、`apps/gateway/src/chatWorkDomain.ts`、`apps/gateway/src/entrySessionAuth.ts`、移动配对代码或 `apps/gateway/public/**`。
- 所有新路由必须使用 personal Entry Session；客户端不能提交 Person、Device、Agent、Actor、Origin 或 Connection 等可信字段。
- 请求 body 必须使用已合并 Contracts v1 严格 Schema；响应发送前必须再次通过 Contracts Schema。
- 消息原始文本不得 trim、归一化或改写。
- 本 PR 不调用 Provider，不生成 Assistant 回复，不增加 Outbox、SSE、Sync Cursor、附件、Execution、Web 或 iOS UI。
- Chat / Work 错误使用现有通用 `PublicError`，不修改 Mobile Entry 错误 envelope。
- 行为变更必须先增加失败测试并观察 RED，再写最小实现。
- 最终 PR 与 PR #14 的变更路径交集必须为零。

---

## File Map

- Create: `apps/gateway/src/chatWorkRoutes.ts` — Chat / Work HTTP 路由、时区日期计算、严格请求与响应映射。
- Modify: `apps/gateway/src/app.ts` — 创建 Repository、注入 `now` 时钟并注册路由。
- Create: `apps/gateway/test/chatWorkRoutes.test.ts` — Home Chat、Work、消息、转换、进度和重启恢复集成测试。
- Create: `apps/gateway/test/chatWorkRoutesSecurity.test.ts` — Entry Session、audience、伪造字段、跨 Person、撤销和错误 envelope 测试。
- Existing, unchanged: `apps/gateway/src/chatWorkDomain.ts` — 路由调用的领域 API。
- Existing, unchanged: `packages/contracts/src/chatWork.ts` — 请求和响应的公共协议权威。

---

### Task 1: Add the failing Home Chat route tests

**Files:**
- Create: `apps/gateway/test/chatWorkRoutes.test.ts`
- Create: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`

**Interfaces:**
- Consumes: `buildGatewayApp(options)`、现有 onboarding API、personal/admin Entry Session。
- Produces: 对 `GET /api/v1/chat`、IANA 时区、个人 audience 和通用 PublicError 的失败测试。

- [ ] **Step 1: Add the shared route-test fixture and Home Chat tests**

Create `apps/gateway/test/chatWorkRoutes.test.ts` with:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "chat-work-routes-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
  agentRef: string;
}

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

describe("Chat Work HTTP routes", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let currentNow = new Date("2026-07-24T06:30:00.000Z");
  let admin: EntryCredential;
  let personal: EntryCredential;
  let ownerPersonRef = "";
  let ownerDeviceRef = "";

  async function openApp() {
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      now: () => currentNow
    });
  }

  async function initialize() {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      owner: { personRef: string };
      device: { deviceRef: string };
      entries: { admin: EntryCredential; personal: EntryCredential };
    };
    admin = body.entries.admin;
    personal = body.entries.personal;
    ownerPersonRef = body.owner.personRef;
    ownerDeviceRef = body.device.deviceRef;
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-routes-"));
    databasePath = join(directory, "gateway.sqlite");
    await openApp();
    await initialize();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates one Home Chat using the authenticated Person and server-derived local date", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=America%2FLos_Angeles",
      headers: entryHeaders(personal)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      chat: {
        threadKind: "home_chat",
        personRef: ownerPersonRef,
        status: "active",
        lastSequence: 0
      },
      currentEpisode: {
        localDate: "2026-07-23",
        timezone: "America/Los_Angeles",
        archiveStatus: "open",
        lastMessageSequence: 0
      }
    });
    expect(response.body).not.toContain(personal.token);
    expect(ownerDeviceRef).toMatch(/^device:/);

    const repeated = await app.inject({
      method: "GET",
      url: "/api/v1/chat",
      headers: entryHeaders(personal)
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(response.json());
  });

  it("requires a valid IANA timezone only when Home Chat does not exist", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/chat",
      headers: entryHeaders(personal)
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      code: "REQUEST_INVALID",
      category: "validation",
      retryable: false
    });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=Not%2FA-Timezone",
      headers: entryHeaders(personal)
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "REQUEST_INVALID" });
  });
});
```

- [ ] **Step 2: Add Home Chat authentication and error-envelope tests**

Create `apps/gateway/test/chatWorkRoutesSecurity.test.ts` with:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "chat-work-security-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
}

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function expectPublicError(
  response: { json(): unknown },
  expected: { code: string; category: string; retryable: boolean }
) {
  const body = response.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    ...expected,
    message: expect.any(String)
  });
  expect(body).not.toHaveProperty("error");
  expect(body).not.toHaveProperty("protocolVersion");
}

describe("Chat Work HTTP route security", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: EntryCredential;
  let personal: EntryCredential;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-route-security-"));
    databasePath = join(directory, "gateway.sqlite");
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-24T06:30:00.000Z")
    });
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    const body = onboarding.json() as {
      entries: { admin: EntryCredential; personal: EntryCredential };
    };
    admin = body.entries.admin;
    personal = body.entries.personal;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires a personal Entry Session and keeps Chat Work errors in PublicError form", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC"
    });
    expect(missing.statusCode).toBe(401);
    expectPublicError(missing, {
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      retryable: false
    });

    const adminResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(admin)
    });
    expect(adminResponse.statusCode).toBe(403);
    expectPublicError(adminResponse, {
      code: "ENTRY_AUDIENCE_FORBIDDEN",
      category: "permission",
      retryable: false
    });

    const valid = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(valid.statusCode).toBe(200);
  });
});
```

- [ ] **Step 3: Run the tests and observe RED**

Run:

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected: FAIL because `BuildGatewayAppOptions` does not accept `now` and `/api/v1/chat` is not registered.

- [ ] **Step 4: Commit the RED tests**

```bash
git add apps/gateway/test/chatWorkRoutes.test.ts apps/gateway/test/chatWorkRoutesSecurity.test.ts
git commit -m "test(gateway): define Home Chat HTTP route behavior"
```

---

### Task 2: Implement Home Chat route and app composition

**Files:**
- Create: `apps/gateway/src/chatWorkRoutes.ts`
- Modify: `apps/gateway/src/app.ts`
- Test: `apps/gateway/test/chatWorkRoutes.test.ts`
- Test: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`

**Interfaces:**
- Consumes: `ChatWorkDomainRepository.getHomeChat()` and `ensureHomeChat()`; `requireEntryRequest()`; Contracts response schemas.
- Produces: `registerChatWorkRoutes(app, { repository, entryAuthenticator, now })` and exported `localDateForTimeZone(date, timeZone)`.

- [ ] **Step 1: Add the route module with Home Chat only**

Create `apps/gateway/src/chatWorkRoutes.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import {
  CHAT_WORK_PROTOCOL_VERSION,
  homeChatStreamResponseSchema
} from "@family-ai/contracts";
import { z } from "zod";
import { ChatWorkDomainRepository } from "./chatWorkDomain.js";
import {
  EntrySessionAuthenticator,
  requireEntryRequest
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

const homeChatQuerySchema = z
  .object({
    timezone: z.string().trim().min(1).max(80).optional()
  })
  .strict();

function invalidRequest(message: string): GatewayDomainError {
  return new GatewayDomainError("REQUEST_INVALID", 400, "validation", false, message);
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest(message);
  return parsed.data;
}

function validatedTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    throw invalidRequest("时区不正确。");
  }
}

export function localDateForTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
      .map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function registerChatWorkRoutes(
  app: FastifyInstance,
  input: {
    repository: ChatWorkDomainRepository;
    entryAuthenticator: EntrySessionAuthenticator;
    now?: () => Date;
  }
): void {
  const now = input.now ?? (() => new Date());

  app.get("/api/v1/chat", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const query = parseRequest(
      homeChatQuerySchema,
      request.query,
      "Chat 查询参数不正确。"
    );
    const timeZone = query.timezone ? validatedTimeZone(query.timezone) : null;
    let record = input.repository.getHomeChat(context.person.personRef);
    if (!record) {
      if (!timeZone) {
        throw invalidRequest("首次打开 Chat 需要提供有效时区。");
      }
      record = input.repository.ensureHomeChat({
        personRef: context.person.personRef,
        timezone: timeZone,
        localDate: localDateForTimeZone(now(), timeZone)
      });
    }
    return homeChatStreamResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      ...record
    });
  });
}
```

- [ ] **Step 2: Wire the repository and shared clock into `app.ts`**

Modify `apps/gateway/src/app.ts`:

```ts
import { ChatWorkDomainRepository } from "./chatWorkDomain.js";
import { registerChatWorkRoutes } from "./chatWorkRoutes.js";
```

Extend `BuildGatewayAppOptions`:

```ts
export interface BuildGatewayAppOptions {
  databasePath: string;
  deviceToken: string;
  mode: GatewayMode;
  providerAdapter?: ProviderAdapter;
  bootstrap?: Partial<Omit<DevelopmentBootstrapInput, "deviceToken">>;
  now?: () => Date;
}
```

Inside `buildGatewayApp`, add:

```ts
const now = options.now ?? (() => new Date());
```

Replace:

```ts
const entryAuthenticator = new EntrySessionAuthenticator(db, familyRepository);
```

with:

```ts
const entryAuthenticator = new EntrySessionAuthenticator(db, familyRepository, now);
const chatWorkRepository = new ChatWorkDomainRepository(db, now);
```

After `registerMobileRoutes(...)`, register:

```ts
registerChatWorkRoutes(app, {
  repository: chatWorkRepository,
  entryAuthenticator,
  now
});
```

- [ ] **Step 3: Run Home Chat tests and observe GREEN**

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected: PASS for all current tests.

- [ ] **Step 4: Run the complete Gateway suite**

```bash
npm run test -w @family-ai/gateway
```

Expected: PASS with no regressions in onboarding, mobile pairing, Foundation messages, restart recovery or acceptance-console tests.

- [ ] **Step 5: Commit Home Chat route**

```bash
git add apps/gateway/src/chatWorkRoutes.ts apps/gateway/src/app.ts
git commit -m "feat(gateway): expose authenticated Home Chat route"
```

---

### Task 3: Add Work list and creation routes

**Files:**
- Modify: `apps/gateway/test/chatWorkRoutes.test.ts`
- Modify: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`
- Modify: `apps/gateway/src/chatWorkRoutes.ts`

**Interfaces:**
- Consumes: `createWorkConversationRequestSchema`, `createWorkConversationResponseSchema`, `workConversationListResponseSchema`.
- Produces: `GET /api/v1/work-conversations` and `POST /api/v1/work-conversations`.

- [ ] **Step 1: Add failing Work route tests**

Append to `apps/gateway/test/chatWorkRoutes.test.ts` inside the existing `describe`:

```ts
it("creates and lists only the authenticated Person's Work Conversations", async () => {
  const initial = await app.inject({
    method: "GET",
    url: "/api/v1/work-conversations",
    headers: entryHeaders(personal)
  });
  expect(initial.statusCode).toBe(200);
  expect(initial.json()).toEqual({ protocolVersion: 1, conversations: [] });

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/work-conversations",
    headers: entryHeaders(personal),
    payload: {
      protocolVersion: 1,
      title: "家庭 AI 平台",
      goal: "建立正式 Web 与多端共用的 Work"
    }
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({
    protocolVersion: 1,
    conversation: {
      threadKind: "work",
      personRef: ownerPersonRef,
      title: "家庭 AI 平台",
      goal: "建立正式 Web 与多端共用的 Work",
      status: "active",
      summary: "",
      archivedAt: null
    }
  });

  const listed = await app.inject({
    method: "GET",
    url: "/api/v1/work-conversations",
    headers: entryHeaders(personal)
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().conversations).toEqual([created.json().conversation]);
});
```

Append to `apps/gateway/test/chatWorkRoutesSecurity.test.ts`:

```ts
it("rejects forged identity fields and unsupported Work protocol versions", async () => {
  for (const payload of [
    {
      protocolVersion: 1,
      title: "伪造 Work",
      goal: "不允许客户端指定 Person",
      personRef: "person:forged"
    },
    {
      protocolVersion: 1,
      title: "伪造 Work",
      goal: "不允许客户端指定 Agent",
      agentRef: "agent:forged"
    },
    {
      protocolVersion: 2,
      title: "错误版本",
      goal: "必须拒绝"
    }
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(personal),
      payload
    });
    expect(response.statusCode).toBe(400);
    expectPublicError(response, {
      code: "REQUEST_INVALID",
      category: "validation",
      retryable: false
    });
  }
});
```

- [ ] **Step 2: Run Work tests and observe RED**

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected: FAIL with HTTP 404 for Work routes.

- [ ] **Step 3: Implement Work routes**

Add imports in `apps/gateway/src/chatWorkRoutes.ts`:

```ts
import {
  CHAT_WORK_PROTOCOL_VERSION,
  createWorkConversationRequestSchema,
  createWorkConversationResponseSchema,
  homeChatStreamResponseSchema,
  workConversationListResponseSchema
} from "@family-ai/contracts";
```

Add inside `registerChatWorkRoutes`:

```ts
app.get("/api/v1/work-conversations", async (request) => {
  const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
  return workConversationListResponseSchema.parse({
    protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
    conversations: input.repository.listWorkConversations(context.person.personRef)
  });
});

app.post("/api/v1/work-conversations", async (request, reply) => {
  const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
  const command = parseRequest(
    createWorkConversationRequestSchema,
    request.body,
    "Work 标题、目标或协议版本不正确。"
  );
  const conversation = input.repository.createWorkConversation({
    personRef: context.person.personRef,
    title: command.title,
    goal: command.goal
  });
  return reply.code(201).send(createWorkConversationResponseSchema.parse({
    protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
    conversation
  }));
});
```

- [ ] **Step 4: Verify Work routes GREEN**

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Work routes**

```bash
git add apps/gateway/src/chatWorkRoutes.ts apps/gateway/test/chatWorkRoutes.test.ts apps/gateway/test/chatWorkRoutesSecurity.test.ts
git commit -m "feat(gateway): expose Work list and creation routes"
```

---

### Task 4: Add Thread message write, replay and pagination routes

**Files:**
- Modify: `apps/gateway/test/chatWorkRoutes.test.ts`
- Modify: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`
- Modify: `apps/gateway/src/chatWorkRoutes.ts`

**Interfaces:**
- Consumes: `interactionThreadRefSchema`, `sendThreadMessageRequestSchema`, `sendThreadMessageResponseSchema`, `threadMessageListResponseSchema`.
- Produces: `GET /api/v1/threads/:threadRef/messages` and `POST /api/v1/threads/:threadRef/messages`.

- [ ] **Step 1: Add failing message lifecycle tests**

Append to `apps/gateway/test/chatWorkRoutes.test.ts`:

```ts
it("persists Person messages, replays retries and returns ascending pages", async () => {
  const chatResponse = await app.inject({
    method: "GET",
    url: "/api/v1/chat?timezone=UTC",
    headers: entryHeaders(personal)
  });
  const chat = chatResponse.json().chat as { threadRef: string };

  const firstPayload = {
    protocolVersion: 1,
    clientMessageId: "web-owner-message-0001",
    occurredAt: "2026-07-24T06:31:00.000Z",
    content: {
      type: "text",
      text: "  保留消息两侧空格。  ",
      language: "zh-CN"
    }
  };
  const first = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
    headers: entryHeaders(personal),
    payload: firstPayload
  });
  expect(first.statusCode).toBe(201);
  expect(first.json()).toMatchObject({
    protocolVersion: 1,
    message: {
      threadRef: chat.threadRef,
      threadSequence: 1,
      clientMessageId: firstPayload.clientMessageId,
      actor: { type: "person", personRef: ownerPersonRef },
      origin: {
        deviceRef: ownerDeviceRef,
        connectionRef: null,
        entryAudience: "personal"
      },
      content: firstPayload.content
    }
  });

  const replay = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
    headers: entryHeaders(personal),
    payload: firstPayload
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(first.json());

  const conflict = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
    headers: entryHeaders(personal),
    payload: {
      ...firstPayload,
      content: { ...firstPayload.content, text: "不同内容" }
    }
  });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toMatchObject({ code: "THREAD_MESSAGE_CONFLICT" });

  for (let index = 2; index <= 5; index += 1) {
    currentNow = new Date(`2026-07-24T06:3${index}:00.000Z`);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        clientMessageId: `web-owner-message-${String(index).padStart(4, "0")}`,
        occurredAt: currentNow.toISOString(),
        content: { type: "text", text: `第 ${index} 条消息`, language: "zh-CN" }
      }
    });
    expect(response.statusCode).toBe(201);
  }

  const latest = await app.inject({
    method: "GET",
    url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages?limit=2`,
    headers: entryHeaders(personal)
  });
  expect(latest.statusCode).toBe(200);
  expect(latest.json().messages.map((message: { threadSequence: number }) => message.threadSequence))
    .toEqual([4, 5]);
  expect(latest.json().nextBeforeSequence).toBe(4);

  const older = await app.inject({
    method: "GET",
    url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages?beforeSequence=4&limit=2`,
    headers: entryHeaders(personal)
  });
  expect(older.statusCode).toBe(200);
  expect(older.json().messages.map((message: { threadSequence: number }) => message.threadSequence))
    .toEqual([2, 3]);
});
```

Append to the security test:

```ts
it("rejects client-selected actor, origin, connection and malformed message queries", async () => {
  const chat = await app.inject({
    method: "GET",
    url: "/api/v1/chat?timezone=UTC",
    headers: entryHeaders(personal)
  });
  const threadRef = chat.json().chat.threadRef as string;
  const base = {
    protocolVersion: 1,
    clientMessageId: "security-message-0001",
    occurredAt: "2026-07-24T06:31:00.000Z",
    content: { type: "text", text: "安全测试" }
  };

  for (const forged of [
    { actor: { type: "person", personRef: "person:forged" } },
    { origin: { deviceRef: "device:forged" } },
    { connectionRef: "connection:forged" },
    { deviceRef: "device:forged" }
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: { ...base, ...forged }
    });
    expect(response.statusCode).toBe(400);
    expectPublicError(response, {
      code: "REQUEST_INVALID",
      category: "validation",
      retryable: false
    });
  }

  for (const query of ["limit=0", "limit=201", "beforeSequence=0", "unknown=1"]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages?${query}`,
      headers: entryHeaders(personal)
    });
    expect(response.statusCode).toBe(400);
  }
});
```

- [ ] **Step 2: Run message tests and observe RED**

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected: FAIL with HTTP 404 for Thread message routes.

- [ ] **Step 3: Add strict path and query schemas**

Add imports:

```ts
import {
  CHAT_WORK_PROTOCOL_VERSION,
  createWorkConversationRequestSchema,
  createWorkConversationResponseSchema,
  homeChatStreamResponseSchema,
  interactionThreadRefSchema,
  sendThreadMessageRequestSchema,
  sendThreadMessageResponseSchema,
  threadMessageListResponseSchema,
  workConversationListResponseSchema
} from "@family-ai/contracts";
```

Add schemas:

```ts
const threadParamsSchema = z
  .object({ threadRef: interactionThreadRefSchema })
  .strict();

const threadMessagesQuerySchema = z
  .object({
    beforeSequence: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  })
  .strict();
```

- [ ] **Step 4: Implement message routes**

Add inside `registerChatWorkRoutes`:

```ts
app.get("/api/v1/threads/:threadRef/messages", async (request) => {
  const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
  const params = parseRequest(
    threadParamsSchema,
    request.params,
    "Thread 编号不正确。"
  );
  const query = parseRequest(
    threadMessagesQuerySchema,
    request.query,
    "消息分页参数不正确。"
  );
  const page = input.repository.listThreadMessages({
    personRef: context.person.personRef,
    threadRef: params.threadRef,
    beforeSequence: query.beforeSequence,
    limit: query.limit
  });
  return threadMessageListResponseSchema.parse({
    protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
    ...page
  });
});

app.post("/api/v1/threads/:threadRef/messages", async (request, reply) => {
  const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
  const params = parseRequest(
    threadParamsSchema,
    request.params,
    "Thread 编号不正确。"
  );
  const command = parseRequest(
    sendThreadMessageRequestSchema,
    request.body,
    "消息内容或协议版本不正确。"
  );
  const message = input.repository.appendThreadMessage({
    personRef: context.person.personRef,
    threadRef: params.threadRef,
    clientMessageId: command.clientMessageId,
    actor: {
      type: "person",
      personRef: context.person.personRef
    },
    origin: {
      deviceRef: context.device.deviceRef,
      connectionRef: null,
      entryAudience: "personal"
    },
    content: command.content,
    occurredAt: command.occurredAt
  });
  return reply.code(201).send(sendThreadMessageResponseSchema.parse({
    protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
    message
  }));
});
```

- [ ] **Step 5: Verify message routes GREEN**

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit message routes**

```bash
git add apps/gateway/src/chatWorkRoutes.ts apps/gateway/test/chatWorkRoutes.test.ts apps/gateway/test/chatWorkRoutesSecurity.test.ts
git commit -m "feat(gateway): expose ordered Thread message routes"
```

---

### Task 5: Add Chat-to-Work and Work progress read routes

**Files:**
- Modify: `apps/gateway/test/chatWorkRoutes.test.ts`
- Modify: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`
- Modify: `apps/gateway/src/chatWorkRoutes.ts`

**Interfaces:**
- Consumes: `createWorkFromChatRequestSchema`, `createWorkFromChatResponseSchema`, `workConversationRefSchema`, `workProgressSnapshotResponseSchema`.
- Produces: `POST /api/v1/chat/work-conversions` and `GET /api/v1/work-conversations/:workConversationRef/progress`.

- [ ] **Step 1: Add failing conversion and progress tests**

Append to `apps/gateway/test/chatWorkRoutes.test.ts`:

```ts
it("converts Chat references into a Work and reads a trusted progress snapshot after restart", async () => {
  const chatResponse = await app.inject({
    method: "GET",
    url: "/api/v1/chat?timezone=UTC",
    headers: entryHeaders(personal)
  });
  const chat = chatResponse.json().chat as {
    threadRef: string;
    homeChatStreamRef: string;
  };
  const episode = chatResponse.json().currentEpisode as { dailyEpisodeRef: string };

  const source = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
    headers: entryHeaders(personal),
    payload: {
      protocolVersion: 1,
      clientMessageId: "conversion-source-0001",
      occurredAt: "2026-07-24T06:31:00.000Z",
      content: { type: "text", text: "把当前讨论转成 Work。", language: "zh-CN" }
    }
  });
  const sourceMessageRef = source.json().message.messageRef as string;

  const conversion = await app.inject({
    method: "POST",
    url: "/api/v1/chat/work-conversions",
    headers: entryHeaders(personal),
    payload: {
      protocolVersion: 1,
      title: "正式 HTTP 路由",
      goal: "把 Chat 讨论转为独立 Work",
      source: {
        homeChatStreamRef: chat.homeChatStreamRef,
        dailyEpisodeRef: episode.dailyEpisodeRef,
        messageRefs: [sourceMessageRef]
      },
      decisions: ["只实现路由层"],
      openQuestions: ["何时接入 Provider"]
    }
  });
  expect(conversion.statusCode).toBe(201);
  expect(conversion.json()).toMatchObject({
    protocolVersion: 1,
    conversation: {
      title: "正式 HTTP 路由",
      personRef: ownerPersonRef
    },
    conversion: {
      homeChatStreamRef: chat.homeChatStreamRef,
      sourceMessageRefs: [sourceMessageRef]
    }
  });

  const workConversationRef = conversion.json().conversation.workConversationRef as string;
  await app.close();

  const { ChatWorkDomainRepository } = await import("../src/chatWorkDomain.js");
  const { openGatewayDatabase } = await import("../src/database.js");
  const db = openGatewayDatabase(databasePath);
  const repository = new ChatWorkDomainRepository(db, () => currentNow);
  repository.saveWorkProgressSnapshot({
    personRef: ownerPersonRef,
    snapshot: {
      workConversationRef,
      status: "active",
      phaseSummary: "HTTP 路由已建立",
      incompleteTasks: ["接入 Provider"],
      risks: ["不得影响 PR #14"],
      pendingConfirmations: [],
      deadlines: [{
        label: "完成路由验收",
        dueAt: "2026-07-25T06:30:00.000Z"
      }],
      updatedAt: "2026-07-24T07:00:00.000Z"
    }
  });
  db.close();

  await openApp();
  const progress = await app.inject({
    method: "GET",
    url: `/api/v1/work-conversations/${encodeURIComponent(workConversationRef)}/progress`,
    headers: entryHeaders(personal)
  });
  expect(progress.statusCode).toBe(200);
  expect(progress.json()).toMatchObject({
    protocolVersion: 1,
    snapshot: {
      workConversationRef,
      phaseSummary: "HTTP 路由已建立",
      risks: ["不得影响 PR #14"]
    }
  });
});
```

Append to security tests:

```ts
it("rejects forged Chat-to-Work fields and hides missing progress", async () => {
  const forged = await app.inject({
    method: "POST",
    url: "/api/v1/chat/work-conversions",
    headers: entryHeaders(personal),
    payload: {
      protocolVersion: 1,
      title: "伪造转换",
      goal: "必须拒绝",
      personRef: "person:forged",
      source: {
        homeChatStreamRef: "home-chat:forged",
        dailyEpisodeRef: null,
        messageRefs: ["message:forged"]
      },
      decisions: [],
      openQuestions: []
    }
  });
  expect(forged.statusCode).toBe(400);
  expectPublicError(forged, {
    code: "REQUEST_INVALID",
    category: "validation",
    retryable: false
  });

  const missing = await app.inject({
    method: "GET",
    url: "/api/v1/work-conversations/work:not-present/progress",
    headers: entryHeaders(personal)
  });
  expect(missing.statusCode).toBe(404);
  expectPublicError(missing, {
    code: "WORK_PROGRESS_NOT_FOUND",
    category: "permission",
    retryable: false
  });
});
```

- [ ] **Step 2: Run conversion/progress tests and observe RED**

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected: FAIL with HTTP 404 for conversion and progress routes.

- [ ] **Step 3: Add conversion and progress imports and path schema**

Update imports:

```ts
import {
  CHAT_WORK_PROTOCOL_VERSION,
  createWorkConversationRequestSchema,
  createWorkConversationResponseSchema,
  createWorkFromChatRequestSchema,
  createWorkFromChatResponseSchema,
  homeChatStreamResponseSchema,
  interactionThreadRefSchema,
  sendThreadMessageRequestSchema,
  sendThreadMessageResponseSchema,
  threadMessageListResponseSchema,
  workConversationListResponseSchema,
  workConversationRefSchema,
  workProgressSnapshotResponseSchema
} from "@family-ai/contracts";
```

Add:

```ts
const workProgressParamsSchema = z
  .object({ workConversationRef: workConversationRefSchema })
  .strict();

function workProgressNotFound(): GatewayDomainError {
  return new GatewayDomainError(
    "WORK_PROGRESS_NOT_FOUND",
    404,
    "permission",
    false,
    "没有找到这个 Work 的进度。"
  );
}
```

- [ ] **Step 4: Implement conversion and progress routes**

```ts
app.post("/api/v1/chat/work-conversions", async (request, reply) => {
  const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
  const command = parseRequest(
    createWorkFromChatRequestSchema,
    request.body,
    "Chat 转 Work 请求或协议版本不正确。"
  );
  const result = input.repository.createWorkFromChat({
    personRef: context.person.personRef,
    title: command.title,
    goal: command.goal,
    source: command.source,
    decisions: command.decisions,
    openQuestions: command.openQuestions
  });
  return reply.code(201).send(createWorkFromChatResponseSchema.parse({
    protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
    ...result
  }));
});

app.get(
  "/api/v1/work-conversations/:workConversationRef/progress",
  async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const params = parseRequest(
      workProgressParamsSchema,
      request.params,
      "Work 编号不正确。"
    );
    const snapshot = input.repository.getWorkProgressSnapshot(
      context.person.personRef,
      params.workConversationRef
    );
    if (!snapshot) throw workProgressNotFound();
    return workProgressSnapshotResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      snapshot
    });
  }
);
```

- [ ] **Step 5: Verify conversion/progress GREEN**

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit conversion and progress routes**

```bash
git add apps/gateway/src/chatWorkRoutes.ts apps/gateway/test/chatWorkRoutes.test.ts apps/gateway/test/chatWorkRoutesSecurity.test.ts
git commit -m "feat(gateway): expose Chat conversion and Work progress routes"
```

---

### Task 6: Complete security isolation and final verification

**Files:**
- Modify: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`
- Modify only if a failing regression proves necessary: `apps/gateway/src/chatWorkRoutes.ts`
- Modify only if route composition fails: `apps/gateway/src/app.ts`

**Interfaces:**
- Consumes: existing onboarding/member APIs and direct SQLite test setup.
- Produces: evidence for revoked/expired sessions, cross-Person isolation, no secret leakage and PR #14 path isolation.

- [ ] **Step 1: Add a helper for a second personal Entry Session**

Add imports to `chatWorkRoutesSecurity.test.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { openGatewayDatabase, sha256 } from "../src/database.js";
```

Extend onboarding test state with `familyRef`, `ownerPersonRef` and `ownerDeviceRef`. Add this helper inside `describe`:

```ts
function createSecondPersonalEntry(input: {
  familyRef: string;
  personRef: string;
}) {
  const db = openGatewayDatabase(databasePath);
  const now = "2026-07-24T06:30:00.000Z";
  const expiresAt = "2026-08-24T06:30:00.000Z";
  const deviceRef = `device:${randomUUID()}`;
  const deviceBindingRef = `device-binding:${randomUUID()}`;
  const entryBindingRef = `entry-binding:${randomUUID()}`;
  const entrySessionRef = `entry-session:${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");

  db.transaction(() => {
    db.prepare(
      `INSERT INTO managed_devices
       (device_ref, display_name, terminal_type, platform, status, credential_hash,
        created_at, updated_at, revoked_at)
       VALUES(?, 'Second Web', 'web', 'test', 'active', ?, ?, ?, NULL)`
    ).run(deviceRef, sha256("second-device-credential"), now, now);
    db.prepare(
      `INSERT INTO device_bindings
       (device_binding_ref, device_ref, owner_scope, family_ref, person_ref,
        status, bound_at, revoked_at)
       VALUES(?, ?, 'person', ?, ?, 'active', ?, NULL)`
    ).run(deviceBindingRef, deviceRef, input.familyRef, input.personRef, now);
    db.prepare(
      `INSERT INTO entry_bindings
       (entry_binding_ref, device_ref, family_ref, person_ref, audience, status,
        bound_at, last_used_at)
       VALUES(?, ?, ?, ?, 'personal', 'active', ?, NULL)`
    ).run(entryBindingRef, deviceRef, input.familyRef, input.personRef, now);
    db.prepare(
      `INSERT INTO entry_sessions
       (entry_session_ref, entry_binding_ref, token_hash, status,
        created_at, expires_at, revoked_at)
       VALUES(?, ?, ?, 'active', ?, ?, NULL)`
    ).run(entrySessionRef, entryBindingRef, sha256(token), now, expiresAt);
  })();
  db.close();
  return { deviceRef, entrySessionRef, token };
}
```

- [ ] **Step 2: Add cross-Person, expiry and revocation regression tests**

Append:

```ts
it("prevents another Person from reading or writing the owner's Thread", async () => {
  const chat = await app.inject({
    method: "GET",
    url: "/api/v1/chat?timezone=UTC",
    headers: entryHeaders(personal)
  });
  const ownerThreadRef = chat.json().chat.threadRef as string;

  const member = await app.inject({
    method: "POST",
    url: "/api/v1/admin/members",
    headers: entryHeaders(admin),
    payload: { displayName: "另一位成人", familyRole: "adult" }
  });
  const secondPersonRef = member.json().member.personRef as string;
  await app.close();
  const second = createSecondPersonalEntry({ familyRef, personRef: secondPersonRef });
  app = await buildGatewayApp({
    databasePath,
    deviceToken,
    mode: "test",
    now: () => new Date("2026-07-24T06:30:00.000Z")
  });

  const read = await app.inject({
    method: "GET",
    url: `/api/v1/threads/${encodeURIComponent(ownerThreadRef)}/messages`,
    headers: entryHeaders(second)
  });
  expect(read.statusCode).toBe(404);
  expectPublicError(read, {
    code: "THREAD_NOT_FOUND",
    category: "permission",
    retryable: false
  });

  const write = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${encodeURIComponent(ownerThreadRef)}/messages`,
    headers: entryHeaders(second),
    payload: {
      protocolVersion: 1,
      clientMessageId: "cross-person-message-0001",
      occurredAt: "2026-07-24T06:31:00.000Z",
      content: { type: "text", text: "不应写入" }
    }
  });
  expect(write.statusCode).toBe(404);
  expectPublicError(write, {
    code: "THREAD_NOT_FOUND",
    category: "permission",
    retryable: false
  });
});

it("rejects expired sessions and revoked devices before Chat Work access", async () => {
  const db = openGatewayDatabase(databasePath);
  db.prepare(
    "UPDATE entry_sessions SET expires_at = ? WHERE entry_session_ref = ?"
  ).run("2026-07-23T00:00:00.000Z", personal.entrySessionRef);
  db.close();

  const expired = await app.inject({
    method: "GET",
    url: "/api/v1/chat?timezone=UTC",
    headers: entryHeaders(personal)
  });
  expect(expired.statusCode).toBe(401);
  expectPublicError(expired, {
    code: "ENTRY_SESSION_EXPIRED",
    category: "permission",
    retryable: false
  });

  await app.close();
  const resetDb = openGatewayDatabase(databasePath);
  resetDb.prepare(
    `UPDATE entry_sessions
     SET status = 'active', expires_at = ?
     WHERE entry_session_ref = ?`
  ).run("2026-08-24T00:00:00.000Z", personal.entrySessionRef);
  resetDb.prepare(
    "UPDATE managed_devices SET status = 'revoked', revoked_at = ? WHERE device_ref = ?"
  ).run("2026-07-24T06:40:00.000Z", ownerDeviceRef);
  resetDb.close();
  app = await buildGatewayApp({
    databasePath,
    deviceToken,
    mode: "test",
    now: () => new Date("2026-07-24T06:40:00.000Z")
  });

  const revoked = await app.inject({
    method: "GET",
    url: "/api/v1/chat?timezone=UTC",
    headers: entryHeaders(personal)
  });
  expect(revoked.statusCode).toBe(403);
  expectPublicError(revoked, {
    code: "DEVICE_REVOKED",
    category: "permission",
    retryable: false
  });
  expect(revoked.body).not.toContain(personal.token);
});
```

- [ ] **Step 3: Run security tests and observe any RED**

```bash
npm run test -w @family-ai/gateway -- test/chatWorkRoutesSecurity.test.ts
```

Expected: the tests must either pass with the existing route implementation or fail on a precise missing security invariant. If a test fails, make only the smallest route-layer change needed; do not modify PR #16 Repository behavior without a separate design decision.

- [ ] **Step 4: Run all Gateway tests**

```bash
npm run test -w @family-ai/gateway
```

Expected: PASS.

- [ ] **Step 5: Run typecheck and build**

```bash
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
```

Expected: both exit 0.

- [ ] **Step 6: Run the repository quality gate**

```bash
npm run check
```

Expected: exit 0 with all workspace tests, static checks, typechecks and builds passing.

- [ ] **Step 7: Commit final security coverage**

```bash
git add apps/gateway/test/chatWorkRoutesSecurity.test.ts apps/gateway/src/chatWorkRoutes.ts apps/gateway/src/app.ts
git commit -m "test(gateway): harden Chat Work HTTP isolation"
```

- [ ] **Step 8: Compare paths with PR #14**

```bash
git diff --name-only 12452bd59973884ddbe4b933fd6a45cbfbf5a53d...HEAD
```

Expected exact application/test paths:

```text
apps/gateway/src/app.ts
apps/gateway/src/chatWorkRoutes.ts
apps/gateway/test/chatWorkRoutes.test.ts
apps/gateway/test/chatWorkRoutesSecurity.test.ts
```

plus only the two design/plan documents. The output must contain no `clients/ios/`, `.github/workflows/`, `packages/contracts/`, mobile route, pairing or browser acceptance paths.

- [ ] **Step 9: Open a Draft PR and record verification evidence**

Create a Draft PR targeting `main` with:

```text
Title: feat(gateway): expose Chat Work HTTP routes
```

The body must include:

- exact head SHA;
- CI and Secret Scan results;
- endpoint list and status codes;
- statement that Provider and SSE are absent;
- complete changed-path list;
- PR #14 head and path-intersection result;
- unresolved review-thread result;
- deferred next stage.

Do not mark ready until CI and Secret Scan succeed on the final head.

---

## Plan Self-Review

- Spec coverage: Home Chat, Work, messages, conversion, progress, authentication, timezone, strict contracts, common errors, restart recovery and PR #14 isolation each have an implementation or test task.
- Placeholder scan: no incomplete implementation markers or unspecified error-handling steps remain.
- Type consistency: route names, Contracts schema names, Repository method names and `BuildGatewayAppOptions.now` are consistent across all tasks.
- Scope check: Provider invocation, Assistant replies, events, Web and iOS are explicitly excluded and require later plans.