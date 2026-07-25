# Jarvis / 于途 Hermes Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure and bind Family Admin to Hermes Jarvis and the active Family Owner’s personal assistant to Hermes zzh/于途, while preserving other members and providing a safe one-command host configuration workflow.

**Architecture:** Add a fixed, reviewed assignment preset and transactional migration repository inside Gateway. Pass preset-derived defaults into family onboarding, then add an idempotent host configuration script that prepares the two Hermes profiles, writes ignored runtime provider configuration, starts profile gateways with timeouts, and activates the preset only when the complete local configuration exists.

**Tech Stack:** Node.js 22, TypeScript, better-sqlite3, Vitest, Python 3 standard library, Bash, Hermes Agent CLI/API Server, Docker Compose.

## Global Constraints

- This branch depends on PR #28 and must not merge before it.
- Every behavior change starts with a failing test.
- The only accepted preset is `hermes-jarvis-yutu-v1`.
- Never accept arbitrary Person, Agent or Provider refs from environment configuration.
- Migrate only active Family Manager assignments and active owner Personal Assistant assignments.
- Do not modify non-owner Assistant assignments.
- Preserve historical assignments by ending them; do not overwrite their identity.
- Reapplying the preset must be idempotent.
- New non-owner members continue to use the existing Fake Personal Assistant.
- Never commit or print Hermes API keys.
- Never overwrite an existing Hermes `config.yaml`, `SOUL.md`, memory, skills or sessions.
- Do not modify `clients/ios/**`, `.github/workflows/ios-ci.yml`, Mobile Entry contracts or fixtures.
- Full repository gate: `npm run check`.

---

## File Structure

### Create

```text
apps/gateway/src/agentAssignments.ts
apps/gateway/test/agentAssignments.test.ts
apps/gateway/test/agentAssignmentPresetIntegration.test.ts
apps/gateway/test/hermesAssignmentSessionSwitch.test.ts
apps/gateway/test/hermesConfigurationScript.test.ts
scripts/configure-hermes.py
scripts/configure-hermes.sh
docs/superpowers/evidence/2026-07-25-hermes-jarvis-yutu-bindings.md
docs/development/2026-07-25-hermes-jarvis-yutu-bindings.md
```

### Modify

```text
apps/gateway/src/app.ts
apps/gateway/src/config.ts
apps/gateway/src/familyDomain.ts
apps/gateway/src/index.ts
apps/gateway/test/config.test.ts
scripts/dev-up.sh
README.md
```

### Responsibilities

- `agentAssignments.ts`: constants, preset parsing, controlled defaults, transactional idempotent migration.
- `familyDomain.ts`: consume injected defaults for onboarding and new-member assignment.
- `app.ts`: apply preset before authentication/routes and pass defaults to Family domain.
- `config.ts`: parse exact preset string.
- `configure-hermes.py`: profile/env/provider JSON/service/health orchestration without secret output.
- `configure-hermes.sh`: small stable wrapper locating repo root and Python.
- `dev-up.sh`: enable preset only when provider JSON and marker both exist.

---

### Task 1: Define Controlled Agent Defaults and Existing-Family Migration

**Files:**
- Create: `apps/gateway/test/agentAssignments.test.ts`
- Create: `apps/gateway/src/agentAssignments.ts`

**Produces:**

```ts
export type AgentAssignmentPreset = "hermes-jarvis-yutu-v1";

export interface AgentTarget {
  agentRef: string;
  displayName: string;
  providerProfileRef: string;
  providerKind: "fake" | "hermes" | "codex";
  providerDisplayName: string;
}

export interface FamilyAgentDefaults {
  familyManager: AgentTarget;
  ownerAssistant: AgentTarget;
  memberAssistant: AgentTarget;
}

export const DEVELOPMENT_AGENT_DEFAULTS: FamilyAgentDefaults;
export const HERMES_JARVIS_YUTU_DEFAULTS: FamilyAgentDefaults;

export function agentDefaultsForPreset(
  preset: AgentAssignmentPreset | null
): FamilyAgentDefaults;

export interface AgentAssignmentMigrationResult {
  preset: AgentAssignmentPreset;
  familyManagersMigrated: number;
  ownersMigrated: number;
  familyManagersAlreadyCurrent: number;
  ownersAlreadyCurrent: number;
}

export class AgentAssignmentRepository {
  constructor(db: GatewayDatabase, now?: () => Date);
  applyPreset(preset: AgentAssignmentPreset | null): AgentAssignmentMigrationResult | null;
}
```

- [ ] **Step 1: Write a failing migration test**

Build a real temporary Gateway database and initialize a Family with one owner and one additional adult using existing Family domain behavior. Apply `hermes-jarvis-yutu-v1`. Assert:

```text
provider-profile:hermes-jarvis kind=hermes exists
provider-profile:hermes-zzh kind=hermes exists
agent:jarvis display=Jarvis exists
agent:yutu display=于途 exists
old active family manager assignment is ended with effective_to
new active family manager assignment targets Jarvis
old owner assistant assignment is ended with effective_to
new active owner assistant assignment targets 于途 / zzh
adult assistant assignment remains agent:personal-assistant / fake-local
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm run test -w @family-ai/gateway -- agentAssignments.test.ts
```

Expected: module/classes do not exist.

- [ ] **Step 3: Implement constants and transactional migration**

Use one `db.transaction()`. Register targets with controlled SQL. Before reusing an existing Provider Profile Ref, require its `provider_kind` to equal the target kind or throw `Provider Profile kind conflict`. End old active assignments and insert new `assignment:${randomUUID()}` rows.

- [ ] **Step 4: Run focused test and verify GREEN**

- [ ] **Step 5: Write failing idempotency and conflict tests**

Apply the preset twice and assert the second result reports `AlreadyCurrent` counts and assignment row counts do not increase. Insert a conflicting `provider-profile:hermes-zzh` with kind `codex` and assert the transaction fails without partial Jarvis/Yutu migration.

- [ ] **Step 6: Implement idempotency/conflict behavior and verify GREEN**

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/agentAssignments.ts apps/gateway/test/agentAssignments.test.ts
git commit -m "feat(gateway): migrate Jarvis and Yutu assignments"
```

---

### Task 2: Use Preset Defaults for New Families and New Members

**Files:**
- Create: `apps/gateway/test/agentAssignmentPresetIntegration.test.ts`
- Modify: `apps/gateway/src/familyDomain.ts`

**Consumes:** `FamilyAgentDefaults` and `agentDefaultsForPreset()`.

- [ ] **Step 1: Write failing new-family defaults test**

Construct `FamilyDomainRepository` with `HERMES_JARVIS_YUTU_DEFAULTS`, initialize a Family, authenticate both returned Entry Sessions and assert:

```text
admin context assignmentType=family_manager
admin context agentRef=agent:jarvis
admin context displayName=Jarvis
admin context providerProfileRef=provider-profile:hermes-jarvis
personal context agentRef=agent:yutu
personal context displayName=于途
personal context providerProfileRef=provider-profile:hermes-zzh
```

- [ ] **Step 2: Run test and verify RED**

Expected: repository constructor/defaults are unsupported.

- [ ] **Step 3: Inject defaults into Family domain**

Add:

```ts
export interface FamilyDomainRepositoryOptions {
  defaults?: FamilyAgentDefaults;
}
```

Default to `DEVELOPMENT_AGENT_DEFAULTS` to preserve existing tests. Replace hardcoded manager/owner/member assignment refs with injected defaults and use an internal `ensureAgentTarget()` helper.

- [ ] **Step 4: Run focused test and verify GREEN**

- [ ] **Step 5: Add failing non-owner member test**

After initializing with Hermes defaults, call `createMember()` and assert the new adult receives `agent:personal-assistant / provider-profile:fake-local`, not `agent:yutu`.

- [ ] **Step 6: Implement/verify member-default behavior**

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/familyDomain.ts apps/gateway/test/agentAssignmentPresetIntegration.test.ts
git commit -m "feat(gateway): apply Agent defaults during onboarding"
```

---

### Task 3: Wire the Preset Through Gateway Startup

**Files:**
- Modify: `apps/gateway/test/config.test.ts`
- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/test/agentAssignmentPresetIntegration.test.ts`

**Interfaces:**

```ts
GatewayConfig.assignmentPreset: AgentAssignmentPreset | null;
BuildGatewayAppOptions.assignmentPreset?: AgentAssignmentPreset | null;
```

- [ ] **Step 1: Write failing config tests**

Assert absent env → `null`; exact `hermes-jarvis-yutu-v1` → accepted; any other value → throws `GATEWAY_AGENT_ASSIGNMENT_PRESET`.

- [ ] **Step 2: Run config tests and verify RED**

- [ ] **Step 3: Implement exact config parsing**

Do not accept comma-separated values, arbitrary refs or case variants.

- [ ] **Step 4: Add failing app migration integration test**

Create an existing Fake-backed Family using one app instance, close it, reopen the same database with `assignmentPreset: "hermes-jarvis-yutu-v1"` and a Provider Adapter that owns both Hermes refs. Assert existing Admin and Personal contexts switch immediately and second reopen is idempotent.

- [ ] **Step 5: Implement startup ordering**

Inside `buildGatewayApp()`:

```text
open database
run development bootstrap when applicable
apply preset
construct FamilyDomainRepository(defaults)
construct authenticators/routes
```

`index.ts` forwards `config.assignmentPreset`.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm run test -w @family-ai/gateway -- config.test.ts agentAssignmentPresetIntegration.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/config.ts apps/gateway/src/index.ts \
  apps/gateway/test/config.test.ts apps/gateway/test/agentAssignmentPresetIntegration.test.ts
git commit -m "feat(gateway): activate controlled Agent assignment preset"
```

---

### Task 4: Verify Existing Chat Switches Provider Context Safely

**Files:**
- Create: `apps/gateway/test/hermesAssignmentSessionSwitch.test.ts`

- [ ] **Step 1: Write the end-to-end transition test**

Use one temporary database and a Router owning Fake plus Hermes zzh. Before applying the preset:

```text
initialize Family
open Home Chat
send one message through Fake
assert external_session_ref starts external-session:fake-
```

Restart with preset and send the next message. Assert:

```text
same Home Chat threadRef
new Assistant actor agentRef=agent:yutu
new Assistant providerProfileRef=provider-profile:hermes-zzh
stored external_session_ref starts external-session:hermes-
old Fake Assistant message remains in history
```

Also verify a failed pre-switch Provider Turn, when retried after preset activation, receives a new invocation/correlation/idempotency identity tied to the new Assignment.

- [ ] **Step 2: Run test and verify behavior**

If it fails, fix only the source boundary exposed by the test; existing `ChatWorkProviderRepository` is expected to handle the switch without schema changes.

- [ ] **Step 3: Run full Gateway provider suites**

```bash
npm run test -w @family-ai/gateway -- hermesAssignmentSessionSwitch.test.ts chatWorkProvider*.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/test/hermesAssignmentSessionSwitch.test.ts
git commit -m "test(gateway): verify live Assistant assignment transition"
```

---

### Task 5: Build Idempotent Hermes Profile Configuration

**Files:**
- Create: `apps/gateway/test/hermesConfigurationScript.test.ts`
- Create: `scripts/configure-hermes.py`
- Create: `scripts/configure-hermes.sh`

**CLI:**

```text
./scripts/configure-hermes.sh [--configure-only] [--no-health-check]
```

- [ ] **Step 1: Write failing configure-only test**

The test creates a temporary repo/runtime path, a temporary `HERMES_HOME`, and a fake `hermes` executable that records arguments and creates requested profile directories. Run:

```bash
python3 scripts/configure-hermes.py --repo-root <temp> --hermes-home <temp> --configure-only
```

Assert:

```text
jarvis and zzh profile create commands are called only when absent
existing config.yaml and SOUL.md byte content is unchanged
profile .env contains required API_SERVER values
existing API_SERVER_KEY is preserved
missing key is generated as 64 lowercase hex characters
unrelated .env lines/comments are preserved
.runtime/config/providers.json contains both exact profiles and host.docker.internal URLs
marker file exists
.env and providers.json mode is 0600
stdout/stderr contain neither key
second run is idempotent
```

- [ ] **Step 2: Run focused test and verify RED**

Expected: scripts do not exist.

- [ ] **Step 3: Implement strict Python configuration core**

Use only Python standard library. Parse `.env` line-by-line, replace only exact keys, append missing keys, atomically write through a sibling temporary file plus `os.replace()`, then `chmod(0o600)`. Serialize provider JSON with `indent=2` and no key output.

- [ ] **Step 4: Add wrapper test and implementation**

The Bash wrapper must find repo root, require `python3`, and `exec` the Python script with all arguments. It must not use `set -x`.

- [ ] **Step 5: Run focused test and verify GREEN**

- [ ] **Step 6: Commit**

```bash
git add scripts/configure-hermes.py scripts/configure-hermes.sh \
  apps/gateway/test/hermesConfigurationScript.test.ts
git commit -m "feat(hermes): configure Jarvis and zzh profiles safely"
```

---

### Task 6: Start Hermes Profiles with Timeouts and Verify Health

**Files:**
- Modify: `apps/gateway/test/hermesConfigurationScript.test.ts`
- Modify: `scripts/configure-hermes.py`

- [ ] **Step 1: Write failing service orchestration test**

Use the fake `hermes` executable and a local fake HTTP server. Assert default mode:

```text
hermes -p jarvis gateway restart
hermes -p zzh gateway restart
```

Each command has a finite timeout. If restart fails, assert fallback command sequence:

```text
gateway install --force
gateway start
```

No command receives or prints an API Key.

- [ ] **Step 2: Implement subprocess orchestration**

Use `subprocess.run(..., timeout=30, check=False, capture_output=True, text=True)`. Print only sanitized profile/status summaries. A timeout or final failure exits non-zero.

- [ ] **Step 3: Write failing health tests**

Serve `/v1/models` for ports supplied through test-only CLI overrides. Require Bearer auth and correct model id. Test one wrong model and one 401 response produce non-zero exit without secret output.

- [ ] **Step 4: Implement health checks**

Use `urllib.request` with `Authorization` and a bounded timeout. Parse JSON structurally and require the configured model id.

- [ ] **Step 5: Verify `--configure-only` and `--no-health-check`**

`--configure-only` must not execute service or health calls. `--no-health-check` may start services but skip model checks.

- [ ] **Step 6: Commit**

```bash
git add scripts/configure-hermes.py apps/gateway/test/hermesConfigurationScript.test.ts
git commit -m "feat(hermes): start and verify profile API servers"
```

---

### Task 7: Activate Preset Only for Complete Local Configuration

**Files:**
- Modify: `apps/gateway/test/providerRuntimeDeployment.test.ts`
- Modify: `scripts/dev-up.sh`

- [ ] **Step 1: Write failing marker-gate test**

Assert `dev-up.sh` appends `GATEWAY_AGENT_ASSIGNMENT_PRESET=hermes-jarvis-yutu-v1` only when both exist:

```text
.runtime/config/providers.json
.runtime/config/hermes-jarvis-yutu.enabled
```

Provider JSON without marker must not silently migrate Assignments.

- [ ] **Step 2: Run test and verify RED**

- [ ] **Step 3: Implement marker gate**

Keep the current conditional Provider config path. Nest or separately require both files for the preset line. Never read or print provider JSON.

- [ ] **Step 4: Run focused test and verify GREEN**

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-up.sh apps/gateway/test/providerRuntimeDeployment.test.ts
git commit -m "build(gateway): enable Jarvis and Yutu preset safely"
```

---

### Task 8: Product-Level Assignment and Privacy Verification

**Files:**
- Add/modify Gateway tests as needed.

- [ ] **Step 1: Verify formal Entry contexts**

Through normal API routes, assert Admin context exposes Jarvis and Owner Personal context exposes 于途. Assert another member context remains Personal Assistant/Fake.

- [ ] **Step 2: Verify normal Member Web Chat uses zzh**

Use a real Web Entry Cookie claim and normal Chat POST. Assert Hermes zzh receives the request, Assistant message is persisted and the response appears through the existing message route/sync event—not through a test-only endpoint.

- [ ] **Step 3: Verify secrets are absent**

Use sentinel keys and search:

```text
HTTP responses
SQLite domain tables
Gateway log capture
script stdout/stderr
committed files
```

- [ ] **Step 4: Run focused product suites**

```bash
npm run test -w @family-ai/gateway -- agentAssignment*.test.ts \
  hermesAssignmentSessionSwitch.test.ts hermesConfigurationScript.test.ts \
  memberProductFlow.test.ts
```

- [ ] **Step 5: Commit review fixes if needed**

Use narrow commits with a failing regression test before every behavior fix.

---

### Task 9: Documentation, Full Gate and PR Completion

**Files:**
- Create: `docs/superpowers/evidence/2026-07-25-hermes-jarvis-yutu-bindings.md`
- Create: `docs/development/2026-07-25-hermes-jarvis-yutu-bindings.md`
- Modify: `README.md`

- [ ] **Step 1: Run full repository gate**

```bash
npm run check
```

Expected: all tests, static checks, typecheck and builds pass.

- [ ] **Step 2: Verify changed-path isolation**

Intersection with PR #14 paths must be empty.

- [ ] **Step 3: Write evidence and development record**

Record exact RED/GREEN CI runs, assignment migration counts, idempotency, normal Entry/Chat product test, script security, and the distinction between automated fake-host verification and actual Linux host acceptance.

- [ ] **Step 4: Update README**

Document the one-command setup:

```bash
./scripts/configure-hermes.sh
```

Explain Jarvis/于途 mapping without publishing keys.

- [ ] **Step 5: Re-run full gate on final documentation head**

- [ ] **Step 6: Update stacked PR body and mark Ready**

State that the PR depends on #28 and cannot merge first. Do not claim actual host success unless the command has been executed on the user's Linux machine.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/superpowers/evidence/2026-07-25-hermes-jarvis-yutu-bindings.md \
  docs/development/2026-07-25-hermes-jarvis-yutu-bindings.md
git commit -m "docs: record Jarvis and Yutu Hermes integration"
```

---

## Self-Review

- Spec coverage: existing migration, new-family defaults, non-owner isolation, live Thread switch, host profile config, service startup, health, marker gate, normal product verification and security each have a task.
- Placeholder scan: no TODO/TBD or undefined behavior step remains.
- Type consistency: fixed preset/default/repository interfaces are reused throughout.
- Scope: no Family Admin Chat is invented; Admin verification is context-only until that product domain exists.
