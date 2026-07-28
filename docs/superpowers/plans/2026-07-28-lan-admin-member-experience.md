# LAN Admin and Member Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a directly usable Family AI development experience in which a trusted LAN device opens the administrator console over HTTPS, creates or selects a family member, sees a five-minute pairing code and QR code, and enters the existing Member Web against the same preview database.

**Architecture:** Keep the existing Gateway bound to `127.0.0.1:8791`. Register a development-only `/admin/` application inside that Gateway, then expose it and the existing `/member/` application through a repository-owned, isolated Nginx process on `192.168.110.84:9443`. A repository-owned local CA and short-lived leaf certificate provide the secure context required by Web Locks. Protected administrator and member handoffs live only in `.runtime-preview/config` with mode `0600`; public script output never contains credentials.

**Tech Stack:** TypeScript, Fastify, browser ES modules, Vitest, Bash, Node.js 22, OpenSSL, Nginx, SQLite.

**Approved specification:** `docs/superpowers/specs/2026-07-28-lan-admin-member-experience-design.md`

---

## Task 1: Register a development-only Admin Web shell

**Files:**
- Create: `apps/gateway/admin-public/index.html`
- Create: `apps/gateway/admin-public/admin.css`
- Create: `apps/gateway/admin-public/admin.js`
- Create: `apps/gateway/src/adminWeb.ts`
- Modify: `apps/gateway/src/app.ts`
- Create: `apps/gateway/test/adminWeb.test.ts`

- [ ] **Step 1: Write the failing route and security tests**

Add tests that build the Gateway in all three modes and assert:

```ts
expect((await development.inject({ url: "/admin" })).headers.location)
  .toBe("/admin/");
expect((await development.inject({ url: "/admin/" })).statusCode).toBe(200);
expect((await test.inject({ url: "/admin/" })).statusCode).toBe(404);
expect((await production.inject({ url: "/admin/" })).statusCode).toBe(404);
expect((await development.inject({ url: "/" })).headers.location)
  .toBe("/member/");
```

The development response must contain the product title and the four explicit UI states (`initializing`, `create-family`, `management`, `recovery-required`), use `Cache-Control: no-store`, a nonce-free self-only CSP, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and never contain the configured device token.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWeb.test.ts
```

Expected: failure because `/admin/` returns `404`.

- [ ] **Step 3: Implement the minimal route and static shell**

Add:

```ts
export function registerAdminWeb(
  app: FastifyInstance,
  mode: GatewayMode
): void
```

Only register routes when `mode === "development"`. Serve:

- `/admin` → `/admin/`
- `/admin/` → `index.html`
- `/admin/assets/admin.css`
- `/admin/assets/admin.js`
- `/admin/assets/qr.js` and `/admin/assets/qr-v10.mjs` from the existing reviewed QR implementation

Use exact path maps rather than a general filesystem server. Call `registerAdminWeb(app, options.mode)` after the Member Web routes. Keep `/` owned by Member Web.

- [ ] **Step 4: Run focused and neighboring tests**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWeb.test.ts memberWeb.test.ts
```

Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/admin-public apps/gateway/src/adminWeb.ts apps/gateway/src/app.ts apps/gateway/test/adminWeb.test.ts
git commit -m "feat: add development admin web entry"
```

## Task 2: Implement administrator entry, family setup, and member management

**Files:**
- Create: `apps/gateway/admin-public/admin-entry.js`
- Create: `apps/gateway/admin-public/admin-api.js`
- Modify: `apps/gateway/admin-public/admin.js`
- Modify: `apps/gateway/admin-public/index.html`
- Modify: `apps/gateway/admin-public/admin.css`
- Modify: `apps/gateway/src/adminWeb.ts`
- Create: `apps/gateway/test/adminWebModules.test.ts`

- [ ] **Step 1: Write failing pure-module tests**

Test exported functions without a browser dependency:

```js
captureAdminHandoff("#entrySessionRef=entry-session:demo&token=<valid-token>")
adminHeaders(session)
normalizeDisplayName("  小明  ")
normalizeFamilyRole("child")
```

Assert malformed, duplicate, query-string, and extra-key handoffs are rejected. Assert the parser produces a clean `/admin/` replacement target, and neither storage nor logs receive the raw fragment.

Add API tests with a fake `fetch` for:

- `GET /api/v1/onboarding/status`
- `POST /api/v1/onboarding/family`
- `GET /api/v1/portal/context`
- `GET /api/v1/admin/members`
- `POST /api/v1/admin/members`

Assert every privileged request sends `Authorization: Entry <token>` and `X-Entry-Session-Ref`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWebModules.test.ts
```

Expected: failure because the modules do not exist.

- [ ] **Step 3: Implement the entry state machine**

Implement:

```js
export function captureAdminHandoff(fragment) { /* exact keys and formats */ }
export function adminHeaders(session) { /* Entry authentication */ }
export function createAdminApi({ fetchImpl, session }) { /* typed response checks */ }
```

On page start:

1. Capture and validate fragment data.
2. Immediately call `history.replaceState(null, "", "/admin/")`.
3. Store the session only in `sessionStorage`.
4. Read onboarding status.
5. Show create-family only for an uninitialized database.
6. Verify `audience === "family_admin"` before showing management.
7. Show recovery-required for missing, expired, or rejected administrator entry.

Render accessible labeled forms for family name, owner name, administrator device name, member display name, and role. Render explicit busy, success, empty, and error states. Do not render credential values.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWebModules.test.ts adminWeb.test.ts familyOnboarding.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/admin-public apps/gateway/src/adminWeb.ts apps/gateway/test/adminWebModules.test.ts
git commit -m "feat: add admin family management flow"
```

## Task 3: Implement browser pairing, QR display, expiry, and revoke

**Files:**
- Create: `apps/gateway/admin-public/admin-pairing.js`
- Modify: `apps/gateway/admin-public/admin.js`
- Modify: `apps/gateway/admin-public/index.html`
- Modify: `apps/gateway/admin-public/admin.css`
- Modify: `apps/gateway/src/adminWeb.ts`
- Modify: `apps/gateway/test/adminWebModules.test.ts`

- [ ] **Step 1: Write failing pairing tests**

Test:

```js
memberHandoffUrl(origin, pairing)
pairingCountdown(expiresAt, now)
```

The URL must be exactly same-origin and use a fragment:

```text
https://192.168.110.84:9443/member/#pairingRef=...&code=...
```

Assert no code appears in a query string, code text uses the expected grouped format, countdown reaches expired deterministically, and revoke calls:

```text
DELETE /api/v1/admin/pairing-codes/:pairingRef
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWebModules.test.ts
```

Expected: missing pairing module or assertion failure.

- [ ] **Step 3: Implement the pairing dialog**

For a selected member, call the existing pairing-code API, render:

- member name
- eight-character grouped code
- absolute expiry time
- live remaining time
- QR SVG generated by the existing checked-in QR module
- “在本机进入成员端” link using the same protected fragment
- revoke button

Disable the member link and QR at expiry or after revoke. Allow generating a fresh code without reloading the page. Never place the handoff into logs, analytics, referrers, or query parameters.

- [ ] **Step 4: Run focused and mobile bridge tests**

Run:

```bash
npm run test -w @family-ai/gateway -- adminWebModules.test.ts mobileWebPairing.test.ts webEntryBridge.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/admin-public apps/gateway/src/adminWeb.ts apps/gateway/test/adminWebModules.test.ts
git commit -m "feat: add admin pairing experience"
```

## Task 4: Create the protected administrator handoff

**Files:**
- Create: `scripts/member-preview-admin.mjs`
- Modify: `scripts/member-preview-pair.mjs`
- Modify: `apps/gateway/test/memberPreviewScripts.test.ts`
- Modify: `scripts/static-check.sh`
- Modify: `scripts/test-static-check-secret-pattern.sh`

- [ ] **Step 1: Write failing CLI, permission, and leak tests**

Cover:

- only `--origin https://<RFC1918 IPv4>:9443` is accepted
- query strings, paths, fragments, userinfo, public IPs, loopback, and other ports are rejected
- the loopback Gateway origin remains `http://127.0.0.1:8791`
- a new database bootstraps once; an initialized database reuses and verifies `admin-entry.json`
- `.runtime-preview/config/admin-web-url-9443` is a regular non-symlink file with mode `0600`
- stdout contains only the absolute handoff-file path
- stderr uses a constant failure code and never exposes the token
- static checks reject direct printing or opening of administrator handoff bytes

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- memberPreviewScripts.test.ts
bash scripts/test-static-check-secret-pattern.sh
```

Expected: missing script and static contract failures.

- [ ] **Step 3: Implement the handoff writer**

Reuse the already hardened `loadOrInitializePreviewAdmin`, runtime-boundary checks, lock, and atomic protected-write primitives. Write:

```text
https://<private-ip>:9443/admin/#entrySessionRef=<ref>&token=<token>
```

Return and print only the file path. Extend the secret scanner with separate `ADMIN_WEB_URL_FILE` and `admin-web-url` taint markers.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
npm run test -w @family-ai/gateway -- memberPreviewScripts.test.ts
npm run test:scripts
```

Expected: pass with no credential material in output.

- [ ] **Step 5: Commit**

```bash
git add scripts/member-preview-admin.mjs scripts/member-preview-pair.mjs scripts/static-check.sh scripts/test-static-check-secret-pattern.sh apps/gateway/test/memberPreviewScripts.test.ts
git commit -m "feat: add protected admin preview handoff"
```

## Task 5: Generate and validate repository-owned LAN TLS material

**Files:**
- Create: `scripts/member-preview-lan-lib.mjs`
- Create: `apps/gateway/test/memberPreviewLan.test.ts`
- Modify: `.gitignore`
- Modify: `.dockerignore`

- [ ] **Step 1: Write failing validation and rendering tests**

Cover exact RFC1918 IPv4 validation, URL rendering, OpenSSL subject/SAN rendering, CA/leaf maximum lifetimes, IP-change leaf rotation, invalid or expired CA fail-closed behavior, and exact modes:

```text
.runtime-preview/tls/ca.key       0600
.runtime-preview/tls/ca.crt       0644
.runtime-preview/tls/server.key   0600
.runtime-preview/tls/server.crt   0644
```

Assert keys, certificates, handoffs, Nginx logs, and manifests remain ignored and untracked.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- memberPreviewLan.test.ts
```

Expected: missing library failure.

- [ ] **Step 3: Implement strict pure helpers**

Export exact helpers for:

```js
validatePrivateIpv4(value)
lanUrls(ip)
renderLeafExtensions(ip)
renderNginxConfig(input)
validateTlsMetadata(input)
```

The Nginx configuration must:

- listen on `0.0.0.0:9443 ssl` and `[::]:9443 ssl`
- listen on `0.0.0.0:9080` and `[::]:9080`
- serve only `/family-ai-preview-ca.crt` over HTTP
- return `404` for every other HTTP path
- redirect HTTPS `/` to `/admin/`
- proxy all other HTTPS paths to `http://127.0.0.1:8791`
- preserve `Host`
- set `X-Forwarded-Proto https`
- disable buffering for SSE
- use only paths under the validated runtime directory

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run test -w @family-ai/gateway -- memberPreviewLan.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/member-preview-lan-lib.mjs apps/gateway/test/memberPreviewLan.test.ts .gitignore .dockerignore
git commit -m "feat: define isolated LAN TLS proxy"
```

## Task 6: Implement isolated LAN up/down lifecycle

**Files:**
- Create: `scripts/member-preview-lan-up.sh`
- Create: `scripts/member-preview-lan-down.sh`
- Modify: `scripts/member-preview-lan-lib.mjs`
- Modify: `apps/gateway/test/memberPreviewLan.test.ts`
- Modify: `scripts/static-check.sh`

- [ ] **Step 1: Write failing lifecycle tests**

Use temporary runtime directories and fake executables to verify:

- host, user, repository root, and branch are checked before mutation
- `member-preview-up.sh` is invoked without changing its loopback contract
- `9080` and `9443` must be free or owned by the exact saved Nginx process
- the system Nginx configuration and service are never modified
- the repository Nginx uses its own prefix, config, logs, PID file, and manifest
- the manifest records exact PID, `/proc` starttime, cwd, executable, prefix, config hash, LAN IP, ports, certificate fingerprints, and launch commit
- startup fails closed on symlinks, unsafe modes, ambiguous process ownership, public IP, changed CA, failed certificate verification, failed listener probe, or changed `8790`
- down uses a validated pidfd and stops only the repository Nginx
- down leaves Gateway `8791`, data, CA, leaf certificate, and protected handoffs intact
- repeated up/down calls are deterministic

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- memberPreviewLan.test.ts
```

Expected: missing lifecycle scripts or ownership contract failure.

- [ ] **Step 3: Implement LAN startup**

`member-preview-lan-up.sh` must:

1. Validate `youran@Admin-YR`, exact worktree, exact branch, and Git root.
2. Capture the existing `8790` health hash, Docker row, and listener row.
3. Start or validate the loopback Gateway through `member-preview-up.sh`.
4. Derive the active RFC1918 IPv4 from the default route.
5. Create the local ECDSA P-256 CA only when no CA material exists.
6. Validate the CA and create or rotate a maximum-30-day leaf for the current IP.
7. Render and validate the isolated Nginx configuration.
8. Start Nginx with `daemon off` and record exact ownership.
9. Probe the CA download, TLS chain, `/` redirect, `/admin/`, `/member/`, `/health`, and SSE headers.
10. Recompare all `8790` evidence byte-for-byte.
11. Print only public URLs and the CA SHA-256 fingerprint. The separate administrator handoff command prints only its protected file path.

- [ ] **Step 4: Implement PID-scoped LAN shutdown**

Open and validate the saved manifest using `O_NOFOLLOW`; open the recorded PID with `os.pidfd_open`; revalidate `/proc/<pid>/stat`, cwd, cmdline, executable, Nginx prefix, config hash, and exact `9080`/`9443` listeners; then send `SIGTERM` with `signal.pidfd_send_signal`. Remove only the LAN Nginx manifest after the process and both listeners are gone.

- [ ] **Step 5: Run lifecycle and static tests**

Run:

```bash
npm run test -w @family-ai/gateway -- memberPreviewLan.test.ts memberPreviewScripts.test.ts
npm run test:scripts
bash -n scripts/member-preview-lan-up.sh
bash -n scripts/member-preview-lan-down.sh
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/member-preview-lan-up.sh scripts/member-preview-lan-down.sh scripts/member-preview-lan-lib.mjs scripts/static-check.sh apps/gateway/test/memberPreviewLan.test.ts
git commit -m "feat: add isolated LAN preview lifecycle"
```

## Task 7: Document the direct product experience

**Files:**
- Modify: `README.md`
- Create: `docs/development/2026-07-28-lan-admin-member-experience.md`
- Modify: `Dockerfile`

- [ ] **Step 1: Write the operator contract**

Document exact commands and results:

```bash
./scripts/member-preview-lan-up.sh
node scripts/member-preview-admin.mjs --origin https://192.168.110.84:9443
```

Explain one-time CA installation on macOS/iOS, how to open the protected administrator handoff without printing its contents, the main product flow to experience, how to stop only the LAN proxy, and how to verify `8790` remains untouched.

State clearly that `/admin/` exists only in development mode and that HTTP `9080` distributes only the public CA certificate.

- [ ] **Step 2: Include Admin Web assets in development build inputs**

Ensure the build/test stage sees `admin-public`. Do not copy Admin Web into the production runtime image because production never registers the routes.

- [ ] **Step 3: Run doc-sensitive static checks**

Run:

```bash
npm run test:scripts
git diff --check
```

Expected: pass and no secret-bearing example outside protected fragments.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/development/2026-07-28-lan-admin-member-experience.md Dockerfile
git commit -m "docs: explain LAN admin and member experience"
```

## Task 8: Full verification, real LAN acceptance, review, and local merge

**Files:**
- Verify all changed files
- Merge into: `/home/youran/Development/family-ai-platform`

- [ ] **Step 1: Run the complete clean verification gate**

Run:

```bash
npm run check
git diff --check
git status --short
```

Expected: all tests, static checks, typecheck, and build pass; only intended changes exist before the final commit.

- [ ] **Step 2: Perform a fresh self-review**

Review the complete diff against the approved specification. Pay special attention to secret sinks, query strings, admin route production isolation, TLS lifetime and SAN validation, symlink/permission handling, PID reuse, listener ownership, SSE buffering, and unchanged `8790`.

- [ ] **Step 3: Start the real LAN experience**

On `Admin-YR`:

```bash
./scripts/member-preview-lan-up.sh
node scripts/member-preview-admin.mjs --origin https://192.168.110.84:9443
```

Verify with the generated CA:

```bash
curl --fail --cacert .runtime-preview/tls/ca.crt https://192.168.110.84:9443/health
curl --fail --cacert .runtime-preview/tls/ca.crt https://192.168.110.84:9443/admin/
curl --fail --cacert .runtime-preview/tls/ca.crt https://192.168.110.84:9443/member/
```

Install and trust only `.runtime-preview/tls/ca.crt` on the Mac login keychain, then open the protected administrator handoff without echoing it. In the browser:

1. Confirm the administrator identity and family.
2. Add one member.
3. Generate a pairing code and QR.
4. Open “在本机进入成员端”.
5. Confirm the fragment is scrubbed.
6. Confirm the Member Web loads the selected member.
7. Send a chat message and open Work.
8. Revoke or expire the pairing and confirm it cannot be reused.

- [ ] **Step 4: Re-run unchanged-service evidence**

Compare `8790` health SHA-256, exact Docker row, and exact listener row to the pre-start snapshot. Confirm `8791` stays loopback-only and only the isolated Nginx owns `9080` and `9443`.

- [ ] **Step 5: Commit final fixes and verify the feature tip**

After any review fixes, rerun:

```bash
npm run check
git diff --check
git status --short
git log -1 --oneline
```

Commit any final review changes with a narrow message.

- [ ] **Step 6: Merge locally without remote push**

In `/home/youran/Development/family-ai-platform`, verify the checkout is clean and still points to the expected base. Merge:

```bash
git merge --ff-only fix/member-web-entry-hardening
```

Then rerun the full verification gate from the merged checkout. Keep the feature worktree and branch, leave the LAN experience running, and do not push to any remote.
