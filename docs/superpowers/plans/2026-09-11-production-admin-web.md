# Production Admin Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current production Family Admin Web usable at `:8793/admin/` without switching to development mode, leaking administrator tokens, or using the old `:9443` Preview.

**Architecture:** Serve the existing static Admin Web in production behind the same Gateway. A production-only operator activation record lets a browser exchange a five-minute one-time code for Secure HttpOnly `family_admin` cookies; after activation, all `/api/v1/admin/*` requests use the existing EntrySessionAuthenticator and audience checks through the Web Cookie bridge. Development Preview endpoints remain development-only.

**Tech Stack:** Node.js ESM, Fastify, TypeScript, SQLite, browser-native ES modules, Docker Compose, Playwright/Chrome, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-production-admin-web-design.md`

## Global Constraints

- Keep `GATEWAY_MODE=production`; do not enable Fake Provider or development Preview routes in production.
- Do not expose an Entry token in URL, response JSON, logs, HTML, JavaScript source, localStorage, or the activation record.
- Production activation code format is exactly `XXXXX-XXXXX`, lifetime exactly five minutes, single-use, salted SHA-256 hash, file mode 0600.
- Production activation success sets only `family_ai_web_entry_session_ref` and `family_ai_web_entry_token` as `Secure; HttpOnly; SameSite=Strict` cookies.
- Every cookie-backed non-GET admin request requires `X-Family-AI-Web-Request: 1`, same-origin `Sec-Fetch-Site`, and matching Origin.
- Every admin data route continues to require `family_admin`; personal or anonymous contexts must remain rejected.
- Keep public ports `8793`, `3001`, and `8766` unchanged. Do not add a listener.
- Do not stop old `:9443` Preview until the final browser acceptance in Task 6 passes.
- Update `/home/youran/data/service-ports.md` and `/home/youran/data/service-ports.json` together after deployment.
- Do not place credentials, activation codes, or private browser state in `/home/youran/data`.

### Task 1: Production Admin Web configuration and route registration

**Files:**

- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/src/adminWeb.ts`
- Modify: `apps/gateway/src/app.ts`
- Test: `apps/gateway/test/config.test.ts`
- Test: `apps/gateway/test/adminWeb.test.ts`

**Interfaces:**

- Add `adminWebEnabled: boolean`, `productionAdminEntryPath?: string`, `productionAdminActivationPath?: string`, and `adminWebOrigin?: string` to the loaded Gateway config.
- `registerAdminWeb(app, mode, enabled)` registers `/admin` and `/admin/` only when `enabled` is true and `mode` is `production` or `development`.
- Production config rejects an incomplete path/origin tuple, non-HTTPS/non-host-matching origin, and `adminWebEnabled=1` without both protected paths.

- [ ] **Step 1: Write failing tests**

Add tests asserting production config accepts the exact complete tuple, rejects a missing path, rejects an HTTP origin, and `buildGatewayApp` serves `/admin/` only when the explicit flag is enabled. Assert the existing default production config still has Admin Web disabled.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- apps/gateway/test/config.test.ts apps/gateway/test/adminWeb.test.ts
```

Expected: new assertions fail because production configuration has no Admin Web flag and `registerAdminWeb` returns before registering `/admin/`.

- [ ] **Step 3: Implement the minimal config and route gate**

Parse `GATEWAY_ADMIN_WEB_ENABLED`, `GATEWAY_PRODUCTION_ADMIN_ENTRY_PATH`, `GATEWAY_PRODUCTION_ADMIN_ACTIVATION_PATH`, and `GATEWAY_ADMIN_WEB_ORIGIN`. Require `GATEWAY_ADMIN_WEB_ENABLED=1` only with both protected paths and an exact HTTPS origin. Pass the resulting boolean to `registerAdminWeb`; do not alter existing development Preview behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same `npm test` command and confirm all new and existing config/Admin Web tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/config.ts apps/gateway/src/adminWeb.ts apps/gateway/src/app.ts apps/gateway/test/config.test.ts apps/gateway/test/adminWeb.test.ts
git commit -m "feat(gateway): gate production Admin Web explicitly"
```

### Task 2: One-time production administrator activation

**Files:**

- Create: `apps/gateway/src/adminProductionActivation.ts`
- Create: `scripts/admin-production-activate.mjs`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/src/config.ts`
- Test: `apps/gateway/test/adminProductionActivation.test.ts`
- Test: `apps/gateway/test/memberPreviewScripts.test.ts`

**Interfaces:**

- `createProductionAdminActivation({ adminEntryPath, activationPath, now, randomBytesImpl })` returns `{ code, expiresAt, outputPath }` and writes only a salted hash record.
- `registerAdminProductionActivation(app, { mode, enabled, adminEntryPath, activationPath, adminWebOrigin, entryAuthenticator })` registers `POST /api/v1/admin/activate` only when the production Admin Web gate is enabled.
- The endpoint accepts exactly `{ code: string }`, validates same-origin HTTPS, consumes the record atomically, and returns `{ activated: true }` with two Secure HttpOnly session cookies and `Cache-Control: no-store`.

- [ ] **Step 1: Write failing tests**

Create Fastify integration tests for valid activation, wrong code, expired code, replay, malformed body, symlink/incorrect-mode files, personal-audience entry, missing Origin, cross-origin Origin, and production route absence when the feature flag is off. Assert the successful response body contains no token and `Set-Cookie` contains `HttpOnly`, `Secure`, `SameSite=Strict`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- apps/gateway/test/adminProductionActivation.test.ts
```

Expected: test module and endpoint are missing.

- [ ] **Step 3: Implement protected record and endpoint**

Use regular non-symlink files, mode 0600, bounded JSON, salted SHA-256 with constant-time comparison, exact five-minute expiry, atomic rename with directory sync, and `EntrySessionAuthenticator.authenticate()` requiring `family_admin`. Use existing `setWebEntryCookieHeaders` semantics but emit only the two session cookies; never include the credential in JSON or logs.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm test -- apps/gateway/test/adminProductionActivation.test.ts apps/gateway/test/memberPreviewScripts.test.ts
```

Expected: all activation and script tests pass, including file-mode and replay assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/adminProductionActivation.ts apps/gateway/src/app.ts apps/gateway/src/config.ts scripts/admin-production-activate.mjs apps/gateway/test/adminProductionActivation.test.ts apps/gateway/test/memberPreviewScripts.test.ts
git commit -m "feat(gateway): add one-time production admin activation"
```

### Task 3: Cookie-backed admin API boundary

**Files:**

- Modify: `apps/gateway/src/webEntryCookies.ts`
- Modify: `apps/gateway/admin-public/admin-api.js`
- Test: `apps/gateway/test/webEntryCookies.test.ts`
- Test: `apps/gateway/test/adminWebModules.test.ts`

**Interfaces:**

- `applyWebEntryCookieHeaders()` treats `/api/v1/admin/*` as an eligible bridge path.
- `createAdminApi({ cookieSession: true })` sends no Authorization header, relies on HttpOnly cookies, and adds `X-Family-AI-Web-Request: 1` to non-GET requests.
- Explicit credential mode remains unchanged for controlled tests/development handoff.

- [ ] **Step 1: Write failing tests**

Add a real request fixture asserting an admin GET with valid cookies receives Authorization and `X-Entry-Session-Ref`, an admin POST without the CSRF marker is forbidden, and `createAdminApi({ cookieSession: true })` sends the marker but never serializes credentials.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- apps/gateway/test/webEntryCookies.test.ts apps/gateway/test/adminWebModules.test.ts
```

Expected: admin paths are not bridged and cookieSession mode does not exist.

- [ ] **Step 3: Implement the minimal bridge and client mode**

Extend `bridgePath` with `/api/v1/admin/` and add the cookieSession request option. Preserve the existing explicit Bearer branch and strict duplicate-cookie handling.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused test command and confirm all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/webEntryCookies.ts apps/gateway/admin-public/admin-api.js apps/gateway/test/webEntryCookies.test.ts apps/gateway/test/adminWebModules.test.ts
git commit -m "feat(admin): bridge HttpOnly Family admin sessions"
```

### Task 4: Production Admin Web activation UI

**Files:**

- Modify: `apps/gateway/admin-public/index.html`
- Modify: `apps/gateway/admin-public/admin.js`
- Modify: `apps/gateway/admin-public/admin-api.js`
- Modify: `apps/gateway/admin-public/admin.css`
- Test: `apps/gateway/test/adminWebModules.test.ts`
- Test: `apps/gateway/test/adminWeb.test.ts`

**Interfaces:**

- Add `id="admin-activation-form"` with a one-time code input to the recovery state.
- `createAdminApi({ cookieSession: true }).activate(code)` POSTs the exact body to `/api/v1/admin/activate` and accepts only `{ activated: true }`.
- `admin.js` first attempts cookie-backed `context()`/`members()`; when no session exists, it shows the activation form; after success it reloads management.

- [ ] **Step 1: Write failing tests**

Assert the activation form is present, the client normalizes only valid `XXXXX-XXXXX` input, activation requests contain no Authorization header or token-like values, and production startup does not call development-only `access-mode` or `preview-access` endpoints.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- apps/gateway/test/adminWebModules.test.ts apps/gateway/test/adminWeb.test.ts
```

Expected: the current recovery page has no activation form and the startup flow calls `adminAccessMode()`.

- [ ] **Step 3: Implement the activation form and cookie-first startup**

Add the form and accessible error/status text. Use cookieSession mode for production; retain the existing fragment and development Preview branch only when a fragment is explicitly present or the server reports development Preview mode. Scrub the URL before any request and keep the code only in the input element until submission.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused test command and confirm all UI contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/admin-public/index.html apps/gateway/admin-public/admin.js apps/gateway/admin-public/admin-api.js apps/gateway/admin-public/admin.css apps/gateway/test/adminWebModules.test.ts apps/gateway/test/adminWeb.test.ts
git commit -m "feat(admin): add production activation form"
```

### Task 5: Candidate deployment wiring

**Files:**

- Modify: `/home/youran/.config/superpowers/worktrees/ai-ecosystem/canvas-family-trusted-ingress/deploy/lan/compose.yml`
- Modify: `/home/youran/.config/superpowers/worktrees/ai-ecosystem/canvas-family-trusted-ingress/deploy/lan/deploy.sh`
- Modify: `/home/youran/.local/share/three-product-candidates/candidate.env`
- Create through the operator script: `/home/youran/.local/share/three-product-candidates/family/admin-entry.json`
- Create through the operator script: `/home/youran/.local/share/three-product-candidates/family/admin-activation/record.json`
- Test: deployment config and protected-file checks in `deploy/lan`

**Interfaces:**

- Compose passes `GATEWAY_ADMIN_WEB_ENABLED=1`, `GATEWAY_ADMIN_WEB_ORIGIN=https://admin-yr.tailf7be7d.ts.net:8793`, and the two `/run/admin-bootstrap/*` paths.
- Family receives a read-only mode-0600 Admin Entry file and a dedicated mode-0700 activation directory containing only mode-0600 `record.json`; no other service receives them.
- `deploy.sh` refuses dirty sources, missing files, symlinks, wrong owners/modes, or an active Family container before rebuild.

- [ ] **Step 1: Add protected-file deployment checks**

Extend the deployment preflight to require regular non-symlink files owned by UID/GID 1000 with mode 0600 and validate the exact origin/paths before Compose rendering.

- [ ] **Step 2: Generate the admin entry and activation record**

Use the existing active administrator Entry material only through a local protected operator command; copy it atomically to `family/admin-entry.json` with mode 0600, then run `node scripts/admin-production-activate.mjs` and deliver only its stdout code to the user.

- [ ] **Step 3: Rebuild the Family image from the current source**

Run `npm run build:gateway`, build the source-built image with a fresh local base, verify its revision label and `old-gateway-image=false`, and do not load or tag the old Gateway image.

- [ ] **Step 4: Recreate only the Family service**

Stop Family, run the serialized migration job if required, then recreate `family` with `--no-deps --force-recreate`; wait for a healthy status before touching other services.

- [ ] **Step 5: Verify deployment wiring**

Run Compose config validation, inspect mounts/env without printing values, check the container cannot read activation files through any public route, and verify the Family health endpoint.

- [ ] **Step 6: Commit source/deployment changes**

```bash
git -C /home/youran/.config/superpowers/worktrees/ai-ecosystem/canvas-family-trusted-ingress diff --check
git -C /home/youran/.config/superpowers/worktrees/ai-ecosystem/canvas-family-trusted-ingress add deploy/lan/compose.yml deploy/lan/deploy.sh
git -C /home/youran/.config/superpowers/worktrees/ai-ecosystem/canvas-family-trusted-ingress commit -m "deploy: wire production Family Admin Web"
```

### Task 6: End-to-end acceptance and old Preview retirement

**Files:**

- Modify: `/home/youran/data/service-ports.md`
- Modify: `/home/youran/data/service-ports.json`
- Modify: `/home/youran/data/agent-architecture.md`
- Test: Chrome/Playwright browser journey and live listeners

- [ ] **Step 1: Create the failing live acceptance checks**

Record current `/admin/` 404, then define checks for `/admin/` 200, activation response with no token body, cookie-backed `/api/v1/admin/members` 200, personal audience 403, and Canvas management-link navigation to `:8793/admin/`.

- [ ] **Step 2: Activate through the browser**

Open `https://admin-yr.tailf7be7d.ts.net:8793/admin/` with forced LAN DNS to `192.168.110.84`, enter the operator code once, verify the URL contains no code, `localStorage` contains no credential, and the page shows family summary and member list.

- [ ] **Step 3: Verify all three products and security boundaries**

With the same browser context, click the Canvas management link and confirm it stays on `:8793/admin/`; verify Canvas `:3001` and ME `:8766` still load, Family/Canvas/ME containers are healthy, database checks pass, and no `/admin` request reaches `:9443`.

- [ ] **Step 4: Retire the old Preview**

After the above passes, stop the old Preview process and its Nginx instance, confirm `:9443` and `:8791` have no listeners, and do not remove the protected data backup.

- [ ] **Step 5: Update live records**

Record the production Admin Web status, current image/source revision, activation boundary, and the unchanged port set in both service-port files and the non-secret agent architecture file. Validate JSON syntax and scan for token-like output.

- [ ] **Step 6: Final verification**

Run:

```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
ss -ltnp | rg ':(8793|3001|8766|9443|8791)\\b' || true
python3 -m json.tool /home/youran/data/service-ports.json >/dev/null
```

Expected: `8793`, `3001`, and `8766` remain healthy; `9443` and `8791` are absent; Admin Web and all product journeys are verified.

- [ ] **Step 7: Commit final source/docs changes**

```bash
git add docs/superpowers/specs/2026-09-11-production-admin-web-design.md docs/superpowers/plans/2026-09-11-production-admin-web.md
git commit -m "docs: record production Admin Web acceptance"
```
