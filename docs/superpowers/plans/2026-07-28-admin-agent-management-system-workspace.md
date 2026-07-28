# Family AI Multi-Agent Admin Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build directly experienceable multi-Agent member routing, real Hermes/Codex CLI sessions, global Agent status monitoring, and a separate two-pane administrator system workspace.

**Architecture:** The existing Gateway remains the single identity, authorization, thread, message, Provider Session, and SQLite authority. Personal Chat/Work becomes keyed by `person_ref + agent_ref`; Admin system threads use the same message infrastructure with a separate `family_admin` audience. Provider selection is routed by the persisted Provider Profile, while explicit Hermes/Codex Session IDs are stored per thread so every device resumes the same Provider Session.

**Tech Stack:** Node.js 22, TypeScript, Fastify, Zod, better-sqlite3, Vitest, browser ES modules, IndexedDB, SSE, Hermes CLI, Codex CLI.

## Global Constraints

- Work only in `ArchitectureWorld/family-ai-platform`; never copy or merge `family-ai-platform-legacy`.
- Run every Linux repository, build, preview, and runtime command through `ssh admin-yr`; verify remote user, host, IP, checkout, and branch before modifying.
- Gateway and SQLite remain the only business authority; Admin Web must not create a second identity, Agent, thread, or settings database.
- The same Agent may be mounted by multiple members, but one member may not have duplicate active mounts for one Agent.
- Only `family_admin` may mount, unmount, or set a default Agent; a member may only choose an active mount temporarily.
- A member may have no default Agent and may temporarily have no mounted Agent.
- Personal conversation authorization always checks the authenticated Person, mounted Agent, and Thread Agent.
- Admin configuration never grants access to member message bodies, Work bodies, memory, or Provider Session IDs.
- Chat, each Work, each member, and each Agent have independent Provider Context Sessions.
- Resume Hermes and Codex only by an explicit persisted Session ID; never use `--last`.
- Provider subprocesses use `spawn()` with `shell: false`, an environment allowlist, output caps, timeout, process-group termination, bounded concurrency, and sanitized errors.
- No Token, Cookie, Provider stderr, raw Session ID, absolute private path, Prompt, or secret enters a public API, audit event, log fixture, screenshot, or Git.
- Automated tests use Fake Provider or fake CLI executables and never incur real model charges.
- Changes follow failing test → minimal implementation → passing focused tests → refactor → full verification → commit.
- Do not merge until contracts, Gateway tests, static checks, typecheck, build, Docker build, LAN Preview, real Jarvis/Codex smoke, restart continuation, and two-device continuation all pass.

---

## File and Component Map

### Contracts

- Create `packages/contracts/src/agentManagement.ts`: Agent catalog, mount, default, health, and Admin workspace schemas.
- Modify `packages/contracts/src/index.ts`: export Agent management schemas and retain Provider v1 contracts.
- Modify `packages/contracts/src/mobileEntry.ts`: Personal context returns `mountedAgents` and nullable `defaultAgentRef`.
- Modify `packages/contracts/src/chatWork.ts`: Chat and Work resources carry `agentRef`; Work creation carries `agentRef`.
- Test `packages/contracts/test/agentManagement.test.ts`, `mobileEntry.test.ts`, and `chatWork.test.ts`.

### Gateway domain and persistence

- Modify `apps/gateway/src/database.ts`: Migration V7, idempotent runtime catalog reconciliation, and backfill.
- Create `apps/gateway/src/agentManagement.ts`: Agent catalog, personal mounts/default, Admin assignments, and status query repository.
- Create `apps/gateway/src/agentRoutes.ts`: Admin Agent APIs and status endpoint.
- Modify `apps/gateway/src/familyDomain.ts` and `familyRoutes.ts`: onboarding defaults and Personal portal context.
- Modify `apps/gateway/src/chatWorkDomain.ts`, `chatWorkRoutes.ts`, `chatWorkProvider.ts`, and `chatWorkMessageService.ts`: Agent-aware personal/admin threads and explicit adapter routing.
- Create `apps/gateway/src/adminWorkspace.ts` and `adminWorkspaceRoutes.ts`: Admin-only Chat/Work facade.
- Create `apps/gateway/src/agentStatus.ts`: red/orange/green aggregation.

### Provider Adapter SDK and runtime composition

- Create `packages/provider-adapter-sdk/src/processRunner.ts`: safe process execution primitive.
- Create `packages/provider-adapter-sdk/src/hermesCliProvider.ts`: Hermes invoke/resume parser.
- Create `packages/provider-adapter-sdk/src/codexCliProvider.ts`: Codex JSONL invoke/resume parser.
- Create `packages/provider-adapter-sdk/src/providerRouter.ts`: Provider Profile to Adapter routing.
- Modify `packages/provider-adapter-sdk/src/index.ts`: exports.
- Modify `apps/gateway/src/config.ts`, `index.ts`, and `app.ts`: explicit runtime definitions and Adapter composition.
- Modify `scripts/member-preview-up.sh`: protected Preview-only runtime discovery and configuration.

### Member Web

- Create `apps/gateway/member-public/agent-selector.js`: active/default/temporary Agent selection policy.
- Modify `api.js`, `cache.js`, `chat.js`, `work.js`, `product.js`, `render.js`, `index.html`, and `member.css`.
- Modify `apps/gateway/src/memberWeb.ts` to serve the new module.

### Admin Web

- Create `apps/gateway/admin-public/admin-agents.js`: mount controls and status chips.
- Create `apps/gateway/admin-public/admin-workspace.js`: Jarvis/Codex panels and sticky monitor.
- Modify `admin-api.js`, `admin.js`, `index.html`, and `admin.css`.
- Modify `apps/gateway/src/adminWeb.ts` to serve the new modules.

### Verification and documentation

- Add focused tests under `apps/gateway/test/`.
- Modify `scripts/acceptance.sh` only where deterministic Fake Provider acceptance needs an `agentRef`.
- Create `docs/superpowers/evidence/2026-07-28-admin-agent-management-system-workspace.md` after execution with exact current evidence.
- Update `README.md` and `docs/development/2026-07-28-lan-admin-member-experience.md` with the final novice experience.

---

### Task 1: Versioned Multi-Agent Contracts

**Files:**
- Create: `packages/contracts/src/agentManagement.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/mobileEntry.ts:150-205`
- Modify: `packages/contracts/src/chatWork.ts:34-132,201-365`
- Test: `packages/contracts/test/agentManagement.test.ts`
- Test: `packages/contracts/test/mobileEntry.test.ts`
- Test: `packages/contracts/test/chatWork.test.ts`

**Interfaces:**
- Produces: `agentRuntimeStatusSchema`, `agentCatalogItemSchema`, `mountedAgentSchema`, `adminAgentCatalogResponseSchema`, `memberAgentMountsResponseSchema`, `mountMemberAgentRequestSchema`, `setDefaultAgentRequestSchema`.
- Produces: `PersonalPortalContext.mountedAgents`, `PersonalPortalContext.defaultAgentRef`.
- Produces: `HomeChatStream.agentRef`, `WorkConversation.agentRef`, `CreateWorkConversationRequest.agentRef`.
- Consumes: existing ref conventions and `CHAT_WORK_PROTOCOL_VERSION`.

- [ ] **Step 1: Write failing Agent contract tests**

```ts
import {
  adminAgentCatalogResponseSchema,
  memberAgentMountsResponseSchema,
  setDefaultAgentRequestSchema
} from "../src/index.js";

it("accepts reusable Agent status and a member with no default", () => {
  expect(adminAgentCatalogResponseSchema.parse({
    protocolVersion: 1,
    agents: [{
      agentRef: "agent:codex-cli",
      displayName: "Codex CLI",
      status: "working",
      statusLabel: "工作中",
      activeTurnCount: 2,
      lastCheckedAt: "2026-07-28T10:00:00.000Z",
      publicProblem: null
    }]
  }).agents[0]?.status).toBe("working");

  expect(memberAgentMountsResponseSchema.parse({
    protocolVersion: 1,
    personRef: "person:alice",
    defaultAgentRef: null,
    mountedAgents: []
  }).defaultAgentRef).toBeNull();
  expect(setDefaultAgentRequestSchema.parse({ agentRef: null })).toEqual({ agentRef: null });
});
```

- [ ] **Step 2: Run the contracts tests and verify failure**

Run:

```bash
npm run test -w @family-ai/contracts -- agentManagement.test.ts mobileEntry.test.ts chatWork.test.ts
```

Expected: FAIL because the Agent schemas and `agentRef` resource fields do not exist.

- [ ] **Step 3: Add the concrete schemas**

```ts
export const agentRuntimeStatusSchema = z.enum(["idle", "working", "problem"]);
export const mountedAgentSchema = z.object({
  assignmentRef: assignmentRefSchema,
  agentRef: agentRefSchema,
  displayName: displayNameSchema,
  providerProfileRef: providerProfileRefSchema,
  isDefault: z.boolean(),
  status: agentRuntimeStatusSchema,
  statusLabel: z.enum(["空闲", "工作中", "有问题"])
}).strict();

export const setDefaultAgentRequestSchema = z.object({
  agentRef: agentRefSchema.nullable()
}).strict();
```

Extend Chat/Work resource schemas with `agentRef: agentRefSchema`; extend Work creation with the same field. Replace the singular Personal context `agent` with:

```ts
mountedAgents: z.array(mountedAgentSchema).max(100),
defaultAgentRef: mobileAgentRefSchema.nullable()
```

Add a `superRefine` check that a non-null default exists exactly once in `mountedAgents` and has `isDefault: true`.

- [ ] **Step 4: Export schemas and types from `index.ts`**

```ts
export * from "./agentManagement.js";
```

- [ ] **Step 5: Run focused contract tests**

Run:

```bash
npm run test -w @family-ai/contracts -- agentManagement.test.ts mobileEntry.test.ts chatWork.test.ts
npm run typecheck -w @family-ai/contracts
```

Expected: all selected tests and typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat: define multi-agent contracts"
```

---

### Task 2: Migration V7 and Agent-Aware Thread Schema

**Files:**
- Modify: `apps/gateway/src/database.ts:164-490`
- Test: `apps/gateway/test/database.test.ts`
- Create: `apps/gateway/test/multiAgentMigration.test.ts`

**Interfaces:**
- Produces: active personal mount uniqueness `(person_ref, agent_ref)`.
- Produces: nullable personal default via `assistant_assignments.is_default`.
- Produces: `agent_runtime_bindings`, `admin_agent_assignments`.
- Produces: `interaction_threads.agent_ref`, `entry_audience`, and nullable `family_ref`.
- Produces: Agent and audience columns on Home Chat/Work plus Provider Context support for Admin threads.

- [ ] **Step 1: Write a failing migration/backfill test**

Create a V6 database through the current opener, create one Chat and one Work, close it, then reopen with V7:

```ts
it("backfills existing personal threads and permits two active Agents", () => {
  const reopened = openGatewayDatabase(databasePath);
  const chat = reopened.prepare(
    "SELECT agent_ref, entry_audience FROM interaction_threads WHERE thread_kind='home_chat'"
  ).get() as { agent_ref: string; entry_audience: string };
  expect(chat).toEqual({
    agent_ref: "agent:personal-assistant",
    entry_audience: "personal"
  });

  expect(() => insertAssignment(reopened, "agent:second")).not.toThrow();
  expect(() => insertAssignment(reopened, "agent:second")).toThrow();
  expect(latestMigration(reopened)).toBe(7);
});
```

Also assert existing message refs, sequences, Provider Context, and external Session refs are unchanged.

- [ ] **Step 2: Run the migration tests and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- database.test.ts multiAgentMigration.test.ts
```

Expected: FAIL because version 7 and the new columns/tables are absent.

- [ ] **Step 3: Add `MIGRATION_V7` with exact constraints**

The migration must:

```sql
ALTER TABLE assistant_assignments
  ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
UPDATE assistant_assignments SET is_default = 1 WHERE status = 'active';
DROP INDEX person_active_assistant_assignment_idx;
CREATE UNIQUE INDEX person_agent_active_assistant_assignment_idx
  ON assistant_assignments(person_ref, agent_ref) WHERE status = 'active';
CREATE UNIQUE INDEX person_default_assistant_assignment_idx
  ON assistant_assignments(person_ref)
  WHERE status = 'active' AND is_default = 1;

CREATE TABLE agent_runtime_bindings (
  agent_ref TEXT PRIMARY KEY REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_agent_assignments (
  assignment_ref TEXT PRIMARY KEY,
  family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  effective_from TEXT NOT NULL,
  effective_to TEXT
);
CREATE UNIQUE INDEX admin_person_agent_active_assignment_idx
  ON admin_agent_assignments(family_ref, person_ref, agent_ref)
  WHERE status = 'active';
```

Rebuild `interaction_threads`, `home_chat_streams`, `work_conversations`, `thread_provider_contexts`, and `thread_provider_turns` through `*_v7` tables so new non-null and CHECK constraints are enforced. Personal rows use `entry_audience='personal'`; Admin rows permit `assignment_ref IS NULL` only with `entry_audience='family_admin'`. Copy all existing refs and timestamps, then rename the V7 tables and recreate all indexes.

- [ ] **Step 4: Add deterministic backfill guards**

For every existing Thread, resolve `agent_ref` in this order:

```sql
SELECT agent_ref FROM thread_provider_contexts WHERE thread_ref = ?;
SELECT aa.agent_ref
FROM assistant_assignments aa
JOIN interaction_threads it ON it.person_ref = aa.person_ref
WHERE it.thread_ref = ? AND aa.status = 'active';
```

Abort the transaction unless exactly one Agent is found. Never choose the first of multiple rows.

- [ ] **Step 5: Register migration version 7**

Follow the existing migration ledger transaction and insert:

```ts
db.exec(MIGRATION_V7);
db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(7, ?)").run(
  new Date().toISOString()
);
```

- [ ] **Step 6: Run focused migration and existing database tests**

Run:

```bash
npm run test -w @family-ai/gateway -- database.test.ts multiAgentMigration.test.ts
```

Expected: PASS, including repeated open and rollback-on-ambiguous-backfill.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/database.ts apps/gateway/test/database.test.ts apps/gateway/test/multiAgentMigration.test.ts
git commit -m "feat: migrate gateway to agent-aware threads"
```

---

### Task 3: Agent Catalog, Mount, Default, and Admin Assignment Repository

**Files:**
- Create: `apps/gateway/src/agentManagement.ts`
- Modify: `apps/gateway/src/familyDomain.ts:122-410`
- Test: `apps/gateway/test/agentManagement.test.ts`
- Test: `apps/gateway/test/familyOnboarding.test.ts`

**Interfaces:**
- Produces: `ConfiguredAgentRuntime`.
- Produces: `AgentManagementRepository.reconcileRuntimeCatalog()`.
- Produces: `listCatalog()`, `listMemberMounts()`, `mountMemberAgent()`, `unmountMemberAgent()`, `setDefaultAgent()`, `ensureOwnerAdminAssignments()`.
- Consumes: V7 tables.

- [ ] **Step 1: Write repository tests for reuse and uniqueness**

```ts
it("mounts one Agent for two members but not twice for one member", () => {
  const first = repository.mountMemberAgent({ familyRef, personRef: alice, agentRef: shared });
  const replay = repository.mountMemberAgent({ familyRef, personRef: alice, agentRef: shared });
  const secondMember = repository.mountMemberAgent({
    familyRef,
    personRef: bob,
    agentRef: shared
  });
  expect(replay.assignmentRef).toBe(first.assignmentRef);
  expect(secondMember.assignmentRef).not.toBe(first.assignmentRef);
});

it("allows clearing the default and preserves ended history", () => {
  repository.setDefaultAgent({ familyRef, personRef: alice, agentRef: shared });
  repository.unmountMemberAgent({ familyRef, personRef: alice, agentRef: shared });
  expect(repository.listMemberMounts(familyRef, alice).defaultAgentRef).toBeNull();
  expect(countEndedAssignments(db, alice, shared)).toBe(1);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- agentManagement.test.ts familyOnboarding.test.ts
```

Expected: FAIL because `AgentManagementRepository` does not exist.

- [ ] **Step 3: Implement runtime reconciliation**

```ts
export interface ConfiguredAgentRuntime {
  agentRef: string;
  displayName: string;
  providerProfileRef: string;
  providerKind: "fake" | "hermes" | "codex";
}

reconcileRuntimeCatalog(definitions: readonly ConfiguredAgentRuntime[]): void
```

Run one transaction that inserts missing Agents/Provider Profiles, updates display names only for the same logical ref, and upserts `agent_runtime_bindings`. Reject duplicate Agent refs or one Agent mapped to two Provider Profiles.

- [ ] **Step 4: Implement mount/default methods**

All methods first verify the target active Person belongs to `familyRef`. `mountMemberAgent()` resolves the active runtime binding on the server and is idempotent for an already active `(person, agent)`. `unmountMemberAgent()` sets `status='ended'`, `effective_to`, and `is_default=0`. `setDefaultAgent(null)` clears all active defaults.

- [ ] **Step 5: Implement Admin defaults**

```ts
ensureOwnerAdminAssignments(input: {
  familyRef: string;
  personRef: string;
  agentRefs: readonly ["agent:hermes-jarvis", "agent:codex-cli"];
}): void
```

Create only missing active rows. Do not end or overwrite existing Admin assignments.

- [ ] **Step 6: Update onboarding tests**

Personal onboarding still creates one active default personal assignment. When configured runtime definitions include Jarvis and Codex, the owner receives two Admin assignments without gaining access to any other Person thread.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- agentManagement.test.ts familyOnboarding.test.ts
```

Then:

```bash
git add apps/gateway/src/agentManagement.ts apps/gateway/src/familyDomain.ts apps/gateway/test
git commit -m "feat: manage member agent mounts"
```

---

### Task 4: Admin Agent APIs and Personal Portal Context

**Files:**
- Create: `apps/gateway/src/agentRoutes.ts`
- Modify: `apps/gateway/src/familyRoutes.ts:80-165`
- Modify: `apps/gateway/src/app.ts:190-290`
- Test: `apps/gateway/test/agentRoutes.test.ts`
- Test: `apps/gateway/test/familyOnboarding.test.ts`

**Interfaces:**
- Produces the Admin routes from the design spec.
- Produces Personal `mountedAgents` and nullable `defaultAgentRef`.
- Consumes `AgentManagementRepository` and a synchronous cached status lookup.

- [ ] **Step 1: Write failing route authorization and behavior tests**

Test:

```ts
const mounted = await app.inject({
  method: "POST",
  url: `/api/v1/admin/members/${personRef}/agent-mounts`,
  headers: entryHeaders(admin),
  payload: { agentRef: "agent:codex-cli" }
});
expect(mounted.statusCode).toBe(201);

const personalAttempt = await app.inject({
  method: "DELETE",
  url: `/api/v1/admin/members/${personRef}/agent-mounts/agent%3Acodex-cli`,
  headers: entryHeaders(personal)
});
expect(personalAttempt.statusCode).toBe(403);
expect(personalAttempt.body).not.toContain("content_text");
```

Also test clearing default, cross-family Person refs, unconfigured Agent refs, and repeat POST.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- agentRoutes.test.ts familyOnboarding.test.ts
```

Expected: FAIL with route 404 or old singular Personal `agent`.

- [ ] **Step 3: Register strict Zod route bodies and params**

Routes:

```text
GET    /api/v1/admin/agents
GET    /api/v1/admin/members/:personRef/agent-mounts
POST   /api/v1/admin/members/:personRef/agent-mounts
DELETE /api/v1/admin/members/:personRef/agent-mounts/:agentRef
PUT    /api/v1/admin/members/:personRef/default-agent
```

Every route calls `requireEntryRequest(..., "family_admin")`; no route accepts `familyRef`, `providerProfileRef`, Assignment ref, or Session ref from the client.

Define the status dependency as:

```ts
export interface AgentStatusLookup {
  snapshot(agentRef: string): {
    status: "idle" | "working" | "problem";
    statusLabel: "空闲" | "工作中" | "有问题";
    activeTurnCount: number;
    lastCheckedAt: string;
    publicProblem: string | null;
  };
}
```

Until Task 7 installs live aggregation, `buildGatewayApp()` supplies a fixed `problem / Agent 状态尚未初始化。` lookup. This keeps Task 4 independently buildable without reporting a false green state.

- [ ] **Step 4: Return Personal mounted Agent context**

In `familyRoutes.ts`, parse:

```ts
const mounts = agentRepository.listMemberMounts(
  context.family.familyRef,
  context.person.personRef
);
personalPortalContextSchema.parse({
  protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
  ...context,
  mountedAgents: mounts.mountedAgents
    .map(mount => ({ ...mount, ...agentStatus.snapshot(mount.agentRef) })),
  defaultAgentRef: mounts.defaultAgentRef
});
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- agentRoutes.test.ts familyOnboarding.test.ts
```

Then:

```bash
git add apps/gateway/src/agentRoutes.ts apps/gateway/src/familyRoutes.ts apps/gateway/src/app.ts apps/gateway/test
git commit -m "feat: expose admin agent assignment APIs"
```

---

### Task 5: Agent-Aware Personal Chat, Work, and Provider Context

**Files:**
- Modify: `apps/gateway/src/chatWorkDomain.ts:17-880`
- Modify: `apps/gateway/src/chatWorkRoutes.ts:20-250`
- Modify: `apps/gateway/src/chatWorkProvider.ts:1-430`
- Create: `apps/gateway/src/chatWorkContext.ts`
- Modify: `apps/gateway/src/domainEventCore.ts`
- Test: `apps/gateway/test/chatWorkDomain.test.ts`
- Test: `apps/gateway/test/chatWorkRoutes.test.ts`
- Test: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`
- Test: `apps/gateway/test/chatWorkProviderAssignment.test.ts`
- Test: `apps/gateway/test/chatWorkContext.test.ts`

**Interfaces:**
- `ensureHomeChat({ personRef, agentRef, ... })`.
- `getHomeChat(personRef, agentRef)`.
- `listWorkConversations(personRef, agentRef)`.
- `createWorkConversation({ personRef, agentRef, ... })`.
- `requireThread({ personRef, agentRef, entryAudience, threadRef })`.
- Provider context resolves the Agent recorded on the Thread, not a Person-wide current assignment.

- [ ] **Step 1: Write failing isolation tests**

```ts
const first = repository.ensureHomeChat({
  personRef, agentRef: "agent:first", timezone: "UTC", localDate: "2026-07-28"
});
const second = repository.ensureHomeChat({
  personRef, agentRef: "agent:second", timezone: "UTC", localDate: "2026-07-28"
});
expect(second.chat.threadRef).not.toBe(first.chat.threadRef);

expect(() => repository.listThreadMessages({
  personRef,
  agentRef: "agent:second",
  threadRef: first.chat.threadRef
})).toThrowError(expect.objectContaining({ code: "THREAD_NOT_FOUND" }));
```

At the HTTP level, call `/api/v1/chat?agentRef=agent%3Afirst&timezone=UTC`, create Work with `agentRef`, and verify forged/unmounted Agents return `403 AGENT_NOT_MOUNTED`.

Create the same Agent Chat for two different members and assert different Thread refs, `provider_conversation_ref` values, and `external_session_ref` values.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- chatWorkDomain.test.ts chatWorkRoutes.test.ts chatWorkRoutesSecurity.test.ts chatWorkProviderAssignment.test.ts
```

Expected: FAIL because repositories still resolve one Person-wide assignment.

- [ ] **Step 3: Thread every domain operation through `agentRef`**

Add Agent predicates to every Home Chat/Work lookup. Chat-to-Work derives Agent from the source Home Chat and rejects selected messages from another Agent. Thread message routes infer the Thread Agent and verify an active mount before reads and writes.

- [ ] **Step 4: Preserve Provider Session on same Agent/Profile remount**

Change context resolution to:

```ts
if (
  existing.agentRef === assignment.agentRef &&
  existing.providerProfileRef === assignment.providerProfileRef
) {
  updateAssignmentRefOnly(existing.threadRef, assignment.assignmentRef);
} else {
  replaceProviderContextAndClearExternalSession(...);
}
```

The idempotency key remains scoped to Thread, message, Agent, and Provider Profile. A new Assignment ref alone does not create a duplicate successful turn.

- [ ] **Step 5: Include `agentRef` in domain events**

Add `agentRef` to Chat/Work created and Provider turn event payloads. Keep SSE free of message bodies and Session IDs.

- [ ] **Step 6: Rebuild a missing external Provider Session from platform history**

Add:

```ts
export function buildProviderContext(input: {
  messages: readonly ThreadMessage[];
  currentMessageRef: string;
  externalSessionRef: string | null;
}): ThreadMessageContent[];
```

For a normal continuation with an external Session, return only the current Person message. When a stored Session is explicitly reported missing, atomically clear only the matching `external_session_ref`; on the user's retry, build one bounded text capsule from the most recent 18 persisted Person/Assistant/Agent messages plus the current Person message. Prefix each line with `成员:` or the persisted Agent display role, cap the final text at 12,000 characters, and never include refs, timestamps, errors, or hidden fields.

Test that `PROVIDER_SESSION_NOT_FOUND` leaves the platform Thread/history intact, the retry creates a new external Session, and another Thread's Session is untouched.

- [ ] **Step 7: Cover unmount/send concurrency**

Hold a fake Provider Turn open, end the Agent mount, then release the Turn. Assert the already-authorized Turn can commit its Assistant response, while the next send returns `403 AGENT_NOT_MOUNTED`.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- chatWorkDomain.test.ts chatWorkRoutes.test.ts chatWorkRoutesSecurity.test.ts chatWorkProviderAssignment.test.ts chatWorkContext.test.ts chatWorkEvents.test.ts
```

Then:

```bash
git add apps/gateway/src/chatWorkDomain.ts apps/gateway/src/chatWorkRoutes.ts apps/gateway/src/chatWorkProvider.ts apps/gateway/src/chatWorkContext.ts apps/gateway/src/domainEventCore.ts apps/gateway/test
git commit -m "feat: isolate chat and work by agent"
```

---

### Task 6: Safe Process Runner and Real CLI Adapters

**Files:**
- Create: `packages/provider-adapter-sdk/src/processRunner.ts`
- Create: `packages/provider-adapter-sdk/src/hermesCliProvider.ts`
- Create: `packages/provider-adapter-sdk/src/codexCliProvider.ts`
- Modify: `packages/provider-adapter-sdk/src/index.ts`
- Test: `packages/provider-adapter-sdk/test/processRunner.test.ts`
- Test: `packages/provider-adapter-sdk/test/hermesCliProvider.test.ts`
- Test: `packages/provider-adapter-sdk/test/codexCliProvider.test.ts`

**Interfaces:**
- Produces `runControlledProcess(options): Promise<ControlledProcessResult>`.
- Produces `HermesCliProviderAdapter` and `CodexCliProviderAdapter`.
- Converts raw Provider Session IDs to contract-safe `external-session:hermes-*` and `external-session:codex-*` refs.

- [ ] **Step 1: Write fake-CLI tests**

Use a temporary Node `.mjs` fixture invoked as `process.execPath` plus `prefixArgs`. Assert:

```ts
expect(recorded.shell).toBe(false);
expect(recorded.envKeys.sort()).toEqual([
  "CODEX_HOME", "HOME", "LANG", "PATH", "TERM"
]);
expect(secondInvocation.args).toContain("resume");
expect(secondInvocation.args).toContain(savedSessionId);
expect(secondInvocation.args).not.toContain("--last");
```

Add cases for timeout, more than the configured stdout/stderr bytes, invalid JSONL, missing Session ID, non-zero exit, and child-process cleanup.

The fake CLIs also emit a provider-specific “session not found” exit. Assert both Adapters map it to the fixed private-to-public error code `PROVIDER_SESSION_NOT_FOUND`, without returning the raw stderr line.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/provider-adapter-sdk
```

Expected: FAIL because real adapters and the runner are absent.

- [ ] **Step 3: Implement the controlled runner**

Core process launch:

```ts
const child = spawn(options.executable, [...options.prefixArgs, ...options.args], {
  cwd: options.cwd,
  env: Object.fromEntries(options.allowedEnvironment),
  shell: false,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"]
});
```

Reject NUL bytes, empty executable/cwd, duplicate environment keys, and output beyond limits. On timeout or abort, send `SIGTERM` to the process group, wait a short bounded grace period, then `SIGKILL`. Return only exit code, bounded stdout, and bounded stderr to the Adapter; never log them.

- [ ] **Step 4: Implement Hermes parsing**

Append `["-p", options.profileName]` only for a configured non-default Profile. First call uses `chat -q`, `--quiet`, and `--source tool`; continuation appends `["--resume", rawSessionId]`. Parse exactly one anchored stderr control line:

```ts
const match = /^session_id:\s*([a-z0-9][a-z0-9_-]{1,126})$/m.exec(stderr);
```

Treat all remaining stderr as private and discard it. Return stdout final text after size/schema checks.

- [ ] **Step 5: Implement Codex JSONL parsing**

First call uses `codex exec --json`; continuation uses `codex exec resume` with the decoded explicit Session ID and `--json`. Parse:

```ts
if (event.type === "thread.started") sessionId = event.thread_id;
if (event.type === "item.completed" && event.item?.type === "agent_message") {
  finalText = event.item.text;
}
```

Pass Prompt over stdin, not a shell argument. Do not use `--ephemeral` or `--last`.

The complete command places global safety flags before the subcommand:

```ts
const firstArgs = [
  "-s", "workspace-write", "-a", "never", "-C", options.cwd,
  "exec", "--json"
];
const resumeArgs = [
  "-s", "workspace-write", "-a", "never", "-C", options.cwd,
  "exec", "resume", rawSessionId, "--json"
];
```

Do not pass `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, or a directory received from an HTTP request.

Map controlled runner outcomes exactly:

```text
timeout                         → PROVIDER_TIMEOUT
recognized missing Session     → PROVIDER_SESSION_NOT_FOUND
invalid/missing structured data→ PROVIDER_RESPONSE_INVALID
other non-zero exit            → PROVIDER_UNAVAILABLE
```

Every mapping returns a fixed Chinese public message and discards raw stderr.

- [ ] **Step 6: Run SDK tests and typecheck**

Run:

```bash
npm run test -w @family-ai/provider-adapter-sdk
npm run typecheck -w @family-ai/provider-adapter-sdk
```

Expected: all Adapter tests PASS without a real Provider call.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-adapter-sdk
git commit -m "feat: add controlled Hermes and Codex adapters"
```

---

### Task 7: Provider Router, Active Turn Status, and Health Aggregation

**Files:**
- Create: `packages/provider-adapter-sdk/src/providerRouter.ts`
- Create: `apps/gateway/src/agentStatus.ts`
- Modify: `apps/gateway/src/chatWorkMessageService.ts:1-180`
- Modify: `apps/gateway/src/chatWorkProvider.ts`
- Modify: `apps/gateway/src/agentRoutes.ts`
- Test: `packages/provider-adapter-sdk/test/providerRouter.test.ts`
- Test: `apps/gateway/test/agentStatus.test.ts`
- Test: `apps/gateway/test/chatWorkProviderRoutes.test.ts`

**Interfaces:**
- Produces `ProviderAdapterRouter.resolve(providerProfileRef)`.
- Produces `AgentStatusService.snapshot(agentRef)` and `allSnapshots()`.
- Status precedence: `problem > working > idle`.
- Preserves `BuildGatewayAppOptions.providerAdapter` for existing tests by wrapping it as the only route for `provider-profile:fake-local`.

- [ ] **Step 1: Write routing and status tests**

```ts
expect(router.resolve("provider-profile:hermes-jarvis")).toBe(hermes);
expect(() => router.resolve("provider-profile:missing")).toThrow();

expect(statusFor({
  health: "offline",
  pending: 2,
  stalePending: 0
}).status).toBe("problem");
expect(statusFor({
  health: "online",
  pending: 2,
  stalePending: 0
}).status).toBe("working");
```

Verify a pending turn older than `timeoutMs + graceMs` is `problem`, and public output contains no `error_json`, Session ref, or path.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/provider-adapter-sdk -- providerRouter.test.ts
npm run test -w @family-ai/gateway -- agentStatus.test.ts chatWorkProviderRoutes.test.ts
```

Expected: FAIL because routing and status aggregation are absent.

- [ ] **Step 3: Route each Provider turn by persisted Profile**

Replace the single Adapter field in `ChatWorkMessageService` with:

```ts
interface ProviderAdapterResolver {
  resolve(providerProfileRef: string): ProviderAdapter;
}
```

Resolve after preparing the Turn, then invoke the Adapter. An unbound Profile returns `503 AGENT_RUNTIME_UNAVAILABLE`.

Update `apps/gateway/src/app.ts` in this Task. When a test passes only `providerAdapter`, create:

```ts
const providerRouter = options.providerRouter ??
  ProviderAdapterRouter.single("provider-profile:fake-local", providerAdapter);
```

This avoids changing every existing Fake Provider test before real runtime composition is installed.

- [ ] **Step 4: Implement aggregate status**

Combine:

1. `agent_runtime_bindings.status`;
2. cached Adapter health with a five-second maximum age;
3. pending Turns grouped by `agent_ref`;
4. latest failed/succeeded Turn timestamps.

Expose only `publicProblem` from a fixed map:

```ts
{
  runtime_missing: "Agent 尚未配置。",
  health_failed: "Agent 当前无法连接。",
  turn_stalled: "Agent 任务执行超时。",
  invocation_failed: "Agent 最近一次调用失败。"
}
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/provider-adapter-sdk -- providerRouter.test.ts
npm run test -w @family-ai/gateway -- agentStatus.test.ts chatWorkProviderRoutes.test.ts
```

Then:

```bash
git add packages/provider-adapter-sdk apps/gateway/src apps/gateway/test
git commit -m "feat: route providers and aggregate agent status"
```

---

### Task 8: Member Web Agent Selection and Per-Agent Offline Projection

**Files:**
- Create: `apps/gateway/member-public/agent-selector.js`
- Modify: `apps/gateway/member-public/api.js:330-380`
- Modify: `apps/gateway/member-public/cache.js:1-290`
- Modify: `apps/gateway/member-public/chat.js`
- Modify: `apps/gateway/member-public/work.js`
- Modify: `apps/gateway/member-public/product.js`
- Modify: `apps/gateway/member-public/render.js`
- Modify: `apps/gateway/member-public/index.html`
- Modify: `apps/gateway/member-public/member.css`
- Modify: `apps/gateway/src/memberWeb.ts`
- Test: `apps/gateway/test/memberAgentSelector.test.ts`
- Test: `apps/gateway/test/memberControllers.test.ts`
- Test: `apps/gateway/test/memberProductFlow.test.ts`

**Interfaces:**
- Produces `chooseInitialAgent(context, savedAgentRef)`.
- Produces `actions.switchAgent(agentRef)`.
- API methods receive an explicit `agentRef`.
- Cached Works remain stored for all Agents and are filtered by `agentRef`.

- [ ] **Step 1: Write selection policy tests**

```ts
expect(chooseInitialAgent({
  mountedAgents: [{ agentRef: "agent:a" }],
  defaultAgentRef: null
}, null)).toEqual({ kind: "selection_required" });

expect(chooseInitialAgent({
  mountedAgents: [],
  defaultAgentRef: null
}, "agent:stale")).toEqual({ kind: "unconfigured" });

expect(chooseInitialAgent({
  mountedAgents: [{ agentRef: "agent:a" }],
  defaultAgentRef: "agent:a"
}, null)).toEqual({ kind: "selected", agentRef: "agent:a" });
```

Also verify a saved temporary Agent wins only while it remains mounted.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- memberAgentSelector.test.ts memberControllers.test.ts memberProductFlow.test.ts
```

Expected: FAIL because Member Web assumes one Agent.

- [ ] **Step 3: Add explicit Agent API parameters**

```js
getHomeChat: (agentRef, timezone) =>
  apiRequest(queryPath("/api/v1/chat", { agentRef, timezone })),
listWorks: (agentRef) =>
  apiRequest(queryPath("/api/v1/work-conversations", { agentRef })),
createWork: (request) =>
  apiRequest("/api/v1/work-conversations", { method: "POST", body: request })
```

Controllers read `store.getState().currentAgentRef`; Work creation includes it.

- [ ] **Step 4: Preserve per-Agent cache**

Replace `saveWorks()` clearing behavior with:

```js
export async function saveWorksForAgent(cache, agentRef, works) {
  return cache.transaction(["works"], async transaction => {
    const all = await transaction.getAll("works");
    for (const work of all) {
      if (work.agentRef === agentRef) {
        await transaction.delete("works", work.workConversationRef);
      }
    }
    for (const work of works) await transaction.put("works", work);
  });
}
```

Store `selectedAgentRef` and `` `selectedWorkRef:${agentRef}` `` in `meta`. Do not store credentials or Session refs.

- [ ] **Step 5: Implement safe Agent switching**

`switchAgent()` clears only current screen selection, creates/loads the selected Agent Home Chat, filters Work, and saves the temporary device choice. It does not call the Admin default API.

Refresh Personal context every five seconds. If the current Agent is removed, stop new sends and return to the selector without deleting cached history.

- [ ] **Step 6: Render required empty states and status text**

Add an Agent selector above primary navigation. Render:

- “选择一个 Agent 开始” when mounted but no selected/default Agent;
- “管理员尚未为你配置 Agent” when no mounts;
- status dot plus “空闲 / 工作中 / 有问题” for every chip.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- memberAgentSelector.test.ts memberControllers.test.ts memberProductFlow.test.ts memberWeb.test.ts memberWebModules.test.ts
```

Then:

```bash
git add apps/gateway/member-public apps/gateway/src/memberWeb.ts apps/gateway/test
git commit -m "feat: add member agent switching"
```

---

### Task 9: Admin Member-Agent Configuration UI

**Files:**
- Create: `apps/gateway/admin-public/admin-agents.js`
- Modify: `apps/gateway/admin-public/admin-api.js`
- Modify: `apps/gateway/admin-public/admin.js`
- Modify: `apps/gateway/admin-public/index.html`
- Modify: `apps/gateway/admin-public/admin.css`
- Modify: `apps/gateway/src/adminWeb.ts`
- Test: `apps/gateway/test/adminAgentModules.test.ts`
- Test: `apps/gateway/test/adminWeb.test.ts`

**Interfaces:**
- Produces `renderMemberAgentControls()`.
- Consumes Admin Agent APIs.
- Preserves existing pairing and member creation flows.

- [ ] **Step 1: Write DOM-module and API tests**

Verify:

```ts
expect(addOptions.map(option => option.agentRef)).toEqual(["agent:not-mounted"]);
expect(card.querySelector("[data-remove-agent]")?.textContent).toBe("×");
expect(card.textContent).toContain("工作中");
```

API tests must assert POST, DELETE, and PUT paths are encoded and no Provider Profile or Session ref is sent.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- adminAgentModules.test.ts adminWeb.test.ts
```

Expected: FAIL because the Admin Agent module and assets do not exist.

- [ ] **Step 3: Add Admin API methods**

Add:

```js
agents()
memberAgentMounts(personRef)
mountAgent(personRef, agentRef)
unmountAgent(personRef, agentRef)
setDefaultAgent(personRef, agentRefOrNull)
```

Validate refs before constructing paths and validate every returned status enum.

- [ ] **Step 4: Render controls**

Each member card receives mounted Agent chips. The `+ Agent` menu filters only that member's active mounts. The red `×` has an accessible label, a lightweight confirmation, and ends the mount without removing the chip until the server succeeds.

Below the mount controls, render the fixed note:

```text
同一个 Agent 可以提供给多个成员；如果它连接的是同一个 Hermes Profile，Hermes 内部记忆也可能共享。
```

This is explanatory only and does not add Agent types or block reuse.

- [ ] **Step 5: Preserve page separation**

Add Admin navigation with separate containers:

```html
<button data-admin-page="members">成员与 Agent 配置</button>
<button data-admin-page="workspace">系统工作台</button>
```

This Task wires only the member page; the workspace container remains empty until Task 11, and is not placed inside a member card/list.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- adminAgentModules.test.ts adminWeb.test.ts adminWebModules.test.ts
```

Then:

```bash
git add apps/gateway/admin-public apps/gateway/src/adminWeb.ts apps/gateway/test
git commit -m "feat: manage member agents in Admin Web"
```

---

### Task 10: Admin System Chat/Work Backend

**Files:**
- Create: `apps/gateway/src/adminWorkspace.ts`
- Create: `apps/gateway/src/adminWorkspaceRoutes.ts`
- Modify: `apps/gateway/src/chatWorkDomain.ts`
- Modify: `apps/gateway/src/chatWorkProvider.ts`
- Modify: `apps/gateway/src/chatWorkMessageService.ts`
- Modify: `apps/gateway/src/app.ts`
- Test: `apps/gateway/test/adminWorkspaceRoutes.test.ts`
- Test: `apps/gateway/test/adminWorkspacePrivacy.test.ts`

**Interfaces:**
- Produces Admin-only system workspace summary, Agent Chat, Agent Work, messages, and progress routes.
- Uses `entry_audience='family_admin'`.
- Admin Provider Context has `assignment_ref=null` and is authorized through `admin_agent_assignments`.
- Admin Provider replies use Thread actor `{ type: "agent", agentRef, providerProfileRef }`.

- [ ] **Step 1: Write failing Admin workspace/privacy tests**

Create Jarvis and Codex Admin Chats and assert different Thread and Session refs. Verify:

```ts
expect(jarvis.chat.agentRef).toBe("agent:hermes-jarvis");
expect(codex.chat.agentRef).toBe("agent:codex-cli");
expect(jarvis.chat.threadRef).not.toBe(codex.chat.threadRef);
```

Personal credentials must receive 403 for every Admin workspace route. Admin credentials must receive 404 for a Personal Thread and for another Person's Admin Thread.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWorkspaceRoutes.test.ts adminWorkspacePrivacy.test.ts
```

Expected: FAIL because Admin Chat/Work routes do not exist and current Chat/Work rejects `family_admin`.

- [ ] **Step 3: Add an audience-aware domain context**

```ts
export interface ThreadAccessContext {
  personRef: string;
  familyRef: string | null;
  entryAudience: "personal" | "family_admin";
  agentRef: string;
}
```

All repository reads take this object. Personal callers validate an active personal mount; Admin callers validate same family, same Admin Person, and active `admin_agent_assignments`.

- [ ] **Step 4: Add Admin routes**

Implement:

```text
GET  /api/v1/admin/system-workspace
GET  /api/v1/admin/system-workspace/agents/:agentRef/chat
GET  /api/v1/admin/system-workspace/agents/:agentRef/work-conversations
POST /api/v1/admin/system-workspace/agents/:agentRef/work-conversations
GET  /api/v1/admin/system-workspace/threads/:threadRef/messages
POST /api/v1/admin/system-workspace/threads/:threadRef/messages
GET  /api/v1/admin/system-workspace/work-conversations/:workRef/progress
```

Do not reuse Personal routes or permit client-supplied Person/Family/Provider refs.

- [ ] **Step 5: Commit Agent messages for Admin**

Extend `commitTurnSucceeded()` so `family_admin` Threads insert:

```ts
actor_type: "agent",
actor_assignment_ref: null,
actor_agent_ref: turn.agentRef,
actor_provider_profile_ref: turn.providerProfileRef,
entry_audience: "family_admin"
```

Personal behavior remains `actor_type='assistant'`.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWorkspaceRoutes.test.ts adminWorkspacePrivacy.test.ts chatWorkProvider.test.ts
```

Then:

```bash
git add apps/gateway/src apps/gateway/test
git commit -m "feat: add isolated Admin system workspace"
```

---

### Task 11: Sticky Monitor and Jarvis/Codex Admin Workspace UI

**Files:**
- Create: `apps/gateway/admin-public/admin-workspace.js`
- Modify: `apps/gateway/admin-public/admin-api.js`
- Modify: `apps/gateway/admin-public/admin.js`
- Modify: `apps/gateway/admin-public/index.html`
- Modify: `apps/gateway/admin-public/admin.css`
- Modify: `apps/gateway/src/adminWeb.ts`
- Test: `apps/gateway/test/adminWorkspaceModules.test.ts`
- Test: `apps/gateway/test/adminWeb.test.ts`

**Interfaces:**
- Produces a top sticky compact/detail monitor.
- Produces fixed logical Jarvis/Codex panels with independent Chat/Work state.
- Polls all Agent status every five seconds.

- [ ] **Step 1: Write module tests**

Using the existing lightweight DOM harness, assert:

```ts
expect(monitor.classList.contains("compact")).toBe(true);
expect(monitor.textContent).toContain("空闲");
expect(monitor.textContent).toContain("工作中");
expect(workspace.querySelectorAll("[data-agent-pane]")).toHaveLength(2);
expect(jarvisState.threadRef).not.toBe(codexState.threadRef);
```

Also test switching Jarvis to Work does not change the Codex panel.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWorkspaceModules.test.ts adminWeb.test.ts
```

Expected: FAIL because the workspace module and asset route do not exist.

- [ ] **Step 3: Implement the monitor**

Default compact markup is one sticky row. The detail toggle adds only `activeTurnCount`, `lastCheckedAt`, and `publicProblem`. Every dot has adjacent text. The module clears its poll interval through `destroy()` when Admin state changes.

- [ ] **Step 4: Implement independent panes**

Maintain state keyed by Agent ref:

```js
const panes = new Map([
  ["agent:hermes-jarvis", createPaneState()],
  ["agent:codex-cli", createPaneState()]
]);
```

Each pane owns its selected Chat/Work, messages, draft, busy state, and errors. Never use a shared `activeThreadRef`.

- [ ] **Step 5: Add responsive styling**

Desktop uses `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)`. Narrow screens stack the two pane containers vertically but retain separate headings and state. The monitor remains the first container inside the workspace page and uses `position: sticky`.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWorkspaceModules.test.ts adminWeb.test.ts adminWebModules.test.ts
```

Then:

```bash
git add apps/gateway/admin-public apps/gateway/src/adminWeb.ts apps/gateway/test
git commit -m "feat: add Admin agent monitor and workspace UI"
```

---

### Task 12: Explicit Runtime Composition and Preview Integration

**Files:**
- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/test/config.test.ts`
- Modify: `scripts/member-preview-up.sh`
- Modify: `apps/gateway/test/memberPreviewScripts.test.ts`
- Modify: `Dockerfile`

**Interfaces:**
- Produces validated `GatewayProviderRuntimeConfig`.
- Reconciles configured Agents before onboarding/context resolution.
- Preview runtime discovers Hermes/Codex without printing paths or credentials.

- [ ] **Step 1: Write failing configuration tests**

Test that real runtime mode rejects:

- missing Hermes/Codex executable;
- non-executable file;
- missing Jarvis Home;
- missing Codex working directory;
- duplicate Hermes Profile name;
- a Provider path exposed by config serialization.

Test development Fake mode remains available for automated tests.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test -w @family-ai/gateway -- config.test.ts memberPreviewScripts.test.ts
```

Expected: FAIL because runtime Provider configuration is absent.

- [ ] **Step 3: Parse explicit runtime variables**

Add validated variables:

```text
FAMILY_AI_PROVIDER_MODE=fake|real
FAMILY_AI_HERMES_EXECUTABLE
FAMILY_AI_HERMES_JARVIS_HOME
FAMILY_AI_HERMES_PERSONAL_HOME
FAMILY_AI_HERMES_PROFILES
FAMILY_AI_CODEX_EXECUTABLE
FAMILY_AI_CODEX_WORKING_DIRECTORY
```

Return paths only inside server configuration objects. Never include them in thrown public messages or API responses.

- [ ] **Step 4: Compose Adapters and runtime definitions**

`index.ts` builds:

```ts
const runtime = buildProviderRuntime(config.providerRuntime);
const app = await buildGatewayApp({
  ...gatewayOptions,
  providerRouter: runtime.router,
  configuredAgents: runtime.agents
});
```

`buildGatewayApp()` reconciles the runtime catalog before registering routes and ensures existing owner Admin defaults idempotently.

Use deterministic refs:

```ts
const jarvis = ["agent:hermes-jarvis", "provider-profile:hermes-jarvis"];
const codex = ["agent:codex-cli", "provider-profile:codex-cli"];
const profileAgentRef = `agent:hermes-${profileName}`;
const profileProviderRef = `provider-profile:hermes-${profileName}`;
```

Normalize configured Hermes Profile names to lowercase `[a-z0-9_-]`, reject collisions, and use the Profile name as the initial display label when no separate server-side label is configured.

- [ ] **Step 5: Update protected Preview configuration**

`member-preview-up.sh` resolves executables and homes into the existing mode-0600 ignored `gateway.env`. It prints only fixed readiness/error codes, never discovered paths. Update its exact key allowlist, config fingerprint, ownership checks, and tests.

- [ ] **Step 6: Include Admin assets in the runtime image**

Add:

```dockerfile
COPY --from=build --chown=node:node /app/apps/gateway/admin-public /app/apps/gateway/admin-public
```

No Hermes Home, Codex Home, credential, or host executable is copied into the image.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- config.test.ts memberPreviewScripts.test.ts
```

Then:

```bash
git add apps/gateway/src apps/gateway/test scripts/member-preview-up.sh Dockerfile
git commit -m "feat: compose real Agent runtimes for Preview"
```

---

### Task 13: Full Regression, Live Acceptance, Evidence, and Merge Gate

**Files:**
- Modify: `scripts/acceptance.sh`
- Modify: `README.md`
- Modify: `docs/development/2026-07-28-lan-admin-member-experience.md`
- Create: `docs/superpowers/evidence/2026-07-28-admin-agent-management-system-workspace.md`

**Interfaces:**
- Produces a directly usable Admin URL and Member URL on the existing LAN Preview.
- Produces evidence without secrets, raw Session IDs, Prompt bodies, or Provider output bodies.

- [ ] **Step 1: Update deterministic acceptance**

Every Chat/Work creation in `scripts/acceptance.sh` sends an explicit configured Fake `agentRef`. Add checks for two Agent Chats, two different Provider Context rows, default-null handling, unmount/remount history, and cross-Agent rejection.

- [ ] **Step 2: Run all workspace gates**

Run on `admin-yr`:

```bash
npm ci
npm run check
docker compose build
```

Expected: every test passes, typecheck passes, build passes, and Docker image builds. Record exact test file/test counts from current output.

- [ ] **Step 3: Run deterministic deployment acceptance**

Run:

```bash
./scripts/dev-up.sh
./scripts/acceptance.sh
```

Expected: health, onboarding, multi-Agent Chat/Work, restart recovery, idempotency, sync, and security acceptance all pass.

- [ ] **Step 4: Rebuild the LAN Preview**

Verify remote identity and checkout, then run:

```bash
./scripts/member-preview-lan-down.sh
./scripts/member-preview-lan-up.sh
```

Confirm exact listeners remain Gateway loopback plus owned LAN TLS proxy; verify the existing separate 8790 service bytes, process identity, and listener are unchanged.

- [ ] **Step 5: Run controlled real Provider smoke**

From the Admin system workspace:

1. send one minimal non-sensitive Jarvis message;
2. send a second message and confirm the Adapter resumes the same Hermes Session fingerprint;
3. send one minimal non-sensitive Codex message;
4. send a second message and confirm `codex exec resume` uses the same Codex Session fingerprint;
5. confirm both status sequences include idle → working → idle;
6. restart Gateway and send one further message to each pane.

Record only pass/fail, duration, Agent ref, and a one-way truncated Session fingerprint.

- [ ] **Step 6: Run two-device product acceptance**

Use Windows and one mobile browser for the same member and Agent:

1. terminal A sends round one;
2. terminal B receives it through SSE/sync and sends round two;
3. terminal A receives round two;
4. verify both rounds map to one platform Thread and one explicit Provider Session fingerprint;
5. switch to another Agent and verify a distinct Thread and Session;
6. remove and remount the first Agent and verify history returns;
7. clear default and verify “选择一个 Agent 开始”;
8. remove every mount and verify “管理员尚未为你配置 Agent”.

- [ ] **Step 7: Verify privacy and secret boundaries**

Run repository secret/static checks and query Admin APIs to prove they contain no Personal message body, raw Session ID, stderr, Token, Cookie, or absolute path. Confirm logs and evidence files contain none of the controlled smoke Prompt or response body.

- [ ] **Step 8: Write evidence and product instructions**

The evidence file records:

- branch and commit;
- remote checkout identity;
- test counts and commands;
- typecheck/build/Docker results;
- Preview ownership/listener results;
- Jarvis/Codex health and continuation results;
- Windows/mobile continuation results;
- excluded or failed checks;
- rollback command and pre-change commit.

README tells the user to experience:

1. Admin all-Agent monitor;
2. member Agent mount/default/remove interaction;
3. member temporary Agent switch;
4. same Chat on Windows/mobile;
5. independent Agent Chat/Work;
6. separate Jarvis/Codex Admin workspace.

- [ ] **Step 9: Commit evidence and docs**

```bash
git add scripts/acceptance.sh README.md docs/development docs/superpowers/evidence
git commit -m "docs: record multi-agent workspace acceptance"
```

- [ ] **Step 10: Final merge gate**

Run `git status --short`, confirm it is empty, rerun `npm run check`, and compare the feature diff only against the intended non-legacy `main`. Do not merge if any automated or required real acceptance item is red. After explicit merge approval, merge to `main`, rebuild from `main`, rerun health and product smoke, then remove the clean feature worktree and branch.
