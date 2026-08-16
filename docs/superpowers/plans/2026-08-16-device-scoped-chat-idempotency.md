# Device-Scoped Chat/Work Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent one active device from receiving another device's cached Chat/Work message and Provider result when both reuse the same `threadRef + clientMessageId`, while preserving original-device replay, Person-level sync, and a directly usable Member Web.

**Architecture:** Keep the existing `thread_ref + client_message_id` unique key and immediate SQLite transaction. After Thread authorization and message provenance validation, compare the stored and incoming `origin.deviceRef` before comparing the existing logical fingerprint; both device and payload mismatches return the same sanitized conflict. The change remains below the Provider Lane, so rejected requests cannot create a second Provider Turn or call the adapter.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, Vitest, Fake Provider Adapter, Docker Compose, Bash, agent-browser.

---

### Task 1: Prove and fix device-scoped message replay

**Files:**
- Modify: `apps/gateway/test/chatWorkDomainSecurity.test.ts`
- Modify: `apps/gateway/test/chatWorkProvider.test.ts`
- Modify: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`
- Verify unchanged: `apps/gateway/test/deviceSyncIsolation.test.ts`
- Modify: `apps/gateway/src/chatWorkDomain.ts`

- [ ] **Step 1: Add a second active owner-device fixture to the Domain security test**

Import `sha256` from `../src/database.js` and add this helper inside the existing `describe` block:

```ts
function bindSecondOwnerDevice(): string {
  const deviceRef = "device:second-owner-domain";
  db.transaction(() => {
    db.prepare(
      `INSERT INTO managed_devices
       (device_ref, display_name, terminal_type, platform, status, credential_hash,
        created_at, updated_at, revoked_at)
       VALUES(?, 'Second Owner Web', 'web', 'test', 'active', ?, ?, ?, NULL)`
    ).run(deviceRef, sha256("second-owner-domain-credential"), fixedNow.toISOString(), fixedNow.toISOString());
    db.prepare(
      `INSERT INTO device_bindings
       (device_binding_ref, device_ref, owner_scope, family_ref, person_ref,
        status, bound_at, revoked_at)
       SELECT 'device-binding:second-owner-domain', ?, 'person', family_ref, ?,
              'active', ?, NULL
       FROM family_memberships
       WHERE person_ref = ? AND status = 'active'`
    ).run(deviceRef, ownerPersonRef, fixedNow.toISOString(), ownerPersonRef);
  })();
  return deviceRef;
}
```

Add one behavior test after the existing reconnect replay test:

```ts
it("rejects a replay from another active device before returning the first message", () => {
  const chat = repository.ensureHomeChat({
    personRef: ownerPersonRef,
    timezone: "UTC",
    localDate: "2026-07-23"
  });
  const input = {
    personRef: ownerPersonRef,
    threadRef: chat.chat.threadRef,
    clientMessageId: "cross-device-domain-0001",
    actor: { type: "person" as const, personRef: ownerPersonRef },
    origin: {
      deviceRef: ownerDeviceRef,
      connectionRef: null,
      entryAudience: "personal" as const
    },
    content: { type: "text" as const, text: "设备 A 的私密消息。", language: "zh-CN" },
    occurredAt: fixedNow.toISOString()
  };
  const first = repository.appendThreadMessage(input);
  const secondDeviceRef = bindSecondOwnerDevice();

  for (const content of [input.content, { ...input.content, text: "设备 B 的不同正文。" }]) {
    try {
      repository.appendThreadMessage({
        ...input,
        origin: { ...input.origin, deviceRef: secondDeviceRef },
        content
      });
      throw new Error("Expected a device-scoped conflict");
    } catch (error) {
      expect(error).toMatchObject({
        code: "THREAD_MESSAGE_CONFLICT",
        statusCode: 409,
        category: "conflict",
        retryable: false
      });
    }
  }

  expect(repository.appendThreadMessage(input)).toEqual(first);
  expect(repository.listThreadMessages({
    personRef: ownerPersonRef,
    threadRef: chat.chat.threadRef
  }).messages).toEqual([first]);
});
```

- [ ] **Step 2: Add a Provider-service regression that proves zero second call**

Import `sha256` from `../src/database.js`, add an equivalent `bindSecondOwnerDevice()` helper in the `Chat Work Message service` describe block, and add:

```ts
it("rejects another device before replaying a successful Provider Turn", async () => {
  const adapter = new FakeProviderAdapter({ clock: () => currentNow });
  const service = new ChatWorkMessageService(
    domainRepository,
    providerRepository,
    adapter,
    () => currentNow
  );
  const chat = domainRepository.ensureHomeChat({
    personRef: ownerPersonRef,
    timezone: "UTC",
    localDate: "2026-07-23"
  });
  const input = command(chat.chat.threadRef, "cross-device");
  const first = await service.sendPersonMessage(input);
  const secondDeviceRef = bindSecondOwnerDevice();

  await expect(service.sendPersonMessage({
    ...input,
    deviceRef: secondDeviceRef
  })).rejects.toMatchObject({ code: "THREAD_MESSAGE_CONFLICT", statusCode: 409 });
  await expect(service.sendPersonMessage({
    ...input,
    deviceRef: secondDeviceRef,
    content: { ...input.content, text: "不同正文也不得形成内容 oracle。" }
  })).rejects.toMatchObject({ code: "THREAD_MESSAGE_CONFLICT", statusCode: 409 });

  const replayed = await service.sendPersonMessage(input);
  expect(replayed).toMatchObject({
    message: first.message,
    assistantMessageRef: first.assistantMessageRef,
    replayedProviderTurn: true
  });
  expect(adapter.calls).toHaveLength(1);
  expect(domainRepository.listThreadMessages({
    personRef: ownerPersonRef,
    threadRef: chat.chat.threadRef
  }).messages).toHaveLength(2);
});
```

- [ ] **Step 3: Add a real HTTP/Entry Session regression**

Reuse `createSecondPersonalEntry({ familyRef, personRef: ownerPersonRef })` and add this test to `chatWorkRoutesSecurity.test.ts`:

```ts
it("does not expose one device's message or Provider result through another device replay", async () => {
  const chat = await app.inject({
    method: "GET",
    url: "/api/v1/chat?timezone=UTC",
    headers: entryHeaders(personal)
  });
  const threadRef = String(chat.json().chat.threadRef);
  const payload = {
    protocolVersion: 1,
    clientMessageId: "cross-device-route-0001",
    occurredAt: "2026-07-24T06:31:00.000Z",
    content: { type: "text", text: "设备 A 的路由私密标记。", language: "zh-CN" }
  };
  const first = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
    headers: entryHeaders(personal),
    payload
  });
  expect(first.statusCode).toBe(201);
  const firstBody = first.json() as {
    message: { messageRef: string; content: { text: string } };
    assistantMessageRef: string;
  };
  const second = createSecondPersonalEntry({ familyRef, personRef: ownerPersonRef });

  for (const content of [payload.content, { ...payload.content, text: "设备 B 的不同正文。" }]) {
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(second),
      payload: { ...payload, content }
    });
    expect(conflict.statusCode).toBe(409);
    expectPublicError(conflict, {
      code: "THREAD_MESSAGE_CONFLICT",
      category: "conflict",
      retryable: false
    });
    const serialized = JSON.stringify(conflict.json());
    expect(serialized).not.toContain(firstBody.message.messageRef);
    expect(serialized).not.toContain(firstBody.assistantMessageRef);
    expect(serialized).not.toContain(firstBody.message.content.text);
  }

  const replay = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
    headers: entryHeaders(personal),
    payload
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(first.json());
});
```

- [ ] **Step 4: Run the focused suite and verify RED**

Run:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/chatWorkDomainSecurity.test.ts \
  test/chatWorkRoutesSecurity.test.ts \
  test/chatWorkProvider.test.ts \
  test/deviceSyncIsolation.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Expected: the three new cross-device tests fail because same-payload device B currently receives device A's result. Existing original-device replay, authorization, and Device Sync tests remain green. A compile error, fixture error, or unrelated assertion is not an acceptable RED.

- [ ] **Step 5: Add one shared conflict constructor and the minimal device check**

Add next to `messageInvalid` in `chatWorkDomain.ts`:

```ts
function threadMessageConflict(): GatewayDomainError {
  return new GatewayDomainError(
    "THREAD_MESSAGE_CONFLICT",
    409,
    "conflict",
    false,
    "同一个客户端消息编号已经用于不同内容。"
  );
}
```

Change only the existing `if (existing)` branch:

```ts
if (existing) {
  if (existing.origin.deviceRef !== input.origin.deviceRef) {
    throw threadMessageConflict();
  }
  const existingFingerprint = logicalMessageFingerprint({
    actor: existing.actor,
    content: existing.content,
    occurredAt: existing.occurredAt,
    attachmentRefs: existing.attachments.map(
      (attachment) => attachment.attachmentRef
    )
  });
  const incomingFingerprint = logicalMessageFingerprint({
    ...input,
    attachmentRefs
  });
  if (existingFingerprint !== incomingFingerprint) {
    throw threadMessageConflict();
  }
  return existing;
}
```

Do not change the `requireThread → validateMessageProvenance → findMessageByClientId` order. Do not modify `chatWorkMessageService.ts`, the unique index, migrations, event queries, or sync cursors unless a failing test proves the design assumptions wrong.

- [ ] **Step 6: Run GREEN and nearby domain regression**

Run the focused command from Step 4, then:

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/chatWorkDomain.test.ts \
  test/chatWorkRoutes.test.ts \
  test/attachmentRoutes.test.ts \
  --maxWorkers=1 --no-file-parallelism
git diff --check
```

Expected: all selected tests pass; Fake Provider calls remain exactly one; the unchanged Device Sync test proves both devices still see the Person event with independent cursors.

- [ ] **Step 7: Commit the behavior change**

```bash
git add \
  apps/gateway/src/chatWorkDomain.ts \
  apps/gateway/test/chatWorkDomainSecurity.test.ts \
  apps/gateway/test/chatWorkProvider.test.ts \
  apps/gateway/test/chatWorkRoutesSecurity.test.ts
git commit -m "fix: scope chat idempotency to device"
```

### Task 2: Produce host and isolated candidate evidence

**Files:**
- No tracked changes in this task
- Evidence directory: new `mktemp -d` paths outside the repository

- [ ] **Step 1: Reinstall from the lock and run all host gates**

```bash
npm ci
npm run check
bash scripts/static-check.sh
git diff --check
```

Expected: contracts, Provider SDK, Gateway, script gates, typecheck, and build all pass with zero failed tests. Record exact passed/failed/skipped totals.

- [ ] **Step 2: Build an immutable candidate from the exact behavior commit**

Create a new absolute output directory with `mktemp -d`, then run:

```bash
b2_artifact_dir="$(mktemp -d /tmp/family-ai-b2-artifact.XXXXXX)"
bash scripts/build-gateway-image.sh \
  --source-commit "$(git rev-parse HEAD)" \
  --expected-source-commit "$(git rev-parse HEAD)" \
  --output-dir "$b2_artifact_dir"
b2_manifest="$b2_artifact_dir/gateway-image-manifest.json"
b2_image_ref="$(node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(value.imageId);
' "$b2_manifest")"
```

Expected: the image label, manifest `sourceCommit`, image ID, archive digest, and current HEAD agree exactly. Do not use a `local-unverified` image.

- [ ] **Step 3: Run isolated Gateway, core acceptance, and attachment persistence**

Use a new empty runtime and unique Compose project:

```bash
b2_runtime_dir="$(mktemp -d /tmp/family-ai-b2-runtime.XXXXXX)"
b2_project="family-ai-b2-$(git rev-parse --short=8 HEAD)"
FAMILY_AI_RUNTIME_ROOT="$b2_runtime_dir" \
COMPOSE_PROJECT_NAME="$b2_project" \
FAMILY_AI_HOST_PORT=0 \
FAMILY_AI_IMAGE_REF="$b2_image_ref" \
FAMILY_AI_IMAGE_MANIFEST="$b2_manifest" \
./scripts/dev-up.sh

FAMILY_AI_RUNTIME_ROOT="$b2_runtime_dir" \
COMPOSE_PROJECT_NAME="$b2_project" \
./scripts/acceptance.sh

FAMILY_AI_RUNTIME_ROOT="$b2_runtime_dir" \
COMPOSE_PROJECT_NAME="$b2_project" \
./scripts/acceptance-container-attachments.sh
```

Expected: two messages, idempotency, cross-Agent isolation, restart recovery, third continuation, and two-chunk attachment reassembly all pass. Capture the report path and manifest identity without printing credentials.

- [ ] **Step 4: Complete one evidence-browser journey**

Use the same candidate to generate a protected one-time Member handoff and complete the exact browser sequence from Task 4 Step 4. This first browser run supplies documentation evidence; it does not become the final user runtime because Task 3 will add a docs-only commit. Record only the source commit, image ID, random loopback port, public browser outcomes, and screenshot path.

- [ ] **Step 5: Stop this evidence-only candidate**

Run:

```bash
FAMILY_AI_RUNTIME_ROOT="$b2_runtime_dir" \
COMPOSE_PROJECT_NAME="$b2_project" \
./scripts/dev-down.sh
```

Confirm its random port has no listener and no container remains. Do not stop formal `8790`.

### Task 3: Close B2 documentation with verified evidence

**Files:**
- Modify: `apps/gateway/README.md`
- Modify: `docs/superpowers/plans/2026-08-13-security-and-identity-hardening.md`
- Modify: `docs/superpowers/plans/2026-08-13-deep-review-remediation-program.md`
- Create: `docs/development/2026-08-16-device-scoped-chat-idempotency.md`

- [ ] **Step 1: Update the Gateway security contract**

Add a concise paragraph under Core Security Rules stating:

```markdown
Chat/Work 的 `threadRef + clientMessageId` 幂等返回还要求来源 device 完全一致；
不同 active device 复用同一 key 时，无论 payload 是否相同都返回同一个净化后的
`409 THREAD_MESSAGE_CONFLICT`，且不会读取已有 Provider 结果或再次调用 Provider。
该限制不改变同一 Person 多设备的领域事件可见性，Sync cursor/ACK 仍按 device 隔离。
```

- [ ] **Step 2: Close the B2 checklist and master status without overstating deployment**

In the security plan, mark only verified B2 RED/GREEN/implementation items complete and record B1a as merged by PR #37 / `cd742fb`. In the remediation master table, set B1a to merged and B2 to `已实现，待独立 PR`; retain B1b as H0 blocked. Do not claim formal `8790` contains B2.

- [ ] **Step 3: Write the development record with the unified gate matrix**

Create `docs/development/2026-08-16-device-scoped-chat-idempotency.md` covering:

```markdown
| Gate | Result | Evidence |
|---|---|---|
| Focused RED | PASS | exact failing tests and expected old behavior |
| Focused GREEN/domain regression | PASS | exact file/test totals |
| npm ci/npm run check | PASS | exact totals, typecheck, build |
| Immutable build/Docker | PASS | source commit, image ID, archive hash |
| Isolated dev-up/acceptance | PASS | runtime/project/random loopback/report |
| Task container/browser | PASS | attachment persistence and first real browser journey |
| Formal service/real Provider | SKIP | formal 8790 untouched; real Provider not authorized |
| Documentation/ledger | PASS | no persistent port or Hermes architecture change |
```

Explain that no Schema or Hermes architecture change occurred. Evidence-only random ports were destroyed and did not enter inventory; the final retained experience port will be written to both port ledgers after it exists. Never include tokens, cookies, message bodies, or private handoff material.

- [ ] **Step 4: Run documentation gates and commit**

```bash
bash scripts/static-check.sh
git diff --check
git add \
  apps/gateway/README.md \
  docs/superpowers/plans/2026-08-13-security-and-identity-hardening.md \
  docs/superpowers/plans/2026-08-13-deep-review-remediation-program.md \
  docs/development/2026-08-16-device-scoped-chat-idempotency.md
git commit -m "docs: record device-scoped idempotency"
```

### Task 4: Build the final exact HEAD and leave a directly usable Member Web

**Files:**
- No tracked changes after the final exact-head build
- Runtime: new `mktemp -d` directory outside the repository, retained for user experience

- [ ] **Step 1: Re-run fresh final host verification**

```bash
npm run check
bash scripts/static-check.sh
git diff --check
git status -sb
```

Expected: clean worktree and all gates pass at the final documentation HEAD.

- [ ] **Step 2: Build and start the final exact HEAD**

Repeat the immutable build wrapper with a new output directory. Start a new unique runtime with `FAMILY_AI_HOST_PORT=0`, record the actual loopback port from the runtime manifest, and prove `sourceCommit`, image ID, container image, and final HEAD are identical.

- [ ] **Step 3: Run final exact-head automatic acceptance**

Run `acceptance.sh` and `acceptance-container-attachments.sh` against the final runtime. Keep this runtime running after success; it is the user's experience environment.

- [ ] **Step 4: Complete the real browser journey**

Use a supported local `agent-browser` version without changing project dependencies or lock files. Generate a disposable Member handoff without printing its secret, then verify:

```text
open Member Web
→ handoff fragment clears from the URL
→ send message 1 and receive Fake reply 1
→ send message 2 and receive Fake reply 2
→ refresh and recover both rounds
→ restart only the isolated Compose project
→ re-resolve the random loopback port
→ recover the same Cookie session and messages
→ send message 3 and receive Fake reply 3
→ no page error, console error, or framework overlay
```

Take and inspect a screenshot. Close the automation browser after verification.

- [ ] **Step 5: Create a fresh user handoff and keep the page available**

Generate a new one-time Member handoff for the same isolated runtime after the automation handoff has been consumed. Store it in a `0600` runtime file, do not print it in command output or logs, and return it to the user only as the final clickable local link. Confirm the current random port is listening on `127.0.0.1` and the page responds successfully.

- [ ] **Step 6: Record the retained experience port and prove formal/main preservation**

Resolve the current random loopback port after the browser restart. Add the same entry to `/home/youran/data/service-ports.md` and `/home/youran/data/service-ports.json`, identifying the Compose project, source commit, immutable image, loopback-only binding, retained runtime path, and `temporary user experience` status without credentials. Validate the JSON with `jq empty`. Compare the formal `127.0.0.1:8790` health SHA-256, container ID, image ID, and listener identity with the before snapshot. Confirm the main worktree still contains exactly its pre-existing four modified files and was not switched or rewritten. If the experience runtime is later stopped, remove the same entry from both ledgers.

- [ ] **Step 7: Independent final review, direct-main PR, CI, and merge**

Request an independent reviewer to inspect the exact final HEAD for Critical/Important issues, then publish a direct-main Draft PR. After all GitHub checks pass, mark Ready and merge with a merge commit; delete the remote task branch. Do not deploy the merged commit to formal `8790`.

## Completion Audit

Before claiming completion, verify every requirement against current evidence:

- [ ] Different active devices cannot share one Chat/Work idempotency result.
- [ ] Device mismatch and payload mismatch expose the same sanitized 409.
- [ ] Authorization and provenance run before message lookup and cached result return.
- [ ] Original-device replay returns the same Message/Provider Turn with one Provider call.
- [ ] Person-level event visibility remains shared; cursor/ACK remains device-scoped.
- [ ] Schema remains V9 and no migration exists in the diff.
- [ ] Final exact HEAD passes host, immutable build, isolated acceptance, attachments, and browser gates.
- [ ] A fresh clickable Member Web handoff is live on loopback for the user.
- [ ] Formal `8790`, Hermes architecture, and dirty main worktree remain unchanged; both port ledgers accurately record only the retained temporary experience port.
- [ ] Independent review and GitHub CI have no open Critical/Important or failed checks.
