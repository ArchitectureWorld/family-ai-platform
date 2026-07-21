# Family AI Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a clean local-only Gateway vertical slice with fixed member-Agent routing, isolated conversations, Fake Provider invocation, safe idempotency, SQLite persistence, and restart recovery.

**Architecture:** Use npm workspaces with three focused units: versioned contracts, Provider Adapter SDK, and Fastify Gateway. Gateway separates HTTP routes, application services, domain policy, and SQLite repositories. The database starts empty except for explicit development bootstrap records; no legacy business data is imported.

**Tech Stack:** Node.js 22, TypeScript, npm workspaces, Fastify, Zod, better-sqlite3, Vitest.

## Global Constraints

- Default host is `127.0.0.1`.
- No legacy business data migration or compatibility layer.
- No real Hermes or Codex invocation in automated tests.
- Authorization precedes idempotency lookup.
- Conversation access always validates both member and Agent.
- Provider sessions never cross Agent/Profile boundaries.
- Provider process environments use explicit allowlists.
- Each task is committed independently.

---

### Task 1: Establish workspace and quality gate

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.github/workflows/ci.yml`
- Test: repository scripts

**Produces:** root scripts `test`, `typecheck`, `build`, and `check`.

- [ ] Create root npm workspace configuration for `apps/*` and `packages/*`.
- [ ] Set Node engine to `>=22 <23` and package manager to npm.
- [ ] Add scripts that run workspace tests, type checks, and builds without invoking real Providers.
- [ ] Ignore `node_modules`, `dist`, `.env`, `*.sqlite*`, logs, coverage, and local uploads.
- [ ] Add CI for pull requests and pushes to `main` using Node 22 and `npm ci && npm run check`.
- [ ] Run `npm install --package-lock-only` and confirm a deterministic lockfile exists.
- [ ] Run `npm run check`; expected result is success even before business packages exist.
- [ ] Commit: `chore: establish workspace quality gate`.

### Task 2: Define versioned contracts

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/messages.ts`
- Create: `packages/contracts/src/provider.ts`
- Test: `packages/contracts/test/contracts.test.ts`

**Produces:**

```ts
export const PROTOCOL_VERSION = "1.0" as const;
export type MessageEnvelope = {
  protocolVersion: "1.0";
  messageRef: string;
  correlationRef: string;
  idempotencyKey: string;
  occurredAt: string;
  source: { kind: "device" | "agent"; ref: string };
  target: { kind: "device" | "agent"; ref: string };
  payload: { type: "text"; text: string; language?: string };
};
```

```ts
export interface ProviderInvocationRequest {
  invocationRef: string;
  correlationRef: string;
  idempotencyKey: string;
  targetAgentRef: string;
  conversationRef: string;
  externalSessionRef?: string;
  content: Array<{ type: "text"; text: string }>;
  timeoutMs: number;
}
```

- [ ] Write tests that reject unknown protocol versions, empty text, invalid refs, and extra fields.
- [ ] Run the tests and verify they fail because schemas do not exist.
- [ ] Implement strict Zod schemas and inferred TypeScript types.
- [ ] Export JSON-safe public error and Provider result types without database fields or local paths.
- [ ] Run contract tests, typecheck, and build.
- [ ] Commit: `feat: define platform contracts`.

### Task 3: Create Provider Adapter SDK and Fake Provider

**Files:**
- Create: `packages/provider-adapter-sdk/package.json`
- Create: `packages/provider-adapter-sdk/tsconfig.json`
- Create: `packages/provider-adapter-sdk/src/index.ts`
- Create: `packages/provider-adapter-sdk/src/fake.ts`
- Test: `packages/provider-adapter-sdk/test/fakeProvider.test.ts`

**Produces:**

```ts
export interface ProviderAdapter {
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
  health(): Promise<AdapterHealth>;
}
```

- [ ] Write a failing test proving two calls with the returned `externalSessionRef` preserve one Fake Provider session.
- [ ] Write a failing test proving Fake Provider can return a safe failed result without stderr or stack details.
- [ ] Implement only the interface and deterministic Fake Provider required by tests.
- [ ] Do not implement Hermes or Codex process execution in this task.
- [ ] Run SDK tests, typecheck, and build.
- [ ] Commit: `feat: add provider adapter boundary`.

### Task 4: Build Gateway database and migrations

**Files:**
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/tsconfig.json`
- Create: `apps/gateway/src/database/openDatabase.ts`
- Create: `apps/gateway/src/database/migrations.ts`
- Create: `apps/gateway/src/database/repositories.ts`
- Create: `apps/gateway/src/bootstrap/developmentBootstrap.ts`
- Test: `apps/gateway/test/database.test.ts`

**Consumes:** contract refs and Provider profile identifiers.

**Produces:** repositories for members, devices, agents, bindings, conversations, messages, Provider sessions, and idempotency records.

- [ ] Write a failing migration test that opens an empty SQLite file twice and expects each version to be applied once.
- [ ] Write a failing bootstrap test that changes an existing device status, reruns bootstrap, and expects the status to remain unchanged.
- [ ] Implement numbered migrations for the initial tables defined in the design.
- [ ] Add foreign keys and indexes for member-Agent conversation access and idempotency scope.
- [ ] Implement bootstrap using insert-if-missing only; never use operational-state upserts.
- [ ] Run database tests and `PRAGMA foreign_key_check` assertions.
- [ ] Commit: `feat: add gateway persistence foundation`.

### Task 5: Implement authorization, conversation, and idempotency services

**Files:**
- Create: `apps/gateway/src/auth/deviceAuthenticator.ts`
- Create: `apps/gateway/src/conversations/conversationPolicy.ts`
- Create: `apps/gateway/src/conversations/conversationService.ts`
- Create: `apps/gateway/src/messages/messageService.ts`
- Create: `apps/gateway/src/idempotency/requestHash.ts`
- Test: `apps/gateway/test/messageService.test.ts`

**Produces:**

```ts
messageService.send({
  device,
  conversationRef,
  envelope
}): Promise<{ status: number; body: unknown; replayed: boolean }>
```

- [ ] Write a failing test for same member but wrong Agent conversation access.
- [ ] Write a failing test proving an unauthorized request cannot receive a cached response.
- [ ] Write a failing test for same idempotency key with different canonical request content returning `IDEMPOTENCY_CONFLICT`.
- [ ] Write a failing test proving identical retries invoke the Provider once.
- [ ] Implement authorization before idempotency lookup.
- [ ] Scope idempotency by device, conversation, Agent, key, and SHA-256 canonical request hash.
- [ ] Persist user and assistant messages plus the Provider session in one transaction after a successful invocation.
- [ ] Serialize sends per conversation in-process for the first stage to prevent external Session races.
- [ ] Run service tests.
- [ ] Commit: `feat: implement isolated gateway messaging`.

### Task 6: Expose the local Gateway API

**Files:**
- Create: `apps/gateway/src/app.ts`
- Create: `apps/gateway/src/config.ts`
- Create: `apps/gateway/src/index.ts`
- Create: `apps/gateway/src/routes/healthRoutes.ts`
- Create: `apps/gateway/src/routes/memberRoutes.ts`
- Create: `apps/gateway/src/routes/conversationRoutes.ts`
- Test: `apps/gateway/test/gatewayApi.test.ts`

- [ ] Write failing API tests for health, authentication, conversation creation, history, two turns, cross-Agent rejection, idempotent replay, and key conflict.
- [ ] Implement strict request validation and stable public error codes.
- [ ] Keep `/health` public while preventing identity or configuration leakage.
- [ ] Require both device ref and Bearer Token for protected routes.
- [ ] Bind to `127.0.0.1` by default and reject non-loopback configuration unless an explicit future feature enables it.
- [ ] Return no SQL errors, stack traces, stderr, secrets, or local paths.
- [ ] Run API tests.
- [ ] Commit: `feat: expose local gateway api`.

### Task 7: Verify restart persistence and developer acceptance

**Files:**
- Create: `apps/gateway/README.md`
- Create: `docs/acceptance/2026-07-21-gateway-foundation.md`
- Modify: `README.md`
- Test: `apps/gateway/test/restartJourney.test.ts`

- [ ] Write a failing journey test that creates a conversation, sends two turns, closes the app, reopens the same SQLite file, and reads the same history and Provider Session binding.
- [ ] Implement only the missing lifecycle behavior required by that test.
- [ ] Document local setup using a temporary development database and Fake Provider.
- [ ] Document manual steps: start Gateway, call health, authenticate test device, create a conversation, send two messages, restart, and recover history.
- [ ] Run `npm ci`.
- [ ] Run `npm test`; record total, passed, failed, and skipped counts.
- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Search the repository for old database names, legacy paths, secrets, and `/home/` absolute paths; expected result is no production references.
- [ ] Commit: `test: verify gateway foundation journey`.

## Pull Request Boundary

The implementation PR contains only the first local Gateway vertical slice. It does not include legacy data migration, RBAC, browser sessions, pairing, attachments, real Provider execution, Member/Admin Web, LAN exposure, TLS, or mobile clients.

The PR body must report architecture impact, database impact, security impact, exact test evidence, manual acceptance, and rollback. Rollback is reverting the PR and deleting the disposable new Gateway SQLite file; no old platform data is touched.
