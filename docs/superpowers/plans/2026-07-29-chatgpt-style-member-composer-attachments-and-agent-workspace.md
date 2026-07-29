# ChatGPT-Style Member Composer, Attachments, and Agent Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the member Chat/Work experience behave like a modern ChatGPT composer: durable immediate send, 200 MB resumable attachments, per-Agent workspaces, and unmistakable Agent identity without changing the official 8790 service.

**Architecture:** Keep SQLite as metadata authority, store attachment bytes in a dedicated streaming filesystem root, and associate only completed owner-authorized attachments with messages. The browser persists text, attachment trays, and outgoing envelopes per Agent+Thread in IndexedDB; enqueue is one durable transaction and Provider transmission continues in a tracked background promise tied to the immutable Agent+Thread. Only the current message's verified read-only attachment paths enter the Provider request.

**Tech Stack:** Node.js 22, TypeScript, Fastify 5, SQLite/better-sqlite3, Zod 4, browser ES modules, IndexedDB, Vitest, Codex CLI and Hermes CLI adapters.

## Global Constraints

- Work only in `/home/youran/Development/family-ai-platform` on `admin-yr`; never edit the `legacy` checkout or create another project folder/worktree.
- Use TDD for every task: add the smallest failing test, run it and record the expected failure, implement the minimum behavior, then rerun the focused test.
- Keep attachment constants exact: `MAX_FILE_BYTES = 209715200`, `MAX_ATTACHMENTS_PER_MESSAGE = 10`, `MAX_MESSAGE_ATTACHMENT_BYTES = 2147483648`, `CHUNK_BYTES = 8388608`, `DEFAULT_FAMILY_QUOTA_BYTES = 21474836480`, and `INCOMPLETE_UPLOAD_TTL_MS = 86400000`.
- Accept common images, PDF, Microsoft Office/OpenXML, UTF-8 text, Markdown, and source-code files. Reject executable/script binaries, arbitrary archives, extension/MIME/signature conflicts, symlinks, devices, sockets, and paths outside the configured attachment root.
- Do not buffer a file or combined message payload in memory. Chunk upload, assembly, SHA-256, Provider handoff, and download must stream.
- A message is valid when trimmed text is non-empty or at least one completed attachment is present. At most 10 attachments and 2 GiB combined attachment bytes are permitted per message.
- Family quota reservation and message association must be transactional. An attachment may be attached once, only by its owner, only to that owner's authorized Thread, and never by supplying a filesystem path from the client.
- Keep Agent state isolated by immutable `agentRef + threadRef`; Agent switching must not cancel, misroute, or visually leak another Agent's Chat, Work, drafts, attachment tray, outgoing messages, or history.
- Clear the visible composer only after the IndexedDB enqueue transaction commits. Do not wait for Codex/Hermes. Offline input stays a draft, and a Provider failure remains on the original message bubble with retry.
- Preserve the existing cookie/authentication bridge and direct Preview entry. Email/password authentication remains a later iteration.
- Deploy and test only on Preview `8791/9080/9443`. Before and after Preview work, prove official `127.0.0.1:8790` health hash, container/image identity, and listener identity are unchanged.
- Do not push `main`, deploy 8790, merge another branch, or delete anything without the user's later formal approval.
- Design authority: `docs/superpowers/specs/2026-07-29-chatgpt-style-member-composer-attachments-and-agent-workspace-design.md`.

---

### Task 1: Add attachment contracts and the V8 metadata schema

**Files:**

- Modify: `packages/contracts/src/chatWork.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/chatWork.test.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `apps/gateway/src/database.ts`
- Modify: `apps/gateway/test/database.test.ts`
- Create: `apps/gateway/test/attachmentMigration.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests that require these exported schemas and types:

```ts
attachmentRefSchema
attachmentPublicMetadataSchema
attachmentUploadCreateRequestSchema
attachmentUploadCreateResponseSchema
attachmentChunkResponseSchema
attachmentCompleteRequestSchema
attachmentCompleteResponseSchema
providerAttachmentSchema
```

Use this public shape:

```ts
{
  attachmentRef: "attachment:<uuid>",
  fileName: "report.pdf",
  mediaType: "application/pdf",
  sizeBytes: 1234,
  sha256: "<64 lowercase hex>",
  downloadUrl: "/api/v1/attachments/attachment%3A..."
}
```

Require:

```ts
threadMessageSchema.shape.attachments // max 10, emitted as [] when absent
sendThreadMessageRequestSchema.shape.attachmentRefs // unique, max 10, default []
providerInvocationRequestSchema.shape.attachments // max 10, default []
```

`threadMessageContentSchema.text` may be empty, but `threadMessageSchema` and `sendThreadMessageRequestSchema` must reject an empty/blank text with no attachments. Provider `textPayloadSchema` remains non-empty.

- [ ] **Step 2: Run the contract tests and prove RED**

Run:

```bash
npm run test -w @family-ai/contracts -- --run test/chatWork.test.ts test/contracts.test.ts
```

Expected failure: missing attachment exports and rejection/acceptance cases do not match the new contract.

- [ ] **Step 3: Implement the contracts**

Use strict Zod objects, lowercase SHA-256 validation, a filename length of `1..255`, media type length of `1..127`, positive size up to `209715200`, unique attachment refs, and cross-field `superRefine` checks. Export inferred TypeScript types from the same modules.

`providerAttachmentSchema` must be internal metadata, not a client path:

```ts
{
  attachmentRef,
  fileName,
  mediaType,
  sizeBytes,
  sha256,
  localPath: z.string().min(1).max(4096)
}
```

- [ ] **Step 4: Write failing V8 migration tests**

The migration test must open a V7 fixture containing text messages, migrate it to V8, and prove:

- all V7 rows and sequences survive;
- `thread_messages.content_text` accepts `""`;
- `attachments`, `attachment_chunks`, and `message_attachments` exist;
- unique/order/foreign-key checks reject duplicate associations and cross-message ordering;
- the database reopens at V8;
- `migrationLimit: 7` still opens a V7 database for explicit compatibility tests.

- [ ] **Step 5: Run the migration tests and prove RED**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/database.test.ts test/attachmentMigration.test.ts
```

Expected failure: migration limit accepts only 6/7 and attachment tables do not exist.

- [ ] **Step 6: Implement migration V8**

Change `GatewayDatabaseOpenOptions.migrationLimit` and `applyMigrations` to `6 | 7 | 8`, defaulting to 8. Implement `applyMigrationV8()` with `foreign_keys = OFF`, one SQLite transaction, and a final `foreign_key_check`.

Rebuild `thread_messages` as `thread_messages_v8` with the existing columns and actor checks, changing only:

```sql
content_text TEXT NOT NULL CHECK (length(content_text) <= 12000)
```

Copy all rows, drop the three old message indexes and old table, rename the V8 table, then recreate:

```sql
thread_messages_sequence_idx
thread_messages_client_id_idx
thread_messages_page_idx
```

Create:

```sql
attachments (
  attachment_ref TEXT PRIMARY KEY,
  family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
  owner_person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  declared_media_type TEXT NOT NULL,
  detected_media_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  sha256 TEXT,
  storage_key TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('uploading','ready','attached','expired','deleted')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  completed_at TEXT,
  attached_at TEXT
)
```

```sql
attachment_chunks (
  attachment_ref TEXT NOT NULL REFERENCES attachments(attachment_ref) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attachment_ref, chunk_index)
)
```

```sql
message_attachments (
  message_ref TEXT NOT NULL REFERENCES thread_messages(message_ref) ON DELETE CASCADE,
  attachment_ref TEXT NOT NULL UNIQUE REFERENCES attachments(attachment_ref),
  attachment_order INTEGER NOT NULL CHECK (attachment_order >= 0 AND attachment_order < 10),
  PRIMARY KEY (message_ref, attachment_ref),
  UNIQUE (message_ref, attachment_order)
)
```

Add indexes for family quota/state expiry, owner/state, and message order. Reinstall domain-event triggers through the existing startup path; do not duplicate their SQL in the migration.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/contracts -- --run test/chatWork.test.ts test/contracts.test.ts
npm run test -w @family-ai/gateway -- --run test/database.test.ts test/attachmentMigration.test.ts
npm run typecheck -w @family-ai/contracts
npm run typecheck -w @family-ai/gateway
git add packages/contracts/src/chatWork.ts packages/contracts/src/index.ts packages/contracts/test/chatWork.test.ts packages/contracts/test/contracts.test.ts apps/gateway/src/database.ts apps/gateway/test/database.test.ts apps/gateway/test/attachmentMigration.test.ts
git commit -m "feat: add attachment contracts and schema"
```

---

### Task 2: Build the secure streaming attachment repository and storage

**Files:**

- Create: `apps/gateway/src/attachmentPolicy.ts`
- Create: `apps/gateway/src/attachmentStorage.ts`
- Create: `apps/gateway/src/attachmentRepository.ts`
- Create: `apps/gateway/test/attachmentPolicy.test.ts`
- Create: `apps/gateway/test/attachmentStorage.test.ts`
- Create: `apps/gateway/test/attachmentRepository.test.ts`

- [ ] **Step 1: Write failing policy tests**

Cover PDF, PNG/JPEG/GIF/WebP, OOXML ZIP signatures for `.docx/.xlsx/.pptx`, legacy OLE Office, UTF-8 `.txt/.md` and representative source extensions. Reject `.zip/.7z/.rar`, PE/ELF/Mach-O, shell/batch/PowerShell executables, null bytes in text, extension/MIME/signature mismatch, names containing separators/control characters, and double extensions such as `report.pdf.exe`.

- [ ] **Step 2: Run and prove RED**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/attachmentPolicy.test.ts
```

Expected failure: the policy module does not exist.

- [ ] **Step 3: Implement the allowlist policy**

Expose:

```ts
normalizeAttachmentName(fileName: string): string
inspectAttachmentPrefix(input: {
  fileName: string;
  declaredMediaType: string;
  prefix: Buffer;
}): { detectedMediaType: string; kind: "binary" | "utf8-text" }
```

Treat the ZIP signature only as an Office container when both the extension and declared media type are the corresponding OOXML pair; never accept a generic ZIP. Validation is classification only and must never execute or render uploaded content.

- [ ] **Step 4: Write failing storage/repository tests**

Use a `mkdtemp` root and a real SQLite test database. Cover:

- root is absolute, private, non-symlink, outside Git, and created `0700`;
- chunk files are exclusive regular files opened without following symlinks;
- duplicate same-index/same-hash upload is idempotent;
- duplicate index/different-hash is `ATTACHMENT_CHUNK_CONFLICT`;
- all non-final chunks are exactly 8 MiB and the final chunk matches the declared remainder;
- assembly streams chunks in order to a temporary file, validates total bytes and SHA-256, fsyncs, then atomically renames;
- quota reservation uses `BEGIN IMMEDIATE` semantics and cannot overbook under concurrent initializations;
- abandoned uploading rows and chunks expire after 24 hours;
- deleting/cancelling releases reservations and removes only validated storage keys.

- [ ] **Step 5: Implement storage and repository**

`AttachmentStorage` owns canonical paths under:

```text
<root>/chunks/<attachment-ref-hash>/<chunk-index>.part
<root>/files/<first-two-sha>/<sha256>.blob
<root>/tmp/<attachment-ref-hash>.assembling
```

Never put a raw ref or filename into a path. Resolve, realpath, and prefix-check every parent; use `lstat`, `O_NOFOLLOW`, `O_EXCL`, and regular-file checks. Stream through `pipeline`, count bytes, update a hash, and cap input before disk growth exceeds the declared chunk.

`AttachmentRepository` exposes:

```ts
reserveUpload(input): AttachmentUploadRecord
recordChunk(input): "created" | "replayed"
completeUpload(input): AttachmentPublicMetadata
cancelUpload(input): void
expireIncompleteUploads(now): ExpiredAttachment[]
requireReadyForMessage(input): ProviderAttachment[]
attachToMessage(input): void
listForMessages(messageRefs): Map<string, AttachmentPublicMetadata[]>
requireDownload(input): AttachmentDownloadRecord
```

All ownership checks include both `familyRef` and `personRef`. A reservation counts `reserved_bytes` for `uploading`, `ready`, and `attached` rows; deduplicated physical storage does not weaken logical family quota.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/attachmentPolicy.test.ts test/attachmentStorage.test.ts test/attachmentRepository.test.ts
npm run typecheck -w @family-ai/gateway
git add apps/gateway/src/attachmentPolicy.ts apps/gateway/src/attachmentStorage.ts apps/gateway/src/attachmentRepository.ts apps/gateway/test/attachmentPolicy.test.ts apps/gateway/test/attachmentStorage.test.ts apps/gateway/test/attachmentRepository.test.ts
git commit -m "feat: add secure attachment storage"
```

---

### Task 3: Add authenticated resumable upload and download routes

**Files:**

- Create: `apps/gateway/src/attachmentRoutes.ts`
- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/test/config.test.ts`
- Create: `apps/gateway/test/attachmentRoutes.test.ts`
- Modify: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`

- [ ] **Step 1: Write failing route and configuration tests**

Require:

```text
POST   /api/v1/attachments/uploads
PUT    /api/v1/attachments/uploads/:attachmentRef/chunks/:chunkIndex
POST   /api/v1/attachments/uploads/:attachmentRef/complete
DELETE /api/v1/attachments/uploads/:attachmentRef
GET    /api/v1/attachments/:attachmentRef
```

Test correct personal-entry cookie authentication, CSRF header on mutating methods, family/person isolation, revoked/expired entry rejection, chunk hash/idempotency, range-free full download, safe `Content-Disposition`, `X-Content-Type-Options: nosniff`, and error envelopes for size/type/quota/expiry conflicts.

Configuration must require a protected absolute `FAMILY_AI_ATTACHMENT_ROOT`, accept `FAMILY_AI_ATTACHMENT_QUOTA_BYTES` with the 20 GiB default, and reject symlinks, non-directories, the repository root, `.git`, or a tracked source path. An in-worktree runtime path is allowed only under the repository's ignored `.runtime*` directories. Runtime startup passes explicit `attachmentRoot` and `attachmentQuotaBytes` values into `BuildGatewayAppOptions`; test helpers derive a private sibling of their temporary database unless a case supplies its own temporary root.

- [ ] **Step 2: Run and prove RED**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/config.test.ts test/attachmentRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
```

Expected failure: configuration and routes do not exist.

- [ ] **Step 3: Implement the streaming routes**

Register `application/octet-stream` without `parseAs`, pass Fastify's request stream directly to `AttachmentStorage`, and enforce declared chunk length plus a hard stream counter. Do not install or use a multipart buffer parser.

Initialization returns `201` with `attachmentRef`, exact `chunkBytes`, expected `chunkCount`, expiry, and any already received chunk indexes. Completion returns verified public metadata. Download calls `requireDownload` before opening the file and streams with `createReadStream`.

On app startup, expire old incomplete uploads once. Start a bounded cleanup interval, clear it on `onClose`, and close the database only after cleanup and event-stream resources stop.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/config.test.ts test/attachmentRoutes.test.ts test/chatWorkRoutesSecurity.test.ts
npm run typecheck -w @family-ai/gateway
git add apps/gateway/src/attachmentRoutes.ts apps/gateway/src/config.ts apps/gateway/src/app.ts apps/gateway/src/index.ts apps/gateway/test/config.test.ts apps/gateway/test/attachmentRoutes.test.ts apps/gateway/test/chatWorkRoutesSecurity.test.ts
git commit -m "feat: expose resumable attachment API"
```

---

### Task 4: Associate completed attachments atomically with Thread messages

**Files:**

- Modify: `apps/gateway/src/chatWorkDomain.ts`
- Modify: `apps/gateway/src/chatWorkMessageService.ts`
- Modify: `apps/gateway/src/chatWorkRoutes.ts`
- Modify: `apps/gateway/src/adminWorkspaceRoutes.ts`
- Modify: `apps/gateway/src/chatWorkContext.ts`
- Modify: `apps/gateway/src/domainEventCore.ts`
- Modify: `apps/gateway/src/deviceSync.ts`
- Modify: `apps/gateway/test/chatWorkDomain.test.ts`
- Modify: `apps/gateway/test/chatWorkRoutes.test.ts`
- Modify: `apps/gateway/test/chatWorkRoutesSecurity.test.ts`
- Modify: `apps/gateway/test/chatWorkContext.test.ts`
- Modify: `apps/gateway/test/syncKnownEvents.test.ts`

- [ ] **Step 1: Write failing domain and route tests**

Cover text-only compatibility, attachment-only messages, ordered attachment metadata in POST/list responses, 10-file and 2-GiB aggregate boundaries, duplicates, not-ready/expired/foreign-owner refs, and rollback: if message insertion fails no attachment changes to `attached`.

Require Admin Workspace sends to use the same association rules with its authenticated family/person context. Sync projections may contain only public metadata and download URLs, never `storage_key` or `localPath`.

- [ ] **Step 2: Run and prove RED**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/chatWorkDomain.test.ts test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts test/chatWorkContext.test.ts test/syncKnownEvents.test.ts
```

Expected failure: message inputs/responses are text-only.

- [ ] **Step 3: Implement the atomic message boundary**

Extend `SendChatWorkMessageInput` with `attachmentRefs`. In one database transaction:

1. resolve and authorize the Thread and immutable Agent;
2. lock/validate completed attachments by family/person;
3. enforce unique count and combined bytes;
4. append the person message;
5. insert ordered `message_attachments`;
6. move attachment state `ready -> attached`.

`mapThreadMessage` and paged queries bulk-load attachments for all message refs to avoid N+1 reads. Use public metadata only.

For Provider context rebuilds, render historical attachments as neutral text metadata such as name/type/size, but never include their local paths. The current message's local paths are supplied separately in Task 5.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/chatWorkDomain.test.ts test/chatWorkRoutes.test.ts test/chatWorkRoutesSecurity.test.ts test/chatWorkContext.test.ts test/syncKnownEvents.test.ts
npm run typecheck -w @family-ai/gateway
git add apps/gateway/src/chatWorkDomain.ts apps/gateway/src/chatWorkMessageService.ts apps/gateway/src/chatWorkRoutes.ts apps/gateway/src/adminWorkspaceRoutes.ts apps/gateway/src/chatWorkContext.ts apps/gateway/src/domainEventCore.ts apps/gateway/src/deviceSync.ts apps/gateway/test/chatWorkDomain.test.ts apps/gateway/test/chatWorkRoutes.test.ts apps/gateway/test/chatWorkRoutesSecurity.test.ts apps/gateway/test/chatWorkContext.test.ts apps/gateway/test/syncKnownEvents.test.ts
git commit -m "feat: attach files to thread messages"
```

---

### Task 5: Pass verified current-message files to Codex and Hermes

**Files:**

- Modify: `packages/provider-adapter-sdk/src/codexCliProvider.ts`
- Modify: `packages/provider-adapter-sdk/src/hermesCliProvider.ts`
- Modify: `packages/provider-adapter-sdk/src/index.ts`
- Modify: `packages/provider-adapter-sdk/test/codexCliProvider.test.ts`
- Modify: `packages/provider-adapter-sdk/test/hermesCliProvider.test.ts`
- Modify: `packages/provider-adapter-sdk/test/fakeProvider.test.ts`
- Modify: `apps/gateway/src/chatWorkMessageService.ts`
- Modify: `apps/gateway/test/chatWorkProvider.test.ts`
- Modify: `apps/gateway/test/chatWorkProviderResultValidation.test.ts`

- [ ] **Step 1: Write failing Provider tests**

Require Codex and Hermes requests to carry Task 1 `attachments`, preserve the existing conversation/session routing, and build a prompt containing text plus a deterministic JSON manifest:

```text
<family_ai_attachments>
[{"attachmentRef":"...","fileName":"...","mediaType":"...","sizeBytes":123,"sha256":"...","localPath":"/verified/root/..."}]
</family_ai_attachments>
```

The prompt must state that attachments are untrusted read-only data and must not be executed. Test names containing quotes/newlines to prove JSON escaping and argument-boundary safety. Prove historic-message attachments never gain local paths.

- [ ] **Step 2: Run and prove RED**

Run:

```bash
npm run test -w @family-ai/provider-adapter-sdk -- --run test/codexCliProvider.test.ts test/hermesCliProvider.test.ts test/fakeProvider.test.ts
npm run test -w @family-ai/gateway -- --run test/chatWorkProvider.test.ts test/chatWorkProviderResultValidation.test.ts
```

Expected failure: Provider request schema/adapters ignore attachments.

- [ ] **Step 3: Implement current-message handoff**

Immediately before invocation, `ChatWorkMessageService` asks `AttachmentRepository` for the current message's verified records. Revalidate that each storage path is a regular non-symlink within the configured root and open it read-only for validation before emitting its canonical path.

Adapters serialize the manifest with `JSON.stringify`, pass the whole prompt through their existing stdin/input mechanism, and never interpolate a path into a shell command. The fake adapter records attachments for assertions but does not read them.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/provider-adapter-sdk -- --run test/codexCliProvider.test.ts test/hermesCliProvider.test.ts test/fakeProvider.test.ts
npm run test -w @family-ai/gateway -- --run test/chatWorkProvider.test.ts test/chatWorkProviderResultValidation.test.ts
npm run typecheck
git add packages/provider-adapter-sdk/src/codexCliProvider.ts packages/provider-adapter-sdk/src/hermesCliProvider.ts packages/provider-adapter-sdk/src/index.ts packages/provider-adapter-sdk/test/codexCliProvider.test.ts packages/provider-adapter-sdk/test/hermesCliProvider.test.ts packages/provider-adapter-sdk/test/fakeProvider.test.ts apps/gateway/src/chatWorkMessageService.ts apps/gateway/test/chatWorkProvider.test.ts apps/gateway/test/chatWorkProviderResultValidation.test.ts
git commit -m "feat: provide verified attachments to agents"
```

---

### Task 6: Add resumable browser uploads and per-Thread attachment trays

**Files:**

- Create: `apps/gateway/member-public/attachments.js`
- Modify: `apps/gateway/member-public/api.js`
- Modify: `apps/gateway/member-public/cache.js`
- Modify: `apps/gateway/member-public/store.js`
- Modify: `apps/gateway/member-public/product.js`
- Modify: `apps/gateway/src/memberWeb.ts`
- Modify: `apps/gateway/test/memberApiStore.test.ts`
- Modify: `apps/gateway/test/memberCacheModel.test.ts`
- Create: `apps/gateway/test/memberAttachments.test.ts`
- Modify: `apps/gateway/test/memberWebModules.test.ts`

- [ ] **Step 1: Write failing browser model tests**

Upgrade IndexedDB to version 2 with an `attachmentDrafts` store keyed by `attachmentRef` and indexed by `threadRef`. A draft record includes immutable `agentRef`, `threadRef`, filename/type/size, progress, received chunks, server state, public metadata when ready, and an error/cancel state.

Test:

- file and total limits before network requests;
- max 10 per Thread tray;
- 8 MiB chunk slicing and SHA-256 header;
- resume queries/reuses received chunk indexes;
- reload restores each Agent+Thread tray;
- switching Agent shows only that Agent's tray;
- cancel removes server upload and cache record;
- completed items remain ready until enqueued;
- work and Chat trays are independent.

- [ ] **Step 2: Run and prove RED**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/memberApiStore.test.ts test/memberCacheModel.test.ts test/memberAttachments.test.ts test/memberWebModules.test.ts
```

Expected failure: no attachment store, API methods, or controller exists.

- [ ] **Step 3: Implement the API and controller**

Extend `rawApiRequest` so binary bodies are passed through without JSON conversion while retaining same-origin credentials, CSRF header, abort signals, request tracking, and strict error normalization.

Add:

```js
beginAttachmentUpload(metadata)
putAttachmentChunk(attachmentRef, chunkIndex, blob, sha256)
completeAttachmentUpload(attachmentRef, command)
cancelAttachmentUpload(attachmentRef)
```

`createAttachmentController` owns hashing, chunk sequence, progress, resume, cancellation, and store projection. Use browser `Blob.slice()` and `crypto.subtle.digest()` per chunk; never concatenate the full file. Register `/member/assets/attachments.js`.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/memberApiStore.test.ts test/memberCacheModel.test.ts test/memberAttachments.test.ts test/memberWebModules.test.ts
git add apps/gateway/member-public/attachments.js apps/gateway/member-public/api.js apps/gateway/member-public/cache.js apps/gateway/member-public/store.js apps/gateway/member-public/product.js apps/gateway/src/memberWeb.ts apps/gateway/test/memberApiStore.test.ts apps/gateway/test/memberCacheModel.test.ts apps/gateway/test/memberAttachments.test.ts apps/gateway/test/memberWebModules.test.ts
git commit -m "feat: add member resumable uploads"
```

---

### Task 7: Split durable enqueue from Provider transmission

**Files:**

- Modify: `apps/gateway/member-public/cache.js`
- Modify: `apps/gateway/member-public/thread.js`
- Modify: `apps/gateway/member-public/product.js`
- Modify: `apps/gateway/test/memberControllers.test.ts`
- Modify: `apps/gateway/test/memberThreadHistory.test.ts`
- Modify: `apps/gateway/test/memberProductWorkbenchLifecycle.test.ts`
- Modify: `apps/gateway/test/memberProductFlow.test.ts`

- [ ] **Step 1: Write the regression tests first**

Prove the original bug and required fix:

- `enqueue()` atomically writes outgoing text+ready attachment metadata, deletes the same Thread draft, and deletes those tray records;
- it returns `{status: "queued"}` immediately after that transaction, before a pending Provider promise resolves;
- a failed IndexedDB transaction leaves composer draft/tray intact and creates no optimistic message;
- Provider success reconciles the original outgoing item;
- Provider failure updates that same bubble to failed/retryable;
- send to zzh, switch to Codex before completion, and prove the zzh transmission completes in zzh's Thread without `AGENT_SELECTION_CHANGED`;
- stopping the workbench aborts/waits for tracked background transmissions and prevents late state writes;
- retry reuses the immutable client message ID, Agent, Thread, and attachment refs.

- [ ] **Step 2: Run and prove RED**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/memberControllers.test.ts test/memberThreadHistory.test.ts test/memberProductWorkbenchLifecycle.test.ts test/memberProductFlow.test.ts
```

Expected failure: `send()` awaits Provider completion and selection guards abort an in-flight send.

- [ ] **Step 3: Implement the queue boundary**

Add a cache helper that performs one transaction across `drafts`, `attachmentDrafts`, and `outgoing`. Refactor:

```js
threadController.enqueue(threadRef, text, attachments, language)
// -> { status: "queued", outgoing, transmission }
```

The transaction commits before the in-memory optimistic projection and before returning. `transmission` calls the existing server POST, then refreshes and reconciles by immutable Agent+Thread. It writes cache results even if another Agent is selected, but only projects them into the visible store when that Agent remains current.

`product.js` passes every `transmission` to `trackActionPromise` and returns `{status:"queued"}` to the renderer. Do not let an unhandled background rejection escape. Offline send persists the unchanged draft/tray and returns `{status:"draft"}`.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/memberControllers.test.ts test/memberThreadHistory.test.ts test/memberProductWorkbenchLifecycle.test.ts test/memberProductFlow.test.ts
git add apps/gateway/member-public/cache.js apps/gateway/member-public/thread.js apps/gateway/member-public/product.js apps/gateway/test/memberControllers.test.ts apps/gateway/test/memberThreadHistory.test.ts apps/gateway/test/memberProductWorkbenchLifecycle.test.ts apps/gateway/test/memberProductFlow.test.ts
git commit -m "fix: enqueue member messages before agent reply"
```

---

### Task 8: Build the ChatGPT-style composer and unmistakable Agent workspace

**Files:**

- Modify: `apps/gateway/member-public/index.html`
- Modify: `apps/gateway/member-public/member.css`
- Modify: `apps/gateway/member-public/render.js`
- Modify: `apps/gateway/member-public/product.js`
- Modify: `apps/gateway/test/helpers/memberBrowserHarness.ts`
- Modify: `apps/gateway/test/memberRenderLifecycle.test.ts`
- Modify: `apps/gateway/test/memberAgentSelector.test.ts`
- Modify: `apps/gateway/test/memberProductFlow.test.ts`
- Modify: `apps/gateway/test/memberWeb.test.ts`

- [ ] **Step 1: Write failing interaction tests**

For both Chat and Work:

- paperclip button opens a hidden multi-file input;
- paste and drag/drop add supported files;
- tray shows name, size, progress, status, remove/cancel, and accessible labels;
- the send button accepts text-only, file-only, or combined input only when uploads are ready;
- submit clears the textarea and ready tray on `{status:"queued"}`;
- draft/offline/queue failure keeps text and tray;
- Enter sends and Shift+Enter inserts a newline;
- outgoing bubble renders attachment chips and pending/failed/retry state;
- authoritative messages render safe download links;
- oversize/count/type/quota errors are visible next to the affected file.

Agent switching must immediately change the entire right workspace:

- large Agent name/avatar/status in the workspace header;
- Agent-specific Chat title, Work title, placeholder, history, drafts, attachment tray, and skeleton;
- `aria-live` announces the new Agent;
- green means idle, orange working, red problem;
- a selection generation prevents late zzh initialization from replacing the Codex view.

- [ ] **Step 2: Run and prove RED**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/memberRenderLifecycle.test.ts test/memberAgentSelector.test.ts test/memberProductFlow.test.ts test/memberWeb.test.ts
```

Expected failure: no file controls/tray and submit clears only after `succeeded`.

- [ ] **Step 3: Implement HTML, renderer, and responsive CSS**

Use native DOM creation and `textContent`; never insert attachment names or Agent output with `innerHTML`. Add a full-width workspace identity strip inside the right pane, an Agent-switch loading skeleton, attachment chips, progress bars, drop-target feedback, and mobile wrapping.

Change the submit rule to:

```js
if (result?.status === "queued") {
  textarea.value = "";
}
```

The state/cache transaction is the source of truth for clearing the tray and draft; renderer does not independently delete them. While uploads are incomplete, show status and keep send disabled. Preserve native keyboard and IME handling.

- [ ] **Step 4: Run focused tests and perform static review**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/memberRenderLifecycle.test.ts test/memberAgentSelector.test.ts test/memberProductFlow.test.ts test/memberWeb.test.ts
npm run test:scripts
```

Inspect desktop and mobile layouts for overflow, focus visibility, status-color text equivalents, and safe filenames.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/gateway/member-public/index.html apps/gateway/member-public/member.css apps/gateway/member-public/render.js apps/gateway/member-public/product.js apps/gateway/test/helpers/memberBrowserHarness.ts apps/gateway/test/memberRenderLifecycle.test.ts apps/gateway/test/memberAgentSelector.test.ts apps/gateway/test/memberProductFlow.test.ts apps/gateway/test/memberWeb.test.ts
git commit -m "feat: add ChatGPT-style member composer"
```

---

### Task 9: Wire Preview storage, verify end to end, and preserve official 8790

**Files:**

- Modify: `scripts/member-preview-up.sh`
- Modify: `scripts/member-preview-down.sh`
- Modify: `scripts/static-check.sh`
- Modify: `apps/gateway/test/memberPreviewScripts.test.ts`
- Modify: `README.md`
- Create: `docs/development/2026-07-29-member-attachments-and-agent-workspace.md`

- [ ] **Step 1: Capture the official-service baseline before any Preview restart**

Run:

```bash
curl --silent --show-error http://127.0.0.1:8790/health | sha256sum
docker ps --no-trunc --filter publish=8790 --format '{{.ID}} {{.Image}} {{.Status}} {{.Ports}}'
ss -ltnp | grep -E '127\.0\.0\.1:8790[[:space:]]'
```

Save the exact three outputs in the acceptance note. If any is missing or differs from the previously accepted official identity, stop; do not restart 8790.

- [ ] **Step 2: Write failing Preview-script tests**

Require `member-preview-up.sh` to configure:

```bash
FAMILY_AI_ATTACHMENT_ROOT="$ROOT_DIR/.runtime-preview/attachments"
FAMILY_AI_ATTACHMENT_QUOTA_BYTES=21474836480
```

Require private `0700` storage, manifest ownership, no symlink, no Git tracking, and Preview-down cleanup of only expired/incomplete upload temporary files. Completed Preview attachments persist across ordinary Preview restarts.

- [ ] **Step 3: Run and prove RED**

Run:

```bash
npm run test -w @family-ai/gateway -- --run test/memberPreviewScripts.test.ts
bash scripts/static-check.sh
```

Expected failure: Preview does not provide an attachment root/configuration.

- [ ] **Step 4: Implement Preview wiring and documentation**

Keep 8791 loopback-only and keep the existing isolated 9080/9443 LAN proxy. Document:

- 200 MB/file, 10 files/message, 2 GiB/message, 20 GiB/family;
- resumable upload and 24-hour incomplete expiry;
- supported types and the no-execution rule;
- per-Agent Chat/Work/draft/file isolation;
- direct Preview entry remains unchanged;
- email/password remains a later iteration.

- [ ] **Step 5: Run the complete automated gate**

Run:

```bash
npm run check
git status --short
git diff --check
```

Expected: all contract, SDK, Gateway, script, typecheck, and build checks pass; only intentional committed changes remain.

- [ ] **Step 6: Start only Preview and run API acceptance**

Run:

```bash
bash scripts/member-preview-up.sh
bash scripts/member-preview-lan-up.sh
curl --fail --cacert .runtime-preview/tls/ca.crt https://192.168.110.84:9443/health
```

Using a normal member entry, verify:

1. a 200 MB boundary fixture uploads in 8 MiB chunks without Gateway RSS growing by the file size;
2. an interrupted upload resumes from received indexes;
3. 200 MB + 1 byte, 11 files, unsupported archive/executable, and quota overflow fail cleanly;
4. a file-only message and a text+file message reach the selected Agent;
5. download succeeds for the owner and fails for another member;
6. attachment metadata survives Preview restart.

- [ ] **Step 7: Run real browser acceptance on desktop and narrow mobile viewport**

Verify the user-visible journey:

1. open the direct member entry on `https://192.168.110.84:9443/member/`;
2. choose zzh and see the entire right workspace identify zzh;
3. attach a PDF and image, watch progress, send with Enter, and see text/tray clear as soon as queued;
4. immediately switch to Codex while zzh works; Codex remains visible and usable;
5. return to zzh and see the original message, attachments, and eventual reply in the same Thread;
6. force a Provider failure and retry from the original bubble;
7. repeat in Work and verify its tray/history are separate;
8. reload another browser/device session and verify message attachments/history persist;
9. verify Shift+Enter newline and keyboard/focus accessibility.

Capture screenshots of Agent identity, uploading tray, queued bubble, Agent switch, failure/retry, and successful attachment reply.

- [ ] **Step 8: Prove official 8790 is unchanged**

Repeat the exact baseline commands from Step 1 and byte-compare all outputs. Also run:

```bash
ss -ltnp | grep -E ':(8791|9080|9443)[[:space:]]'
```

Expected: official health hash, container/image identity, and listener are identical; only approved Preview processes own 8791/9080/9443.

- [ ] **Step 9: Commit the Preview integration and stop for product approval**

Run:

```bash
git add scripts/member-preview-up.sh scripts/member-preview-down.sh scripts/static-check.sh apps/gateway/test/memberPreviewScripts.test.ts README.md docs/development/2026-07-29-member-attachments-and-agent-workspace.md
git commit -m "docs: verify member attachment preview"
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Report the Preview URL, direct member entrance, exact test totals, screenshots, commit range, 8790 before/after evidence, and the main product experiences to validate. Stop for explicit approval before pushing `main` or touching the official service.

---

## Plan Self-Review Checklist

- [ ] Every approved requirement in the design document maps to a task and an executable acceptance check.
- [ ] Every path and command is concrete, and every authentication boundary is specified.
- [ ] Contract, database, repository, route, Provider, IndexedDB, controller, renderer, Preview, and browser layers use consistent names and limits.
- [ ] Attachment-only messages work without loosening Provider text payload safety.
- [ ] File bytes stream and never enter Git, SQLite BLOB columns, JSON responses, domain events, or browser localStorage.
- [ ] Agent switching cannot misroute in-flight sends or leak another Agent's visible state.
- [ ] The composer clears only after durable local enqueue, never after optimistic memory-only state and never after waiting for Provider completion.
- [ ] All formal deployment/push/delete actions remain outside this plan's authorization boundary.
