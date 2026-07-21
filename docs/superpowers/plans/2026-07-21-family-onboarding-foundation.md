# Family Onboarding Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Track each checkbox and keep RED → GREEN → REFACTOR evidence.

**Goal:** Harden Gateway Foundation and deliver a beginner-testable one-family, multi-member onboarding flow with separate Admin and Personal entry sessions on one device.

**Architecture:** Keep the existing message kernel. Add Migration V2 and a focused Family domain repository, expose onboarding/portal APIs through the same Fastify Gateway, and replace the development root page with a dual-entry portal. Development/Test may use the bootstrap device and Fake Provider; production must not bootstrap or default to Fake Provider.

**Tech Stack:** Node.js 22.16.0, TypeScript, Fastify, Zod, better-sqlite3, Vitest, npm workspaces, Docker Compose.

## Global Constraints

- One Gateway instance and one SQLite database.
- One Family in this phase, multiple Persons.
- Setup fields: family name, owner name, device name.
- One owner Person; two independent sessions: `family_admin` and `personal`.
- Admin routes to `agent:family-manager`; Personal routes to `agent:personal-assistant`.
- Same Person and Device, different session refs, tokens, permissions, Agent and page state.
- Client never selects authoritative Person or Agent.
- No Chat, Work, phone verification, passwords, real Provider, LAN or multi-family switching.

---

### Task 1: RED tests

**Files:**
- Modify: `apps/gateway/test/config.test.ts`
- Modify: `apps/gateway/test/database.test.ts`
- Modify: `apps/gateway/test/gatewayApi.test.ts`
- Modify: `apps/gateway/test/developmentConsole.test.ts`
- Create: `apps/gateway/test/familyOnboarding.test.ts`

- [ ] Add a config test that `GATEWAY_MODE=production` throws an error containing `production runtime composition`.
- [ ] Assert all 401/403/409/502 responses contain `code`, `category`, `message`, `retryable`.
- [ ] Change migration expectation to versions 1 and 2, and assert `families` starts empty.
- [ ] Test setup status, one-time setup, two different sessions, Admin family-manager context, Personal personal-assistant context, Personal forbidden from Admin API, Admin member creation, and restart persistence.
- [ ] Assert development root contains `家庭 AI 初始化与入口验收台`, `家庭管理`, `个人空间`.
- [ ] Push tests and confirm CI fails for missing behavior.

### Task 2: Foundation hardening

**Files:**
- Modify: `package.json`, `Dockerfile`, `.github/workflows/ci.yml`, `scripts/verify-foundation.sh`
- Modify: `apps/gateway/src/config.ts`, `apps/gateway/src/service.ts`, `apps/gateway/src/app.ts`
- Create: `package-lock.json`

- [ ] Set root `@types/node` to `^22.15.0`.
- [ ] Generate lock with Node 22.16.0 / npm 10.9.2 using `npm install --package-lock-only --ignore-scripts` and commit it.
- [ ] Docker and CI require `package-lock.json` and use only `npm ci`.
- [ ] `verify-foundation.sh` fails when the lock is absent instead of generating it.
- [ ] Production config refuses startup until an explicit production composition exists.
- [ ] Extend `GatewayDomainError` with `category` and `retryable`.
- [ ] Map route and internal errors to the complete Public Error contract.
- [ ] Run config and Gateway API tests.

### Task 3: Migration V2 and Family repository

**Files:**
- Modify: `apps/gateway/src/database.ts`
- Create: `apps/gateway/src/familyDomain.ts`

- [ ] Add Migration V2 tables: `families`, `persons`, `family_memberships`, `managed_devices`, `device_bindings`, `family_manager_assignments`, `assistant_assignments`, `entry_bindings`, `entry_sessions`.
- [ ] Apply missing migrations sequentially and reject unknown future versions.
- [ ] Implement `FamilyDomainRepository.isInitialized()`.
- [ ] Implement transactional `initializeFamily()` creating one Family, one owner Person, one Device, both Agent assignments, two EntryBindings and two EntrySessions.
- [ ] Generate session tokens with `randomBytes(32).toString("base64url")`; store only SHA-256 hashes.
- [ ] Implement `authenticateEntrySession()`, `listMembers()` and `createMember()`.
- [ ] New members receive a Personal Assistant assignment but no session on the current administrator device.
- [ ] Run database and onboarding repository tests.

### Task 4: Onboarding and portal API

**Files:**
- Create: `apps/gateway/src/familyRoutes.ts`
- Modify: `apps/gateway/src/app.ts`

- [ ] Register `GET /api/v1/onboarding/status`.
- [ ] Register one-time `POST /api/v1/onboarding/family`, guarded by the existing local development bootstrap device token.
- [ ] Register `GET /api/v1/portal/context`, authenticated with Bearer token plus `X-Entry-Session-Ref`.
- [ ] Register `GET/POST /api/v1/admin/members`, restricted to `family_admin`.
- [ ] Use strict Zod schemas with 1–80 character names and roles `adult|child|elder`.
- [ ] Invalid session returns `ENTRY_SESSION_INVALID`; wrong audience returns `ENTRY_AUDIENCE_FORBIDDEN`.
- [ ] Run all onboarding API tests.

### Task 5: Beginner browser portal

**Files:**
- Modify: `apps/gateway/public/index.html`
- Modify: `apps/gateway/public/acceptance.js`
- Modify: `apps/gateway/public/acceptance.css`
- Modify: `apps/gateway/test/developmentConsole.test.ts`

- [ ] Implement states: loading, setup form, dual-entry portal, Admin detail/member management, Personal detail, missing-session recovery notice.
- [ ] Read bootstrap token from URL fragment, store in `sessionStorage`, then remove the fragment.
- [ ] Store Admin and Personal session refs/tokens under separate browser keys.
- [ ] Show the same Person and Device in both entries, but different Session Ref and Agent.
- [ ] Never render raw tokens.
- [ ] Keep CSP, no-store, no-referrer, nosniff and frame denial.
- [ ] Run development console tests.

### Task 6: Automated and beginner acceptance

**Files:**
- Create: `scripts/acceptance-onboarding.sh`
- Modify: `scripts/verify-foundation.sh`
- Create: `docs/acceptance/2026-07-21-family-onboarding-foundation.md`
- Modify: `README.md`
- Modify: `docs/architecture/01-identity-and-binding.md`

- [ ] Script initializes a disposable Family, verifies both entry contexts, creates another member through Admin, verifies Personal receives 403, restarts Gateway and verifies both sessions persist.
- [ ] `verify-foundation.sh` runs both legacy and onboarding acceptance suites and prints the local browser URL.
- [ ] Beginner steps: create Family; enter Admin and confirm family manager; add member; return; enter Personal and confirm personal assistant; refresh; restart and refresh.
- [ ] Document that lost development browser sessions currently require `./scripts/dev-reset.sh`.
- [ ] Add `FamilyManagerAssignment` and audience-scoped dual-entry sessions to the stable identity architecture.

### Task 7: Verification and Draft PR

- [ ] Run `npm ci && npm run check`.
- [ ] Run `./scripts/verify-foundation.sh`.
- [ ] Confirm no token, SQL, stack, stderr or host path appears in public output.
- [ ] Open a Draft PR to `main` with exact test, migration, Docker and browser evidence.
- [ ] Keep Draft until CI is green and the user completes target-host browser acceptance.
