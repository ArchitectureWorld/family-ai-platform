# Persistent Admin Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Family Admin sessions and one-time activation codes valid until use, explicit replacement, logout, revocation or failed-attempt lockout.

**Architecture:** Use the existing V15 session schema with a far-future compatibility expiry for new administrator sessions, issue a distinct browser session at each activation, and version the protected activation record so V2 has no operational time expiry. Keep operator recovery local and auditable, with no automatic revival of expired or revoked sessions.

**Tech Stack:** Node.js 22, TypeScript, Fastify, SQLite, Vitest, static browser ES modules.

**Spec:** `docs/superpowers/specs/2026-09-28-persistent-admin-access-design.md`

## Global Constraints

- Only `family_admin` may receive the compatibility expiry `9999-12-31T23:59:59.999Z`; all personal/session paths retain their present expiry. Do not change V15 Schema.
- Activation codes remain `XXXXX-XXXXX`, one use, 10 wrong matches maximum, no time expiry for new V2 records. V1 keeps its original expiry.
- Existing expired/revoked sessions and old expired codes remain invalid. No bootstrap or startup may restore them.
- Secure, HttpOnly, SameSite=Strict, same-origin and CSRF rules remain in force. Secrets stay out of URL, API body, logs, Git and shared inventory.
- No port changes. Isolated tests never touch the formal runtime or provider billing.
- Formal deployment requires backup, recovery, controlled cutover and real browser acceptance under repository release gates.

## Review Focus

- An attacker replacing an activation record during another request must not let the old code succeed afterward; pin with a concurrent test in Task 3.
- A process crash while the activation record is claimed must leave it unusable, not silently retryable; pin with a fault-injection test in Task 3.
- Personal sessions must never receive the administrator compatibility expiry; pin with an onboarding/authentication test in Task 1.
- A revoked admin device or root session must prevent activation and operator recovery; pin with tests in Tasks 2 and 4.
- A browser logout must revoke only its own session, leaving another browser and operator root intact; pin with a route test in Task 2.

---

### Task 1: Revocation-bound administrator session issuance

**Files:**
- Modify: `apps/gateway/src/familyDomain.ts`
- Test: `apps/gateway/test/familyOnboarding.test.ts`

**Interfaces:** Export `ADMIN_ENTRY_EXPIRES_AT = "9999-12-31T23:59:59.999Z"`; initial family_admin uses it, initial personal retains its exact current 30-day expiry. No database migration or SQL predicate changes.

- [ ] **Step 1: Write failing tests** asserting the admin expiry field uses the compatibility upper bound, a personal field retains a bounded 30-day time, and admin context still succeeds after replacing its created_at with a date over a century old while personal context fails.
- [ ] **Step 2: Run** `../../node_modules/.bin/vitest run test/familyOnboarding.test.ts --maxWorkers=1 --no-file-parallelism`; expected RED on admin expiry.
- [ ] **Step 3: Implement** audience-specific expiry on initial issue and export the shared constant.
- [ ] **Step 4: Run the same focused command**; expected PASS.
- [ ] **Step 5: Commit** `feat(gateway): keep administrator root session until revocation`.

### Task 2: Independent browser sessions and logout

**Files:**
- Modify: `apps/gateway/src/familyDomain.ts`
- Modify: `apps/gateway/src/adminProductionActivation.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/src/webEntryCookies.ts`
- Modify: `apps/gateway/admin-public/admin-api.js`, `apps/gateway/admin-public/admin.js`
- Test: `apps/gateway/test/adminProductionActivation.test.ts`, `apps/gateway/test/adminWebModules.test.ts`

**Interfaces:** `activateAdminBrowser(entry, authenticator, repository): {entrySessionRef, token}` creates a new administrator session using `ADMIN_ENTRY_EXPIRES_AT` on the validated admin binding. `POST /api/v1/admin/logout` requires a cookie-backed family_admin session and same-origin request, revokes that session and clears its cookies. Admin cookie persistence refreshes on authenticated admin context fetch; device/binding revocation remains immediate.

- [ ] **Step 1: Write failing route/browser tests** for two different session refs, no operator token in browser cookies, persistence after browser restart, isolated logout, cross-origin rejection and revoked device rejection.
- [ ] **Step 2: Run** `../../node_modules/.bin/vitest run test/adminProductionActivation.test.ts test/adminWebModules.test.ts --maxWorkers=1 --no-file-parallelism`; expected RED on shared token and missing logout.
- [ ] **Step 3: Implement** browser-session repository operation, route changes, cookies and logout UI.
- [ ] **Step 4: Run the same focused command**; expected PASS.
- [ ] **Step 5: Commit** `feat(admin): issue revocable browser sessions`.

### Task 3: Durable activation code without time expiry

**Files:**
- Modify: `apps/gateway/src/adminProductionActivation.ts`
- Modify: `scripts/admin-production-activate.mjs`
- Modify: `apps/gateway/admin-public/index.html`, `apps/gateway/admin-public/admin.js`
- Test: `apps/gateway/test/adminProductionActivation.test.ts`, `apps/gateway/test/adminWebModules.test.ts`, `apps/gateway/test/memberPreviewScripts.test.ts`

**Interfaces:** Version 2 protected record has `version, createdAt, salt, codeHash, failedAttempts`, no expiry. A cross-process exclusive claim protects validate/increment/consume; at 10 wrong attempts the code is locked. V1 retains the old five-minute rule.

- [ ] **Step 1: Write failing tests** for V2 use after months, one-use replay, replacement, ten wrong attempts persisted across app restart, concurrent use, crash fail-closed, and expired V1 rejection. Test UI text and script output without copying secrets to logs.
- [ ] **Step 2: Run** `../../node_modules/.bin/vitest run test/adminProductionActivation.test.ts test/adminWebModules.test.ts test/memberPreviewScripts.test.ts --maxWorkers=1 --no-file-parallelism`; expected RED on V2 cases.
- [ ] **Step 3: Implement** versioned parser, script, persistent counter/claim, and UI copy.
- [ ] **Step 4: Run the same focused command**; expected PASS.
- [ ] **Step 5: Commit** `feat(admin): make one-time activation revocation-bound`.

### Task 4: Protected operator recovery and preflight

**Files:**
- Create: `apps/gateway/src/adminOperatorRecovery.ts`, `apps/gateway/src/adminOperatorCli.ts`
- Modify: `scripts/admin-production-activate.mjs`
- Test: `apps/gateway/test/adminOperatorRecovery.test.ts`, `apps/gateway/test/adminProductionActivation.test.ts`
- Document: `docs/operations/release-and-rollback.md`

**Interfaces:** Local operator command takes protected DB and entry paths; validates old token Hash, expired-but-not-revoked status and active admin binding/device; issues a fresh administrator root session with `ADMIN_ENTRY_EXPIRES_AT` and atomically updates 0600 file with backup/recovery evidence. Activation-code generation fails before writing if its operator Entry cannot authenticate.

- [ ] **Step 1: Write failing tests** for correct recovery, revoked root/device refusal, mismatched token refusal, file-write fault recovery, repeat invocation, and activation preflight.
- [ ] **Step 2: Run** `../../node_modules/.bin/vitest run test/adminOperatorRecovery.test.ts test/adminProductionActivation.test.ts --maxWorkers=1 --no-file-parallelism`; expected RED on missing recovery/preflight.
- [ ] **Step 3: Implement** protected local recovery and preflight using the existing database lock/open-intent patterns.
- [ ] **Step 4: Run the same focused command**; expected PASS.
- [ ] **Step 5: Commit** `feat(admin): recover expired operator root without reviving old session`.

### Task 5: End-to-end verification and handoff

**Files:** Update the spec/plan status, Gateway README and operator runbook with the verified results and rollback procedure.

- [ ] **Step 1: Run** `npm ci`, `npm run check`; capture test counts, typecheck and build result.
- [ ] **Step 2: Build through** `scripts/build-gateway-image.sh` from the exact committed HEAD into a new absolute output directory, then run isolated `dev-up.sh` and `acceptance.sh` with one sealed manifest and random loopback port.
- [ ] **Step 3: Verify browser** activation, second browser, refresh, restart, continued third action, logout, invalid code, and member authorization; record honest PASS/FAIL/SKIP.
- [ ] **Step 4: Prepare the formal release package**: current runtime identity, backup/recovery plan, database copy and Schema V15 identity, exact image, rollback. Do not modify formal runtime before its release Gate.
- [ ] **Step 5: Commit** documentation and report the current deployment state separately from isolated verification.
