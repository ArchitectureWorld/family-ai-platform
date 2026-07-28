# Windows Admin One-Time Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a new Windows browser to enter the development Family AI Admin Web with a five-minute, one-time code that Codex sends to the user without exposing the long-lived administrator credential.

**Architecture:** A Preview script writes a protected salted activation hash beside the existing protected Admin entry. A development-only Gateway endpoint validates and atomically consumes that record, authenticates the persisted family-admin entry, and returns the existing entry credential once; the Admin Web stores it only in SessionStorage and renders management.

**Tech Stack:** Node.js ESM scripts, TypeScript, Fastify, Zod, Vitest, browser-native ES modules, SQLite-backed `EntrySessionAuthenticator`, Linux protected runtime files.

## Global Constraints

- All Linux implementation, test, deployment, and verification commands run through `ssh admin-yr`.
- Work only in `/home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening` until the verified feature is ready to merge.
- The activation code format is exactly `XXXXX-XXXXX`, using `[A-HJ-NP-Z2-9]`, and its lifetime is exactly five minutes.
- Codex sends the newly generated short code and exact expiration time to the user after deployment; it must not be left only on Linux.
- Never print, send, or log the protected Admin URL, entry-session token, bootstrap token, or `admin-entry.json`.
- Linux stores only a salted SHA-256 activation hash, never the plaintext activation code.
- The exchange route exists only with explicit development Admin Preview configuration and is absent in test and production modes.
- The code succeeds once, cannot be replayed, and is stored only in browser SessionStorage after exchange.
- Do not change or restart the existing port 8790 service.
- Every behavior change follows RED, verified RED, minimal GREEN, verified GREEN, then refactor.

---

## File Structure

- Create `scripts/member-preview-admin-activate.mjs`: generate the short code and protected activation record; expose a testable function plus CLI.
- Create `apps/gateway/src/adminPreviewActivation.ts`: strict record parsing, safe protected-file reads, one-time atomic consumption, Admin entry authentication, and route registration.
- Create `apps/gateway/test/adminPreviewActivation.test.ts`: real Fastify integration coverage for correct, wrong, expired, replayed, disabled, revoked, and unsafe-file cases.
- Modify `apps/gateway/src/app.ts`: register the new route with the same explicit Preview configuration as persistence.
- Modify `apps/gateway/test/memberPreviewScripts.test.ts`: exercise the real generator and its filesystem/stdout contract.
- Modify `apps/gateway/admin-public/index.html`: add the recovery activation form.
- Modify `apps/gateway/admin-public/admin-api.js`: normalize the code and exchange it without existing Admin authorization headers.
- Modify `apps/gateway/admin-public/admin.js`: submit the recovery form, store the returned credential, and render management.
- Modify `apps/gateway/admin-public/admin.css`: style the compact recovery form and monospace code input.
- Modify `apps/gateway/test/adminWebModules.test.ts`: validate code normalization, public exchange behavior, response validation, and errors.
- Modify `apps/gateway/test/adminWeb.test.ts`: verify the recovery form is served with the protected Admin page.
- Modify `scripts/static-check.sh`: include the new Preview script in protected-entrypoint and secret-output scans.

---

### Task 1: Protected activation-code generator

**Files:**

- Create: `scripts/member-preview-admin-activate.mjs`
- Modify: `apps/gateway/test/memberPreviewScripts.test.ts`
- Modify: `scripts/static-check.sh`

**Interfaces:**

- Consumes: `previewInternals.prepareRuntime`, `previewInternals.protectedFile`, and `previewInternals.atomicProtectedJson` from `scripts/member-preview-pair.mjs`.
- Produces:

```js
export async function createAdminPreviewActivation({
  runtimeDir,
  now = () => new Date(),
  randomBytesImpl = randomBytes
} = {}) {
  return { code, expiresAt, outputPath };
}
```

- CLI stdout: one line matching `^([A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}) expiresAt=(.+Z)$`.
- Protected record:

```json
{
  "version": 1,
  "createdAt": "2026-07-28T00:00:00.000Z",
  "expiresAt": "2026-07-28T00:05:00.000Z",
  "salt": "base64url",
  "codeHash": "64-lowercase-hex"
}
```

- [ ] **Step 1: Add a failing real-script test**

Add the new script to the `scripts` fixture list and add a test in
`apps/gateway/test/memberPreviewScripts.test.ts`:

```ts
it("creates a five-minute Admin activation record without persisting the plaintext code", async () => {
  const { createAdminPreviewActivation } = await import(
    `${new URL("../../../scripts/member-preview-admin-activate.mjs", import.meta.url).href}?activation=${Date.now()}`
  );
  const runtimeDir = temporaryDirectory();
  const admin = installAdminFixture(runtimeDir);
  const now = new Date("2030-01-01T00:00:00.000Z");

  const result = await createAdminPreviewActivation({
    runtimeDir,
    now: () => now,
    randomBytesImpl: (length: number) => Buffer.alloc(length, 7)
  });

  expect(result.code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  expect(result.expiresAt).toBe("2030-01-01T00:05:00.000Z");
  expect(result.outputPath).toBe(join(runtimeDir, "config/admin-activation.json"));
  expect(permissions(result.outputPath)).toBe(0o600);
  const serialized = readFileSync(result.outputPath, "utf8");
  const record = JSON.parse(serialized);
  expect(record).toMatchObject({
    version: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:05:00.000Z"
  });
  expect(record.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(record.codeHash).toMatch(/^[0-9a-f]{64}$/);
  expect(serialized).not.toContain(result.code);
  expect(serialized).not.toContain(admin.token);
});
```

Add cases that a symlinked `admin-entry.json` fails closed and that generating
again replaces the previous record with a different hash.

Name the break caught: persisting plaintext, leaking the Admin token, creating a
longer-lived code, following an unsafe Admin file, or retaining an earlier code.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && npm test -w @family-ai/gateway -- memberPreviewScripts.test.ts'
```

Expected: FAIL because `member-preview-admin-activate.mjs` does not exist.

- [ ] **Step 3: Implement the minimal generator**

Create `scripts/member-preview-admin-activate.mjs` with:

```js
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { previewInternals } from "./member-preview-pair.mjs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIFETIME_MS = 5 * 60 * 1000;

function symbols(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 10) {
    throw new previewInternals.PreviewError("PREVIEW_ACTIVATION_RANDOM_INVALID");
  }
  return [...bytes.subarray(0, 10)]
    .map(value => ALPHABET[value & 31])
    .join("");
}

function hashCode(salt, code) {
  return createHash("sha256").update(`${salt}\0${code}`, "utf8").digest("hex");
}

export async function createAdminPreviewActivation(options = {}) {
  const paths = await previewInternals.prepareRuntime(options.runtimeDir);
  const adminPath = join(paths.configDir, "admin-entry.json");
  await previewInternals.protectedFile(adminPath);
  const now = (options.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new previewInternals.PreviewError("PREVIEW_ACTIVATION_TIME_INVALID");
  }
  const random = options.randomBytesImpl ?? randomBytes;
  const raw = symbols(random(10));
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  const salt = random(16).toString("base64url");
  const outputPath = join(paths.configDir, "admin-activation.json");
  const expiresAt = new Date(now.getTime() + LIFETIME_MS).toISOString();
  await previewInternals.atomicProtectedJson(outputPath, {
    version: 1,
    createdAt: now.toISOString(),
    expiresAt,
    salt,
    codeHash: hashCode(salt, code)
  });
  return { code, expiresAt, outputPath };
}
```

Add a CLI that accepts no arguments, calls the function, and prints only:

```js
process.stdout.write(`${result.code} expiresAt=${result.expiresAt}\n`);
```

On failure print only `PREVIEW_ADMIN_ACTIVATION_FAILED`.

Add `scripts/member-preview-admin-activate.mjs` to both the test `scripts` array
and `preview_scripts` in `scripts/static-check.sh`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 command again.

Expected: all `memberPreviewScripts.test.ts` tests PASS and no token appears in
stdout.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/member-preview-admin-activate.mjs apps/gateway/test/memberPreviewScripts.test.ts scripts/static-check.sh
git commit -m "feat: generate one-time admin activation codes"
```

---

### Task 2: Development-only one-time exchange endpoint

**Files:**

- Create: `apps/gateway/src/adminPreviewActivation.ts`
- Create: `apps/gateway/test/adminPreviewActivation.test.ts`
- Modify: `apps/gateway/src/app.ts`

**Interfaces:**

- Consumes: configured `previewAdminEntryPath`, configured loopback origin,
  `EntrySessionAuthenticator.authenticate(entrySessionRef, token)`, and
  `GatewayDomainError`.
- Produces:

```ts
export function registerAdminPreviewActivation(
  app: FastifyInstance,
  input: {
    mode: "test" | "development" | "production";
    adminEntryPath?: string;
    origin?: string;
    entryAuthenticator: EntrySessionAuthenticator;
    now?: () => Date;
  }
): void;
```

- Endpoint: `POST /api/v1/admin/preview-activation`
- Success body:

```json
{
  "adminCredential": {
    "kind": "entry",
    "entrySessionRef": "entry-session:...",
    "token": "..."
  }
}
```

- Error codes: `PREVIEW_ACTIVATION_INVALID`, `PREVIEW_ACTIVATION_EXPIRED`,
  `PREVIEW_ACTIVATION_UNAVAILABLE`, and `PREVIEW_ADMIN_ENTRY_INVALID`.

- [ ] **Step 1: Write failing Fastify integration tests**

Create `apps/gateway/test/adminPreviewActivation.test.ts`. Use a real temporary
SQLite database, initialize a family through `/api/v1/onboarding/family`, persist
the Admin entry, and write literal activation records.

The primary test:

```ts
it("exchanges a correct activation code for the current family-admin entry exactly once", async () => {
  const fixture = await initializedPreview();
  writeActivation(fixture.activationPath, {
    code: "ABCDE-FGHJK",
    now: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:05:00.000Z"
  });

  const first = await fixture.app.inject({
    method: "POST",
    url: "/api/v1/admin/preview-activation",
    payload: { code: "ABCDE-FGHJK" }
  });
  expect(first.statusCode).toBe(200);
  expect(first.headers["cache-control"]).toBe("no-store");
  expect(first.json()).toEqual({
    adminCredential: {
      kind: "entry",
      entrySessionRef: fixture.admin.entrySessionRef,
      token: fixture.admin.token
    }
  });

  const replay = await fixture.app.inject({
    method: "POST",
    url: "/api/v1/admin/preview-activation",
    payload: { code: "ABCDE-FGHJK" }
  });
  expect(replay.statusCode).toBe(404);
  expect(replay.json().code).toBe("PREVIEW_ACTIVATION_UNAVAILABLE");
});
```

Add independent cases for:

- wrong and malformed codes return no `adminCredential`, while a later correct
  exchange still succeeds;
- an expired record returns `410/PREVIEW_ACTIVATION_EXPIRED`;
- a revoked persisted Admin entry returns
  `401/PREVIEW_ADMIN_ENTRY_INVALID` without credential material;
- symlinked or non-`0600` Admin/activation files fail closed;
- two concurrent correct requests produce one 200 and one unavailable response;
- test and production apps, and development apps without explicit persistence
  configuration, return 404.

Name the breaks caught: replay, wrong-code consumption, expiry bypass, stale
Admin authorization, symlink following, permission weakening, double success,
or accidental production exposure.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && npm test -w @family-ai/gateway -- adminPreviewActivation.test.ts'
```

Expected: FAIL because the route returns 404 and the module is absent.

- [ ] **Step 3: Implement safe parsing and atomic consumption**

In `adminPreviewActivation.ts` define strict Zod schemas for the exact request,
activation record, and persisted Admin entry. Read protected files through
`open(path, constants.O_RDONLY | constants.O_NOFOLLOW)`, validate that the open
handle is a regular `0600` file below the expected absolute directory, enforce
the size ceiling, and parse UTF-8 JSON with exact keys.

Compare the salted SHA-256 hash with `timingSafeEqual`. After a code matches,
atomically rename `admin-activation.json` to a unique claim file. Re-read the
claim file and compare its bytes to those validated before the rename:

```ts
const claimPath = `${activationPath}.claim.${randomUUID()}`;
await rename(activationPath, claimPath).catch(error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    throw unavailable();
  }
  throw error;
});
const claimedBytes = await readProtectedBytes(claimPath);
if (!timingSafeEqual(originalBytes, claimedBytes)) {
  await link(claimPath, activationPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await rm(claimPath, { force: true });
  throw unavailable();
}
```

This byte check prevents a code validated against an older record from consuming
a newly generated record. Remove the claim file in `finally`.

Authenticate the parsed Admin entry:

```ts
const authentication = input.entryAuthenticator.authenticate(
  admin.entrySessionRef,
  admin.token
);
if (
  authentication.status !== "authenticated" ||
  authentication.context.audience !== "family_admin"
) {
  throw adminEntryInvalid();
}
```

Perform this authentication before consuming the activation record. After
successful consumption, return only the validated `entrySessionRef` and token.
Set `Cache-Control: no-store` on every endpoint response.

Register the module from `app.ts` beside
`registerAdminPreviewPersistence`, passing the same explicit configuration and
the app-level `now` function.

- [ ] **Step 4: Run endpoint tests and verify GREEN**

Run:

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && npm test -w @family-ai/gateway -- adminPreviewActivation.test.ts adminPreviewPersistence.test.ts'
```

Expected: both test files PASS.

- [ ] **Step 5: Refactor only duplicated protected-path primitives**

If the new module duplicates absolute-path/origin validation already exported by
`adminPreviewPersistence.ts`, extract only pure reusable validation into named
exports. Do not broaden production behavior or change the existing persistence
route. Re-run the Task 2 GREEN command.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/gateway/src/adminPreviewActivation.ts apps/gateway/src/app.ts apps/gateway/test/adminPreviewActivation.test.ts apps/gateway/src/adminPreviewPersistence.ts
git commit -m "feat: exchange one-time admin activation codes"
```

Omit `adminPreviewPersistence.ts` from `git add` if no extraction was needed.

---

### Task 3: Strict browser API exchange

**Files:**

- Modify: `apps/gateway/admin-public/admin-api.js`
- Modify: `apps/gateway/test/adminWebModules.test.ts`

**Interfaces:**

- Produces:

```js
export function normalizeActivationCode(value) // -> "XXXXX-XXXXX"
createAdminApi({ credential: null }).exchangePreviewActivation(code)
// -> validated { kind: "entry", entrySessionRef, token }
```

- [ ] **Step 1: Write the failing browser-module test**

Extend the Admin API client test:

```ts
expect(normalizeActivationCode(" abcde-fghjk ")).toBe("ABCDE-FGHJK");
expect(() => normalizeActivationCode("ABCDE-FGHIJ"))
  .toThrow("ADMIN_ACTIVATION_CODE_INVALID");

const publicApi = createAdminApi({ fetchImpl });
expect(await publicApi.exchangePreviewActivation("abcde-fghjk")).toEqual({
  kind: "entry",
  entrySessionRef: "entry-session:preview-admin",
  token
});
expect(requests.at(-1)).toMatchObject({
  url: "/api/v1/admin/preview-activation",
  init: {
    method: "POST",
    body: JSON.stringify({ code: "ABCDE-FGHJK" })
  }
});
expect(requests.at(-1)!.init.headers).toEqual({
  "Content-Type": "application/json"
});
```

Add a malformed-success fixture and assert
`ADMIN_PREVIEW_ACTIVATION_RESPONSE_INVALID`. Name the breaks caught: sending
existing Admin headers, accepting ambiguous codes, or accepting credential
material that bypasses `validateAdminCredential`.

- [ ] **Step 2: Run the module test and verify RED**

Run:

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && npm test -w @family-ai/gateway -- adminWebModules.test.ts'
```

Expected: FAIL because `normalizeActivationCode` and
`exchangePreviewActivation` are absent.

- [ ] **Step 3: Implement the minimal client method**

Add:

```js
const ACTIVATION_CODE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/u;

export function normalizeActivationCode(value) {
  if (typeof value !== "string") throw new Error("ADMIN_ACTIVATION_CODE_INVALID");
  const normalized = value.trim().toUpperCase();
  if (!ACTIVATION_CODE.test(normalized)) {
    throw new Error("ADMIN_ACTIVATION_CODE_INVALID");
  }
  return normalized;
}
```

Add `exchangePreviewActivation` to the frozen client. It performs a public POST,
expects 200, requires exact `adminCredential`, and validates it through the
existing `validateAdminCredential`.

- [ ] **Step 4: Run the module test and verify GREEN**

Run the Task 3 command again.

Expected: all Admin Web module tests PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/gateway/admin-public/admin-api.js apps/gateway/test/adminWebModules.test.ts
git commit -m "feat: add Admin Web activation client"
```

---

### Task 4: Windows recovery-page activation experience

**Files:**

- Modify: `apps/gateway/admin-public/index.html`
- Modify: `apps/gateway/admin-public/admin.js`
- Modify: `apps/gateway/admin-public/admin.css`
- Modify: `apps/gateway/test/adminWeb.test.ts`
- Modify: `apps/gateway/test/adminWebModules.test.ts`

**Interfaces:**

- Consumes: `createAdminApi().exchangePreviewActivation`,
  `writeStoredAdminCredential`, and `renderManagement`.
- Produces: an accessible `#admin-activation-form`, `#admin-activation-code`,
  `#admin-activation-submit`, and `#admin-activation-message`.

- [ ] **Step 1: Write failing product-page tests**

Extend `adminWeb.test.ts`:

```ts
expect(admin.body).toContain('id="admin-activation-form"');
expect(admin.body).toContain('id="admin-activation-code"');
expect(admin.body).toContain('autocomplete="one-time-code"');
expect(admin.body).toContain("激活管理员设备");
expect(admin.body).not.toContain(token);
```

Extend the API error fixture in `adminWebModules.test.ts` to assert the public
error codes remain available as `AdminApiError.code`, enabling the page to map
wrong, expired, unavailable, and invalid-Admin cases independently.

Name the breaks caught: leaving Windows with instructions but no input,
autocomplete regression, secret embedding, or collapsing actionable failures
into an unusable generic state.

- [ ] **Step 2: Run Admin Web tests and verify RED**

Run:

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && npm test -w @family-ai/gateway -- adminWeb.test.ts adminWebModules.test.ts'
```

Expected: FAIL because the activation form is absent.

- [ ] **Step 3: Add the recovery form and submit flow**

Replace the recovery-only paragraph with:

```html
<p>输入五分钟有效的一次性管理员激活码，验证后即可管理家庭成员。</p>
<form class="activation-form" id="admin-activation-form">
  <label class="field" for="admin-activation-code">
    <span>管理员激活码</span>
    <input
      id="admin-activation-code"
      name="activationCode"
      autocomplete="one-time-code"
      inputmode="text"
      maxlength="11"
      placeholder="XXXXX-XXXXX"
      required
    >
  </label>
  <button class="primary-button" id="admin-activation-submit" type="submit">
    激活管理员设备
  </button>
  <p class="form-message" id="admin-activation-message" role="status" aria-live="polite"></p>
</form>
```

In `admin.js`, bind the form once. On submit:

```js
const credential = await createAdminApi().exchangePreviewActivation(
  new FormData(form).get("activationCode")
);
writeStoredAdminCredential(sessionStorage, credential);
await renderManagement(credential);
```

Disable the button during submission, clear the raw input immediately after
success, and re-enable it after an error. Map:

```js
PREVIEW_ACTIVATION_INVALID       -> 激活码不正确，请检查后重试。
PREVIEW_ACTIVATION_EXPIRED       -> 激活码已过期，请生成新码。
PREVIEW_ACTIVATION_UNAVAILABLE   -> 当前没有可用的激活码，请生成新码。
PREVIEW_ADMIN_ENTRY_INVALID      -> 管理员入口已失效，请重新启动预览。
fallback                         -> 暂时无法激活，请检查连接后重试。
```

Style `.activation-form` with the same grid/spacing as `.form-grid`; use
monospace, uppercase display, and increased letter spacing only for the code
input. Keep responsive behavior within the existing card.

- [ ] **Step 4: Run Admin Web tests and verify GREEN**

Run the Task 4 command again.

Expected: both Admin Web test files PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/gateway/admin-public/index.html apps/gateway/admin-public/admin.js apps/gateway/admin-public/admin.css apps/gateway/test/adminWeb.test.ts apps/gateway/test/adminWebModules.test.ts
git commit -m "feat: activate Admin Web with a short code"
```

---

### Task 5: Repository gates, merge, live rollout, and user handoff

**Files:**

- Verify all files changed in Tasks 1-4.
- Update the existing runtime under
  `/home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening/.runtime-preview`.
- Do not modify the port 8790 runtime.

**Interfaces:**

- Produces: green repository gates, a reviewed feature branch, merged `main`,
  refreshed port 8791/9443 Preview, and a user-visible one-time code.

- [ ] **Step 1: Run focused regression tests**

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && npm test -w @family-ai/gateway -- memberPreviewScripts.test.ts adminPreviewActivation.test.ts adminPreviewPersistence.test.ts adminWeb.test.ts adminWebModules.test.ts'
```

Expected: PASS with no warnings or leaked secrets.

- [ ] **Step 2: Run static and full repository gates**

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && npm run test:scripts && npm run check'
```

Expected: all workspace tests, script tests, typecheck, and build PASS.

- [ ] **Step 3: Review the complete branch**

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && git status --short && git diff --check && git log --oneline 4ce2db2..HEAD && git diff --stat 4ce2db2..HEAD'
```

Verify there are no runtime files, activation records, codes, tokens, protected
URLs, unrelated edits, or uncommitted changes.

- [ ] **Step 4: Merge only after the verified branch is clean**

Use `superpowers:finishing-a-development-branch`. Fast-forward or merge the
verified commits into `/home/youran/Development/family-ai-platform` without
deleting the retained worktree because that worktree owns the live Preview.
Run `npm run check` on merged `main` and record both SHAs.

- [ ] **Step 5: Refresh only the authorized Preview services**

Use the existing Preview lifecycle scripts from the retained worktree to restart
8791 and the isolated 9080/9443 Nginx Preview. Before and after, record:

- process identity and cwd for 8791/9080/9443;
- SHA-256 of the unchanged port 8790 response;
- listener addresses;
- HTTPS `/admin/` status with the Preview CA;
- `POST /api/v1/admin/preview-activation` wrong-code response without any
  credential fields.

- [ ] **Step 6: Generate and send the live one-time code**

Only after the refreshed Preview is healthy, run:

```bash
ssh admin-yr 'cd /home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening && node scripts/member-preview-admin-activate.mjs'
```

Capture the single output line. Immediately send the `XXXXX-XXXXX` value and its
exact `expiresAt` timestamp to the user in the active conversation. Do not show
the protected file, long-lived Admin URL, or Admin token.

- [ ] **Step 7: Complete Windows acceptance**

Ask the user to enter the delivered code on the already open Windows `/admin/`
page. Confirm:

1. the family management view opens;
2. the member list is visible;
3. the user can press `生成配对码`;
4. a separate member pairing code and QR appear;
5. reuse of the Admin activation code fails.

If the five-minute code expires before user entry, generate a new code and send
the replacement immediately; the earlier record is replaced and no longer
usable.

---

## Plan Self-Review

- Spec coverage: generator, hashed storage, five-minute lifetime, one-time
  exchange, development-only registration, strict browser validation, Windows
  form, secret boundaries, full gates, deployment, and conversation delivery
  each have an explicit task.
- Type consistency: the server returns `adminCredential`; the client validates
  and returns that credential; the page stores the returned credential.
- Security consistency: only the short code and expiration are output; all
  long-lived credential material remains inside protected runtime/API transport.
- Scope consistency: no production recovery system, password database, Internet
  exposure, member pairing redesign, or port 8790 mutation is introduced.
