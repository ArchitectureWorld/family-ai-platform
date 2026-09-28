# Persistent Admin Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Family Admin sessions and one-time activation codes valid until use, explicit replacement, logout, revocation or failed-attempt lockout.

**Architecture:** Add an explicit administrator session lifetime policy in Gateway V16, issue a distinct browser session at each activation, and version the protected activation record so V2 has no time expiry. Keep operator recovery local and auditable, with no automatic revival of expired or revoked sessions.

**Tech Stack:** Node.js 22, TypeScript, Fastify, SQLite, Vitest, static browser ES modules.

**Spec:** `docs/superpowers/specs/2026-09-28-persistent-admin-access-design.md`

## Global Constraints

- Only `family_admin` may use `until_revoked`; all personal/session paths retain their present expiry.
- Activation codes remain `XXXXX-XXXXX`, one use, 10 wrong matches maximum, no time expiry for new V2 records. V1 keeps its original expiry.
- Existing expired/revoked sessions and old expired codes remain invalid. No bootstrap or startup may restore them.
- Secure, HttpOnly, SameSite=Strict, same-origin and CSRF rules remain in force. Secrets stay out of URL, API body, logs, Git and shared inventory.
- No port changes. Isolated tests never touch the formal runtime or provider billing.
- Formal deployment requires backup, recovery, controlled cutover and real browser acceptance under repository release gates.

## Review Focus

- An attacker replacing an activation record during another request must not let the old code succeed afterward; pin with a concurrent test in Task 3.
- A process crash while the activation record is claimed must leave it unusable, not silently retryable; pin with a fault-injection test in Task 3.
- Personal sessions must never gain no-expiry semantics through a malformed policy or binding; pin with a migration/authentication test in Task 1.
- A revoked admin device or root session must prevent activation and operator recovery; pin with tests in Tasks 2 and 4.
- A browser logout must revoke only its own session, leaving another browser and operator root intact; pin with a route test in Task 2.

---

### Task 1: Explicit administrator lifetime policy

**Files:**
- Modify: `apps/gateway/src/database.ts`
- Modify: `apps/gateway/src/familyDomain.ts`
- Modify: `apps/gateway/src/entrySessionAuth.ts`
- Modify: `apps/gateway/src/federationRepository.ts`
- Test: `apps/gateway/test/database.test.ts`, `apps/gateway/test/entrySessionAuth.test.ts`, `apps/gateway/test/familyOnboarding.test.ts`, `apps/gateway/test/federationRepository.test.ts`

**Interfaces:** V16 `entry_sessions.expiration_policy: 'fixed' | 'until_revoked'` defaults to `fixed`; `until_revoked` requires a family_admin binding. Add one shared SQL predicate/helper for authenticated Entry reads. Initial admin uses `until_revoked`, initial personal remains `fixed`.

- [ ] **Step 1: Write failing tests** for V15→V16 migration preserving fixed rows, personal policy rejection, admin authorization beyond 30 days, personal expiry, and federation actor context issuance by a persistent admin.
- [ ] **Step 2: Run** `npm test -w @family-ai/gateway -- database.test.ts entrySessionAuth.test.ts familyOnboarding.test.ts federationRepository.test.ts`; expected RED on missing policy/migration.
- [ ] **Step 3: Implement** V16 migration, writer policy and all direct Entry expiry predicates.
- [ ] **Step 4: Run the same focused command**; expected all selected tests PASS.
- [ ] **Step 5: Commit** `feat(gateway): support revocation-bound admin sessions`.

### Task 2: Independent browser sessions and logout

**Files:**
- Modify: `apps/gateway/src/adminProductionActivation.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/src/webEntryCookies.ts`
- Modify: `apps/gateway/admin-public/admin-api.js`, `apps/gateway/admin-public/admin.js`
- Test: `apps/gateway/test/adminProductionActivation.test.ts`, `apps/gateway/test/adminWebModules.test.ts`

**Interfaces:** `activateAdminBrowser(entry, authenticator, repository): {entrySessionRef, token}` creates a new `until_revoked` session on the validated admin binding. `POST /api/v1/admin/logout` requires a cookie-backed family_admin session and same-origin request, revokes that session and clears its cookies. Admin cookie persistence refreshes on authenticated admin context fetch; device/binding revocation remains immediate.

- [ ] **Step 1: Write failing route/browser tests** for two different session refs, no operator token in browser cookies, persistence after browser restart, isolated logout, cross-origin rejection and revoked device rejection.
- [ ] **Step 2: Run** `npm test -w @family-ai/gateway -- adminProductionActivation.test.ts adminWebModules.test.ts`; expected RED on shared token and missing logout.
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
- [ ] **Step 2: Run** `npm test -w @family-ai/gateway -- adminProductionActivation.test.ts adminWebModules.test.ts memberPreviewScripts.test.ts`; expected RED on V2 cases.
- [ ] **Step 3: Implement** versioned parser, script, persistent counter/claim, and UI copy.
- [ ] **Step 4: Run the same focused command**; expected PASS.
- [ ] **Step 5: Commit** `feat(admin): make one-time activation revocation-bound`.

### Task 4: Protected operator recovery and preflight

**Files:**
- Create: `apps/gateway/src/adminOperatorRecovery.ts`, `apps/gateway/src/adminOperatorCli.ts`
- Modify: `scripts/admin-production-activate.mjs`
- Test: `apps/gateway/test/adminOperatorRecovery.test.ts`, `apps/gateway/test/adminProductionActivation.test.ts`
- Document: `docs/operations/release-and-rollback.md`

**Interfaces:** Local operator command takes protected DB and entry paths; validates old token Hash, expired-but-not-revoked status and active admin binding/device; issues a fresh `until_revoked` root session and atomically updates 0600 file with backup/recovery evidence. Activation-code generation fails before writing if its operator Entry cannot authenticate.

- [ ] **Step 1: Write failing tests** for correct recovery, revoked root/device refusal, mismatched token refusal, file-write fault recovery, repeat invocation, and activation preflight.
- [ ] **Step 2: Run** `npm test -w @family-ai/gateway -- adminOperatorRecovery.test.ts adminProductionActivation.test.ts`; expected RED on missing recovery/preflight.
- [ ] **Step 3: Implement** protected local recovery and preflight using the existing database lock/open-intent patterns.
- [ ] **Step 4: Run the same focused command**; expected PASS.
- [ ] **Step 5: Commit** `feat(admin): recover expired operator root without reviving old session`.

### Task 5: End-to-end verification and handoff

**Files:** Update the spec/plan status, Gateway README and operator runbook with the verified results and rollback procedure.

- [ ] **Step 1: Run** `npm ci`, `npm run check`; capture test counts, typecheck and build result.
- [ ] **Step 2: Build through** `scripts/build-gateway-image.sh` from the exact committed HEAD into a new absolute output directory, then run isolated `dev-up.sh` and `acceptance.sh` with one sealed manifest and random loopback port.
- [ ] **Step 3: Verify browser** activation, second browser, refresh, restart, continued third action, logout, invalid code, and member authorization; record honest PASS/FAIL/SKIP.
- [ ] **Step 4: Prepare the formal release package**: current runtime identity, backup/recovery plan, DB migration copy, exact image, rollback. Do not modify formal runtime before its release Gate.
- [ ] **Step 5: Commit** documentation and report the current deployment state separately from isolated verification.
