# Member Web Entry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real browser Device / Personal Entry flow with HttpOnly Cookie authentication and make `/member/` the normal product entry used by one-click experience verification.

**Architecture:** Add strict Web Entry contracts, a Gateway repository that consumes existing one-time Person pairing material, a Cookie authentication bridge for existing personal APIs, and a minimal product shell. Existing Mobile Entry v1 and iOS files remain untouched.

**Tech Stack:** TypeScript 6, Zod 4, Fastify 5, SQLite/better-sqlite3, Vitest 4, browser ES modules, GitHub Actions.

## Global Constraints

- Work only on `feat/web-entry-foundation`, based on `main` commit `80107e10764bc0160bd977f3d8b8b8219b03c175`.
- Do not modify `clients/ios/**`, `.github/workflows/ios-ci.yml`, `packages/contracts/src/mobileEntry.ts`, `packages/contracts/fixtures/mobile-entry/**`, `apps/gateway/src/mobilePairing.ts`, or `apps/gateway/src/mobileRoutes.ts`.
- Production authentication cookies are `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure`.
- Test/development cookies omit `Secure` to support local HTTP.
- JSON responses never contain Device Credential or Entry Session Token.
- Existing Authorization Header authentication takes precedence over Cookie authentication.
- Cookie-authenticated unsafe methods require `X-Family-AI-Web-Request: 1` and same-origin request metadata.
- Root `/` redirects to `/member/`; the development acceptance console is not registered.
- Every behavior phase follows RED → observed failing CI → minimal GREEN → observed passing CI.

---

## File Map

### New files

- `packages/contracts/src/webEntry.ts` — Web Entry v1 schemas and types.
- `packages/contracts/test/webEntry.test.ts` — strict protocol tests.
- `packages/contracts/fixtures/web-entry/*.json` — synthetic public fixtures.
- `apps/gateway/src/webEntryCookies.ts` — Cookie names, parse/serialize/clear helpers, bridge security checks.
- `apps/gateway/src/webEntry.ts` — Web pairing claim and Device/Session lifecycle repository.
- `apps/gateway/src/webEntryRoutes.ts` — claim/context/renew/logout/revoke routes and Cookie bridge registration.
- `apps/gateway/src/memberWeb.ts` — static `/member/` product shell registration and root redirect.
- `apps/gateway/member-public/index.html` — minimal real product entry shell.
- `apps/gateway/member-public/entry.js` — claim/context/session lifecycle client.
- `apps/gateway/member-public/member.css` — responsive product shell styling.
- `apps/gateway/test/webEntryContracts.test.ts` — contract integration.
- `apps/gateway/test/webEntryRepository.test.ts` — pairing, idempotency, lifecycle.
- `apps/gateway/test/webEntryRoutes.test.ts` — Cookie/security/route integration.
- `apps/gateway/test/webEntryBridge.test.ts` — existing Chat/Work/Sync authentication through Cookie.
- `apps/gateway/test/memberWeb.test.ts` — static product entry and retired acceptance route assertions.
- `docs/superpowers/evidence/2026-07-25-member-web-entry-foundation.md` — final evidence.

### Modified files

- `packages/contracts/src/index.ts` — export Web Entry v1.
- `apps/gateway/src/app.ts` — install bridge, routes, static product shell, and stop registering the development console.
- `Dockerfile` — copy `apps/gateway/member-public` into runtime.
- `scripts/acceptance-onboarding.sh` — output a real `/member/` pairing link.
- `scripts/verify-foundation.sh` — describe product workbench experience rather than an acceptance console.

---

### Task 1: Freeze Web Entry public protocol

**Files:**
- Create fixtures under `packages/contracts/fixtures/web-entry/`.
- Create `packages/contracts/test/webEntry.test.ts`.
- Create `packages/contracts/src/webEntry.ts`.
- Modify `packages/contracts/src/index.ts`.

**Interfaces:**
- Produces `WEB_ENTRY_PROTOCOL_VERSION`, `webPairingClaimRequestSchema`, `webEntryContextResponseSchema`, `webEntryOperationResponseSchema` and inferred types.

- [ ] Add canonical claim/context/operation fixtures containing no credentials.
- [ ] Add failing tests for strict fields, UUID installation, browser descriptor and forbidden trusted identity/credential fields.
- [ ] Run Repository CI and observe failure because exports do not exist.
- [ ] Implement minimal Zod schemas and root exports.
- [ ] Run Repository CI and observe success.

### Task 2: Implement Cookie helpers and request security

**Files:**
- Create `apps/gateway/src/webEntryCookies.ts`.
- Create `apps/gateway/test/webEntryContracts.test.ts`.

**Interfaces:**
- Produces `WEB_COOKIE_NAMES`, `parseCookieHeader()`, `setWebEntryCookies()`, `clearWebSessionCookies()`, `clearAllWebEntryCookies()`, `assertWebCookieRequestAllowed()` and `applyWebEntryCookieHeaders()`.

- [ ] Write failing tests for HttpOnly/SameSite/Path/Secure attributes, clearing cookies, Header precedence and CSRF rejection.
- [ ] Observe RED in CI.
- [ ] Implement Cookie parsing/serialization without adding a dependency.
- [ ] Implement bridge path allowlist and unsafe-method checks.
- [ ] Observe GREEN in CI.

### Task 3: Implement Web Entry repository

**Files:**
- Create `apps/gateway/src/webEntry.ts`.
- Create `apps/gateway/test/webEntryRepository.test.ts`.

**Interfaces:**
- Produces `WebEntryRepository.claimPairing()`, `authenticateDevice()`, `renewSession()`, `logoutSession()`, and `revokeDevice()`.

- [ ] Write failing tests using real initialized Family, admin-created pairing material and SQLite.
- [ ] Cover active/expired/consumed/mismatch pairing, `web/browser` Device fields, installation idempotency, other-installation rejection and transaction rollback.
- [ ] Observe RED in CI.
- [ ] Implement the minimal repository using existing tables and Hash helpers.
- [ ] Return secret material only through an internal result type, never public JSON.
- [ ] Observe GREEN in CI.

### Task 4: Expose Web Entry routes and Cookie bridge

**Files:**
- Create `apps/gateway/src/webEntryRoutes.ts`.
- Create `apps/gateway/test/webEntryRoutes.test.ts`.
- Create `apps/gateway/test/webEntryBridge.test.ts`.
- Modify `apps/gateway/src/app.ts`.

**Interfaces:**
- Registers `/api/v1/web-entry/**` and transparently authenticates existing personal APIs from HttpOnly Cookie.

- [ ] Write failing route tests for claim Set-Cookie, context, renew, logout, revoke and PublicError envelopes.
- [ ] Write failing bridge tests against real `/api/v1/chat`, Work creation, message send, sync catch-up/ACK and SSE preflight.
- [ ] Verify unsafe Cookie requests without custom header fail, while explicit Authorization Header requests remain unchanged.
- [ ] Observe RED in CI.
- [ ] Implement routes and `onRequest` bridge before Chat/Work route handlers.
- [ ] Observe GREEN in CI.

### Task 5: Replace acceptance-first root with product entry shell

**Files:**
- Create `apps/gateway/src/memberWeb.ts`.
- Create `apps/gateway/member-public/index.html`.
- Create `apps/gateway/member-public/entry.js`.
- Create `apps/gateway/member-public/member.css`.
- Create `apps/gateway/test/memberWeb.test.ts`.
- Modify `apps/gateway/src/app.ts`.
- Modify `Dockerfile`.

**Interfaces:**
- `/` redirects to `/member/`; `/member/` serves a normal product shell that can pair, restore context, renew, logout and revoke.

- [ ] Write failing tests for root redirect, static security headers, no debug log UI, no acceptance route registration and automatic URL pairing cleanup.
- [ ] Observe RED in CI.
- [ ] Implement responsive static shell and lifecycle client.
- [ ] Stop calling `registerDevelopmentConsole()` from `app.ts` without deleting its historical files.
- [ ] Copy member-public in Docker runtime.
- [ ] Observe GREEN in CI.

### Task 6: Convert one-click verification to the real product flow

**Files:**
- Modify `scripts/acceptance-onboarding.sh`.
- Modify `scripts/verify-foundation.sh`.
- Add or update shell regression tests under `scripts/` if existing script test patterns require them.

**Interfaces:**
- Produces a real `/member/?pairingRef=...&code=...` URL generated by the existing admin pairing command.

- [ ] Add failing static/script tests requiring `/member/` product URL and forbidding the old acceptance-console title as the primary output.
- [ ] Observe RED in CI.
- [ ] Update scripts to create genuine pairing material and print the product deep link.
- [ ] Ensure pairing secrets are not written to committed files or logs beyond the immediate local terminal output.
- [ ] Observe GREEN in CI.

### Task 7: Review, evidence and PR readiness

**Files:**
- Create `docs/superpowers/evidence/2026-07-25-member-web-entry-foundation.md`.
- Update the design status to implemented.

- [ ] Inspect all changed paths against PR #14 and confirm intersection is zero.
- [ ] Review Cookie privacy, CSRF, pairing replay, Header precedence and production Secure behavior.
- [ ] Add regression tests for every Important issue found.
- [ ] Run fresh full Repository CI and Secret Scan on final Head.
- [ ] Record exact RED/GREEN run numbers and final Head in Git evidence.
- [ ] Update PR #24 body and mark Ready for review only after all gates succeed.