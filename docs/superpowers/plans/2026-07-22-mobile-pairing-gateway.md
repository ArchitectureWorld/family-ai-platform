# Mobile Pairing Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure administrator-issued mobile pairing, device authentication, seven-day personal sessions, revocation, and Web QR management to the existing Gateway.

**Architecture:** Extend the existing V2 family/device/entry model with a forward-only V3 migration and a focused mobile-pairing repository. Keep route parsing and authentication in route modules, transactional identity changes in the repository, and public payload validation in `@family-ai/contracts`.

**Tech Stack:** Node 22, TypeScript 6, Fastify, better-sqlite3, Zod contracts, Vitest, browser acceptance UI.

## Global Constraints

- Pairing codes expire after five minutes, allow five failed attempts, and succeed once.
- Claims create only `personal` entry bindings.
- iOS creates the 32-byte random `deviceCredential`; Gateway stores only SHA-256.
- Personal sessions expire after seven days.
- Device-authenticated endpoints cannot read portal or future Chat data.
- Pairing codes, credentials, session tokens, QR payloads, and Authorization headers never appear in logs, reports, or CI comments.
- All claim and revocation mutations are transactional and idempotent where specified.

---

### Task 1: Add V3 migration tests and schema

**Files:**
- Modify: `apps/gateway/src/database.ts`
- Modify or create: `apps/gateway/test/database.test.ts`

**Interfaces:**
- Produces: `mobile_pairing_codes` and mobile metadata columns consumed by `MobilePairingRepository`.

- [ ] Write failing migration tests proving a V2 database upgrades to V3 and retains existing family records.
- [ ] Add `MIGRATION_V3` with `mobile_pairing_codes`, indexes, and nullable mobile metadata columns on `managed_devices`.
- [ ] Update supported latest schema version from `2` to `3`.
- [ ] Verify foreign keys, WAL mode, and migration ledger remain active.
- [ ] Run `npm run test -w @family-ai/gateway -- database.test.ts` and commit `feat(gateway): add mobile pairing schema v3`.

### Task 2: Add pairing repository with red tests first

**Files:**
- Create: `apps/gateway/src/mobilePairing.ts`
- Create: `apps/gateway/test/mobilePairing.test.ts`

**Interfaces:**
- Consumes: `GatewayDatabase`, mobile-entry contracts, existing family identity tables.
- Produces: `createPairingCode`, `previewPairing`, `claimPairing`, `revokePairingCode`, `renewPersonalSession`, `logoutSession`, `revokeDevice`.

- [ ] Test admin-target validation, expiration, attempt exhaustion, consumption, and revocation.
- [ ] Test claim creates exactly one mobile device, one person-scoped device binding, one personal entry binding, and one seven-day session.
- [ ] Test same `installationId + deviceCredential + pairingRef` returns the original result without duplicate rows.
- [ ] Test a mismatched credential on retry is rejected.
- [ ] Test all persisted secret fields contain hashes and never supplied plaintext.
- [ ] Implement minimal repository methods with `randomBytes`, `randomUUID`, `sha256`, and timing-safe comparisons.
- [ ] Run focused tests and commit `feat(gateway): implement mobile pairing domain`.

### Task 3: Add device authentication and mobile routes

**Files:**
- Create: `apps/gateway/src/mobileRoutes.ts`
- Modify: `apps/gateway/src/server.ts`
- Create: `apps/gateway/test/mobileRoutes.test.ts`

**Interfaces:**
- Consumes: `MobilePairingRepository` and `@family-ai/contracts` schemas.
- Produces HTTP endpoints from the approved design.

- [ ] Write failing route tests for preview, claim, renew, logout, local unbind, admin code creation/revocation, and admin device revocation.
- [ ] Parse `Authorization: Device <credential>` separately from Bearer entry sessions.
- [ ] Validate all request bodies and serialize responses through contract schemas.
- [ ] Map domain failures to stable public error codes.
- [ ] Ensure unknown fields are rejected and no response echoes `deviceCredential`.
- [ ] Register routes in server composition and run focused tests.
- [ ] Commit `feat(gateway): expose mobile pairing and device session APIs`.

### Task 4: Correct entry-session expiration semantics

**Files:**
- Modify: `apps/gateway/src/familyDomain.ts`
- Modify: `apps/gateway/src/familyRoutes.ts`
- Modify tests covering entry authentication.

**Interfaces:**
- Produces distinct `ENTRY_SESSION_EXPIRED` and `ENTRY_SESSION_INVALID` behavior for iOS recovery.

- [ ] Add failing tests distinguishing an expired known session from a missing, revoked, or bad-token session.
- [ ] Replace the single fixed 30-day constant with audience/use-case-specific session creation, preserving development onboarding behavior and using seven days for mobile.
- [ ] Keep token comparisons timing-safe.
- [ ] Commit `fix(gateway): expose stable entry session expiration semantics`.

### Task 5: Integrate pairing controls into the Web member page

**Files:**
- Modify the existing onboarding/admin browser UI files under `apps/gateway/src/browser/` or their actual current location.
- Add or modify browser acceptance tests.

**Interfaces:**
- Consumes admin pairing APIs.
- Produces member-scoped QR generation, countdown, manual code, and immediate revocation.

- [ ] Add a member-row action labelled `生成 iPhone 配对码`.
- [ ] Show family name, member name, five-minute countdown, QR image, manual code, and `立即撤销`.
- [ ] Keep QR and code only in in-memory UI state; clear on close, expiry, or revocation.
- [ ] Display claimed/unclaimed state and active-device count without revealing internal credentials.
- [ ] Add browser acceptance coverage for code generation and revocation.
- [ ] Commit `feat(web): add member-scoped iPhone pairing`.

### Task 6: Add revocation and audit-safe diagnostics

**Files:**
- Modify mobile pairing repository and route tests.
- Modify diagnostic logging helpers if present.

**Interfaces:**
- Produces one revocation path shared by local unbind and administrator remote revoke.

- [ ] Test revocation removes all effective access in one transaction.
- [ ] Test a revoked device cannot renew, fetch portal context, or reuse an old session.
- [ ] Record only refs, status transitions, timestamps, and request IDs.
- [ ] Explicitly redact `code`, `qrPayload`, `authorization`, `deviceCredential`, and `token` keys.
- [ ] Commit `security(gateway): harden mobile credential revocation and logging`.

### Task 7: End-to-end Gateway verification

**Files:**
- Create or modify: `scripts/acceptance-mobile-pairing.sh`
- Modify: `scripts/verify-foundation.sh`
- Update Gateway and architecture documentation.

**Interfaces:**
- Produces repeatable synthetic acceptance without exposing credentials.

- [ ] Start a clean runtime database.
- [ ] Initialize a synthetic family and member.
- [ ] Generate, preview, and claim a synthetic mobile pairing.
- [ ] Fetch portal context, renew, logout, renew again, revoke, and prove final denial.
- [ ] Scan generated reports for known test tokens and sensitive key names.
- [ ] Run `npm run check` and the new acceptance script.
- [ ] Commit `test(gateway): add mobile pairing acceptance flow`.

## Final verification

```bash
npm ci
npm run check
bash scripts/acceptance-mobile-pairing.sh
```

Expected: all commands exit 0; no plaintext pairing code, device credential, session token, or real Tailnet hostname is committed or retained in reports.