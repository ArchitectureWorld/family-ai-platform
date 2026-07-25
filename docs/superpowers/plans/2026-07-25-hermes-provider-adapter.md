# Hermes Provider Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Family AI Gateway to one or more authenticated Hermes Profile API Servers through the existing ProviderAdapter boundary without changing Agent assignments.

**Architecture:** Add a strict Hermes adapter and a profile router to `@family-ai/provider-adapter-sdk`, then add a runtime-only JSON composition loader in Gateway. Development keeps Fake Provider support for unmigrated members; production requires explicit real provider configuration and never falls back to Fake.

**Tech Stack:** Node.js 22, TypeScript, native `fetch`, AbortSignal, Vitest, Fastify, Docker Compose, SQLite-backed existing Gateway Provider Turn subsystem.

## Global Constraints

- Use TDD: every production behavior starts with a failing test.
- Do not modify `clients/ios/**` or `.github/workflows/ios-ci.yml`.
- Do not modify Mobile Entry v1 contracts or fixtures.
- Do not modify Agent assignments in this PR.
- Never commit API keys, runtime provider JSON, Hermes `.env`, logs or SQLite files.
- Never expose API keys, upstream response bodies or stack traces in PublicError.
- Production must never register or silently fall back to Fake Provider.
- Existing Chat / Work Provider Turn, idempotency and Thread Lane semantics remain unchanged.
- The full repository quality gate is `npm run check`.

---

## File Structure

### Create

```text
packages/provider-adapter-sdk/src/hermes.ts
packages/provider-adapter-sdk/src/router.ts
packages/provider-adapter-sdk/test/hermes.test.ts
packages/provider-adapter-sdk/test/router.test.ts
apps/gateway/src/providerRuntime.ts
apps/gateway/test/providerRuntime.test.ts
docs/superpowers/evidence/2026-07-25-hermes-provider-adapter.md
docs/development/2026-07-25-hermes-provider-adapter.md
```

### Modify

```text
packages/provider-adapter-sdk/src/index.ts
apps/gateway/src/config.ts
apps/gateway/src/index.ts
apps/gateway/test/config.test.ts
compose.yaml
scripts/dev-up.sh
```

### Responsibilities

- `hermes.ts`: Hermes profile validation, OpenAI request/response mapping, stable Session Ref, health and error mapping.
- `router.ts`: exact Provider Profile → Adapter routing and aggregate health.
- `providerRuntime.ts`: read ignored JSON, validate runtime composition and construct Fake/Hermes routing per mode.
- `config.ts`: accept `GATEWAY_PROVIDER_CONFIG_PATH`; allow production only with explicit runtime config.
- `index.ts`: build provider adapter before constructing Gateway app.
- Compose: mount ignored config read-only and expose host gateway alias.
- `dev-up.sh`: preserve existing development behavior and add runtime config path only when provider JSON exists.

---

### Task 1: Define Hermes Adapter Request and Session Behavior

**Files:**
- Create: `packages/provider-adapter-sdk/test/hermes.test.ts`
- Create: `packages/provider-adapter-sdk/src/hermes.ts`
- Modify: `packages/provider-adapter-sdk/src/index.ts`

**Interfaces:**
- Consumes: `ProviderInvocationRequest`, `ProviderInvocationResult`, `AdapterHealth` from `@family-ai/contracts`.
- Produces:

```ts
export interface HermesProviderProfileConfig {
  providerProfileRef: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  sessionKey: string;
}

export interface HermesProviderAdapterOptions {
  profiles: HermesProviderProfileConfig[];
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export class HermesProviderAdapter implements ProviderAdapter {
  constructor(options: HermesProviderAdapterOptions);
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
  health(): Promise<AdapterHealth>;
}

export function hermesExternalSessionRef(
  providerProfileRef: string,
  conversationRef: string
): string;
```

- [ ] **Step 1: Write the failing success-mapping test**

Create a test with an injected `fetchImpl` that records URL, headers and JSON body, then returns:

```json
{
  "id": "chatcmpl-test",
  "object": "chat.completion",
  "created": 1784980800,
  "model": "zzh",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "于途已经接入。"},
    "finish_reason": "stop"
  }]
}
```

Assert:

```ts
expect(url).toBe("http://hermes.test:8651/v1/chat/completions");
expect(headers.get("authorization")).toBe("Bearer runtime-key-with-safe-length");
expect(headers.get("idempotency-key")).toBe(request.idempotencyKey);
expect(headers.get("x-hermes-session-id")).toBe(
  hermesExternalSessionRef(request.providerProfileRef, request.conversationRef)
);
expect(headers.get("x-hermes-session-key")).toBe("family-ai:hermes:zzh");
expect(body).toEqual({
  model: "zzh",
  messages: [{ role: "user", content: "你好" }],
  stream: false
});
expect(result).toMatchObject({
  invocationRef: request.invocationRef,
  correlationRef: request.correlationRef,
  status: "succeeded",
  output: [{ type: "text", text: "于途已经接入。" }],
  externalSessionRef: hermesExternalSessionRef(
    request.providerProfileRef,
    request.conversationRef
  )
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -w @family-ai/provider-adapter-sdk -- hermes.test.ts
```

Expected: FAIL because `HermesProviderAdapter` and `hermesExternalSessionRef` do not exist.

- [ ] **Step 3: Implement the minimal success path**

Implement:

```ts
const profileRefPattern = /^provider-profile:[a-z0-9][a-z0-9._:-]{1,126}$/;
const safeTextPattern = /^[^\r\n\0]{1,256}$/;

export function hermesExternalSessionRef(providerProfileRef: string, conversationRef: string): string {
  const digest = createHash("sha256")
    .update(`${providerProfileRef}\n${conversationRef}`)
    .digest("hex")
    .slice(0, 48);
  return `external-session:hermes-${digest}`;
}
```

Normalize `baseUrl` by removing trailing `/`, send native `fetch`, parse JSON, validate a non-empty string at `choices[0].message.content`, preserve the original text and construct a successful Provider result.

- [ ] **Step 4: Run focused test and verify GREEN**

Run the same command. Expected: PASS.

- [ ] **Step 5: Add the existing-session test**

Pass `externalSessionRef: "external-session:hermes-existing"` and assert that exact value is sent in `X-Hermes-Session-Id` and returned unchanged.

- [ ] **Step 6: Run focused test and verify GREEN**

Expected: both tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-adapter-sdk/src/hermes.ts \
  packages/provider-adapter-sdk/src/index.ts \
  packages/provider-adapter-sdk/test/hermes.test.ts
git commit -m "feat(adapter): invoke Hermes Profile API"
```

---

### Task 2: Map Hermes Failure Modes and Health

**Files:**
- Modify: `packages/provider-adapter-sdk/test/hermes.test.ts`
- Modify: `packages/provider-adapter-sdk/src/hermes.ts`

**Interfaces:**
- Consumes: Task 1 `HermesProviderAdapter`.
- Produces deterministic failure mapping and aggregate Hermes health.

- [ ] **Step 1: Write parameterized failing HTTP error tests**

Cases:

```ts
[
  [401, "HERMES_AUTH_FAILED", "permission", false],
  [403, "HERMES_AUTH_FAILED", "permission", false],
  [408, "HERMES_BUSY", "availability", true],
  [429, "HERMES_BUSY", "availability", true],
  [500, "HERMES_UNAVAILABLE", "availability", true],
  [503, "HERMES_UNAVAILABLE", "availability", true],
  [400, "HERMES_REQUEST_REJECTED", "validation", false]
]
```

For each response, assert the adapter returns `status: "failed"`, preserves invocation/correlation refs and never includes the upstream body or API key in the serialized result.

- [ ] **Step 2: Run focused test and verify RED**

Expected: current implementation throws or maps incorrectly.

- [ ] **Step 3: Implement HTTP failure mapping**

Create a helper returning formal Provider result with short fixed Chinese messages. Do not include `response.text()` in user-visible errors.

- [ ] **Step 4: Run focused test and verify GREEN**

- [ ] **Step 5: Write failing timeout and network tests**

Use injected fetch functions:

```ts
async () => { throw new DOMException("aborted", "AbortError"); }
async () => { throw new TypeError("connect ECONNREFUSED runtime-key-with-safe-length"); }
```

Assert timeout maps to `timed_out / HERMES_TIMEOUT`, network to `failed / HERMES_UNAVAILABLE`, and neither error string leaks.

- [ ] **Step 6: Implement timeout and network mapping**

Use `AbortSignal.timeout(request.timeoutMs)` when no signal is injected. Detect `AbortError` by `name` and map all other fetch exceptions to availability.

- [ ] **Step 7: Write failing invalid-response tests**

Cover:

```text
non-JSON response
missing choices
missing message
non-string content
empty or whitespace-only content
```

Assert `HERMES_RESPONSE_INVALID`, internal, retryable.

- [ ] **Step 8: Implement response validation and verify GREEN**

Use structural guards; do not add a dependency solely for the upstream OpenAI response.

- [ ] **Step 9: Write failing health tests**

Inject `/v1/models` responses for two profiles:

```json
{"object":"list","data":[{"id":"jarvis","object":"model"}]}
{"object":"list","data":[{"id":"zzh","object":"model"}]}
```

Assert all successful = online; one failed = degraded; all failed = offline; `providerProfiles` contains only Provider Profile Refs.

- [ ] **Step 10: Implement health and verify GREEN**

Health requests include Bearer auth but no session or idempotency headers.

- [ ] **Step 11: Commit**

```bash
git add packages/provider-adapter-sdk/src/hermes.ts \
  packages/provider-adapter-sdk/test/hermes.test.ts
git commit -m "feat(adapter): harden Hermes errors and health"
```

---

### Task 3: Add Exact Provider Profile Routing

**Files:**
- Create: `packages/provider-adapter-sdk/test/router.test.ts`
- Create: `packages/provider-adapter-sdk/src/router.ts`
- Modify: `packages/provider-adapter-sdk/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface ProviderAdapterRoute {
  providerProfileRefs: string[];
  adapter: ProviderAdapter;
}

export class ProviderAdapterRouter implements ProviderAdapter {
  constructor(routes: ProviderAdapterRoute[], clock?: () => Date);
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
  health(): Promise<AdapterHealth>;
}
```

- [ ] **Step 1: Write failing routing tests**

Create two recording adapters and assert:

- `provider-profile:fake-local` reaches only Fake route;
- `provider-profile:hermes-zzh` reaches only Hermes route;
- unknown profile returns failed `PROVIDER_PROFILE_UNAVAILABLE` without invoking either route;
- duplicate profile registration throws during construction.

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm run test -w @family-ai/provider-adapter-sdk -- router.test.ts
```

- [ ] **Step 3: Implement exact routing**

Build an immutable `Map<string, ProviderAdapter>`. Unknown profile returns a formal failed result using the request refs and clock.

- [ ] **Step 4: Add aggregate health test**

Assert status precedence:

```text
offline > degraded > online
```

and de-duplicate Provider Profile Refs.

- [ ] **Step 5: Implement aggregate health and verify GREEN**

Use `adapter:provider-router` as `adapterRef`.

- [ ] **Step 6: Commit**

```bash
git add packages/provider-adapter-sdk/src/router.ts \
  packages/provider-adapter-sdk/src/index.ts \
  packages/provider-adapter-sdk/test/router.test.ts
git commit -m "feat(adapter): route exact Provider Profiles"
```

---

### Task 4: Load Runtime Provider Composition

**Files:**
- Create: `apps/gateway/test/providerRuntime.test.ts`
- Create: `apps/gateway/src/providerRuntime.ts`

**Interfaces:**
- Produces:

```ts
export interface RuntimeProviderOptions {
  mode: GatewayMode;
  providerConfigPath: string | null;
  readFile?: (path: string) => string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export function loadRuntimeProviderAdapter(options: RuntimeProviderOptions): ProviderAdapter;
```

- [ ] **Step 1: Write failing development fallback test**

Call with `mode: "development", providerConfigPath: null`, invoke `provider-profile:fake-local`, and assert Fake Provider succeeds.

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm run test -w @family-ai/gateway -- providerRuntime.test.ts
```

- [ ] **Step 3: Implement no-file development behavior**

Return `new FakeProviderAdapter()` only for test/development.

- [ ] **Step 4: Write failing strict JSON tests**

Reject:

```text
missing version
version != 1
empty profiles
unknown top-level field
duplicate providerProfileRef
non-http(s) URL
URL credentials
URL query or fragment
short/empty API key
control characters in model/sessionKey
unknown profile kind
```

- [ ] **Step 5: Implement strict parser**

Use explicit object/array/type checks or a local zod schema if already available in Gateway. Normalize base URL by trimming trailing slashes only.

- [ ] **Step 6: Write failing development mixed-routing test**

Provide one Hermes profile JSON. Assert Fake profile still succeeds and Hermes profile calls the injected fetch.

- [ ] **Step 7: Implement mixed router and verify GREEN**

- [ ] **Step 8: Write failing production tests**

Assert production rejects:

```text
null config path
unreadable file
invalid JSON
zero real profiles
fake profile definition
```

Assert valid Hermes JSON constructs an adapter and does not route `provider-profile:fake-local`.

- [ ] **Step 9: Implement production enforcement and verify GREEN**

- [ ] **Step 10: Commit**

```bash
git add apps/gateway/src/providerRuntime.ts \
  apps/gateway/test/providerRuntime.test.ts
git commit -m "feat(gateway): compose runtime Provider adapters"
```

---

### Task 5: Wire Gateway Configuration and Production Startup

**Files:**
- Modify: `apps/gateway/test/config.test.ts`
- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/src/index.ts`

**Interfaces:**
- `GatewayConfig` gains `providerConfigPath: string | null`.
- `index.ts` calls `loadRuntimeProviderAdapter` and passes the result to `buildGatewayApp`.

- [ ] **Step 1: Replace the old production rejection test with failing explicit-config tests**

Assert:

```ts
loadGatewayConfig({
  GATEWAY_MODE: "production",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PROVIDER_CONFIG_PATH: ".runtime/config/providers.json",
  GATEWAY_DEVICE_TOKEN: token
}).providerConfigPath.endsWith("providers.json") === true;
```

Assert production without provider path throws `GATEWAY_PROVIDER_CONFIG_PATH`.

- [ ] **Step 2: Run config test and verify RED**

- [ ] **Step 3: Implement config path handling**

Development defaults to `null`. A supplied path is resolved. Production requires the path but still requires `GATEWAY_DEVICE_TOKEN` because the existing legacy development/device API contract remains present in the process.

- [ ] **Step 4: Run config test and verify GREEN**

- [ ] **Step 5: Add an index composition regression test through source inspection or extracted factory**

Prefer extracting:

```ts
export function buildRuntimeGateway(config: GatewayConfig) { ... }
```

only if needed for testability. Assert the constructed app receives a runtime provider adapter and production no longer relies on the implicit Fake adapter.

- [ ] **Step 6: Implement index wiring**

```ts
const providerAdapter = loadRuntimeProviderAdapter({
  mode: config.mode,
  providerConfigPath: config.providerConfigPath
});
const app = await buildGatewayApp({ ...config, providerAdapter });
```

- [ ] **Step 7: Run Gateway focused tests and verify GREEN**

```bash
npm run test -w @family-ai/gateway -- config.test.ts providerRuntime.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/config.ts apps/gateway/src/index.ts apps/gateway/test/config.test.ts
git commit -m "feat(gateway): start with explicit Provider runtime"
```

---

### Task 6: Make Docker Runtime Reach Host Hermes Safely

**Files:**
- Create or modify test: `apps/gateway/test/providerRuntimeDeployment.test.ts`
- Modify: `compose.yaml`
- Modify: `scripts/dev-up.sh`

**Interfaces:**
- Compose mounts `/app/.runtime/config` read-only.
- `host.docker.internal` resolves to Docker host gateway.
- `dev-up.sh` writes `GATEWAY_PROVIDER_CONFIG_PATH` only when providers JSON exists.

- [ ] **Step 1: Write failing deployment source test**

Read `compose.yaml` and `scripts/dev-up.sh`; assert:

```text
host.docker.internal:host-gateway
./.runtime/config:/app/.runtime/config:ro
GATEWAY_PROVIDER_CONFIG_PATH=/app/.runtime/config/providers.json
```

The script assertion must require conditional inclusion, not unconditional failure when the file is absent.

- [ ] **Step 2: Run focused test and verify RED**

- [ ] **Step 3: Modify Compose**

Add:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
volumes:
  - ./.runtime/config:/app/.runtime/config:ro
  - ./.runtime/data:/app/.runtime/data
```

Keep Gateway port published only on `127.0.0.1`.

- [ ] **Step 4: Modify `dev-up.sh`**

When `.runtime/config/providers.json` exists, append:

```text
GATEWAY_PROVIDER_CONFIG_PATH=/app/.runtime/config/providers.json
```

Do not print the JSON or API keys. Do not overwrite the provider JSON.

- [ ] **Step 5: Run focused test and verify GREEN**

- [ ] **Step 6: Commit**

```bash
git add compose.yaml scripts/dev-up.sh apps/gateway/test/providerRuntimeDeployment.test.ts
git commit -m "build(gateway): mount Hermes runtime configuration"
```

---

### Task 7: Full Integration, Security Review and Evidence

**Files:**
- Modify tests as required by review.
- Create: `docs/superpowers/evidence/2026-07-25-hermes-provider-adapter.md`
- Create: `docs/development/2026-07-25-hermes-provider-adapter.md`

**Interfaces:**
- Produces final verified PR #26 head.

- [ ] **Step 1: Add integration test through `buildGatewayApp`**

Create a temporary SQLite database, initialize a real Family, update only the owner Assistant Assignment in the test database to a Hermes Profile, inject runtime Hermes fetch, send a formal Thread message and assert:

```text
Person message saved
Hermes request received
Assistant message saved
Thread Provider Context stores an external-session:hermes-* ref
second turn reuses the same X-Hermes-Session-Id
another Work receives a different Session ID
```

Do not change production assignments in this PR.

- [ ] **Step 2: Add secret non-leak regression**

Search serialized errors, health, database rows and logs/response fixtures for a sentinel API key and assert it is absent.

- [ ] **Step 3: Run provider and Gateway focused suites**

```bash
npm run test -w @family-ai/provider-adapter-sdk
npm run test -w @family-ai/gateway -- providerRuntime.test.ts hermesProviderIntegration.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full repository gate**

```bash
npm run check
```

Expected: all tests, static checks, typecheck and builds pass.

- [ ] **Step 5: Inspect PR #14 path isolation**

Compare changed paths and assert intersection with:

```text
clients/ios/**
.github/workflows/ios-ci.yml
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
```

is empty.

- [ ] **Step 6: Write evidence and development record**

Record exact RED/GREEN CI run numbers, final head SHA, security boundaries, runtime JSON schema, Docker host-gateway behavior and remaining operational requirement: actual host Hermes profiles must be configured in PR #27.

- [ ] **Step 7: Re-run full repository gate on documentation head**

Expected: PASS.

- [ ] **Step 8: Update Draft PR body and mark Ready**

State explicitly that this PR does not switch Jarvis / 于途 assignments and does not claim live host Hermes acceptance.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/evidence/2026-07-25-hermes-provider-adapter.md \
  docs/development/2026-07-25-hermes-provider-adapter.md
git commit -m "docs: record Hermes Provider Adapter verification"
```

---

## Self-Review

- Spec coverage: Adapter, Router, runtime JSON, production gate, Docker host access, health, error mapping, session continuity, security and PR #14 isolation are each assigned to a task.
- Placeholder scan: no `TODO`, `TBD`, “implement later”, or unspecified test step remains.
- Type consistency: `HermesProviderProfileConfig`, `HermesProviderAdapter`, `ProviderAdapterRouter` and `loadRuntimeProviderAdapter` signatures are stable across tasks.
- Scope: Assignment changes, Hermes Profile creation and Jarvis / 于途 mapping are intentionally excluded and reserved for PR #27.
