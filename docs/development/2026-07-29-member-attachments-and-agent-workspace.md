# Member Attachments and Agent Workspace

Date: 2026-07-29  
Target: `/home/youran/Development/family-ai-platform` on `admin-yr`  
Preview only: `127.0.0.1:8791`, `0.0.0.0:9080/9443`

## Product result

Member Chat and Work now use a ChatGPT-style composer:

- `Enter` sends, `Shift+Enter` inserts a newline, and IME composition does not
  submit;
- the message appears and the composer clears immediately after the outgoing
  envelope is durably queued in IndexedDB;
- Provider failure stays on the original message bubble with exact retry
  material;
- file picker, paperclip, paste, and drag-and-drop share one resumable upload
  path;
- file-only and text-plus-file messages are supported;
- selecting another Agent immediately replaces the entire right workspace with
  that Agent's identity and independent state.

Each immutable `agentRef + threadRef` owns its own Chat, Work, draft, attachment
tray, outgoing queue, history, and Provider session. A delayed zzh response
cannot overwrite or misroute the selected Codex workspace, and vice versa.

## Attachment boundary

Enforced limits:

| Boundary | Value |
|---|---:|
| One file | 200 MB (`209715200` bytes) |
| Files per message | 10 |
| Attachments per message | 2 GiB (`2147483648` bytes) |
| Family quota | 20 GiB (`21474836480` bytes) |
| Upload chunk | 8 MiB (`8388608` bytes) |
| Incomplete upload expiry | 24 hours |

Accepted data includes PNG, JPEG, GIF, WebP, PDF, DOC/DOCX, XLS/XLSX, CSV,
PPT/PPTX, UTF-8 text, Markdown, and allowlisted source/configuration formats.
Archives, executable binaries, unknown binary formats, symlinks, special files,
and extension/MIME/signature mismatches are rejected.

The Gateway streams upload chunks and final assembly. It does not buffer a
whole 200 MB file, store file bytes in SQLite, execute uploaded content, or
trust a client-supplied filesystem path. Only completed, owner-authorized,
message-bound attachments are provided to the selected Agent as verified
read-only regular files beneath the configured attachment root.

## Preview storage and lifecycle

Preview configures:

```text
FAMILY_AI_ATTACHMENT_ROOT=.runtime-preview/attachments
FAMILY_AI_ATTACHMENT_QUOTA_BYTES=21474836480
```

The actual root is an absolute path in the protected Preview runtime. Runtime
and attachment directories are `0700`; protected files are `0600`; symlinks
and non-regular entries fail closed. Final attachments persist across ordinary
Preview restarts and Preview shutdown. Gateway startup expires database-owned
incomplete uploads and removes their validated chunk keys. Preview shutdown
only removes stale `tmp/*.assembling` regular files older than 24 hours; it
does not remove completed files or active upload chunks.

`.runtime-preview/` is excluded from both Git and Docker build context, and the
static gate rejects tracked Preview runtime content.

Direct entry remains:

```text
Admin:  https://192.168.110.84:9443/admin/
Member: https://192.168.110.84:9443/member/
```

This version retains the development direct Admin entry and normal member
pairing flow. Formal email/password authentication remains a later iteration.

## TDD and automated evidence

Preview lifecycle RED:

```text
Test Files  1 failed | 82 passed (83)
Tests       4 failed | 792 passed (796)
```

The four failures proved the missing private attachment-tree permissions,
stale assembly cleanup, and symlink rejection. After implementation, the
focused lifecycle result was:

```text
Test Files  1 passed (1)
Tests       27 passed (27)
```

Final repository, API, browser, restart, and official-service evidence is
recorded below after the Preview acceptance run.

## Final acceptance evidence

### Automated gate

The final component gates passed:

```text
Contracts:            6 files / 75 tests passed
Provider Adapter SDK: 5 files / 39 tests passed
Gateway:             83 files / 798 tests passed
Static scripts:       passed
TypeScript:           passed
Production build:     passed
git diff --check:     passed
```

The first all-in-one Gateway run hit three existing 5-second timeouts while
the shared Linux host had load averages `7.87 / 14.68 / 14.56`. There were no
assertion failures. A complete single-worker rerun passed all 798 tests, and
the static, type, and build gates then passed separately.

### Real browser flow

The existing ZZH member entry was exercised in Chrome against the real
Preview Gateway:

- selecting `zzh` and `Codex` replaced the complete right workspace identity
  and preserved independent Chat, Work, draft, attachment, queue, and history
  state;
- image paste produced a ready attachment card with the red remove control;
- `Shift+Enter` produced a newline; `Enter` durably queued the message, cleared
  the textarea and attachment tray, and immediately rendered the outgoing
  bubble;
- the user switched to Codex while the zzh turn was in flight, then returned
  to the unchanged zzh message;
- zzh read the Chat attachment and replied `ATTACHMENT-ZZH-OK`;
- the same content-addressed JPEG was then uploaded to a zzh Work, sent, and
  answered `WORK-ATTACHMENT-DUPLICATE-OK`;
- switching back to Chat showed that its history was unchanged;
- a `390 x 844` viewport retained the Agent selector, selected-Agent identity,
  composer, attachment control, and Chat/Work/New bottom navigation;
- refreshing after Preview restart retained the authenticated member entry,
  attachment cards, Chat history, and Work history.

Chrome file-chooser automation could not select the PDF fixture because the
ChatGPT Chrome extension did not have **Allow access to file URLs** enabled.
The user was given the exact permission step. Clipboard image paste, Gateway
PDF handling, and file-picker behavior remain covered by real API and
automated browser-module tests.

### Real Preview API boundaries

An isolated acceptance client created temporary normal Web Device entries and
revoked both of them before exit. It did not call Hermes. Results:

| Check | Result |
|---|---|
| Exact 200 MiB file | `200`, 25 x 8 MiB chunks |
| 200 MiB + 1 byte | `400 REQUEST_INVALID` |
| Saved chunk replay | `200`, `replayed: true` |
| Gateway RSS during 200 MiB upload | `100265984` baseline, `136630272` peak, `36364288` delta |
| ZIP and ELF | `400 ATTACHMENT_TYPE_FORBIDDEN` |
| Owner download | `200`, byte-identical |
| Other member download | hidden as `404` |
| 11 attachments | `400 REQUEST_INVALID`, before Provider invocation |
| 20 GiB family quota | 102 x 200 MiB reservations accepted, next rejected as `409 ATTACHMENT_QUOTA_EXCEEDED` |
| Restart persistence | `200`, byte-identical after Gateway restart |

With the 10-file and 200 MiB/file limits, the reachable per-message maximum is
`2097152000` bytes, already below the independent 2 GiB
(`2147483648`) guard.

### Migration, storage, and service isolation

The real Preview database migrated from Gateway schema V8 to V9 with all three
existing attachment rows preserved. V9 permits multiple metadata rows to
share one content-addressed blob. Cancelling one duplicate no longer deletes
bytes still referenced by another ready or attached record. After the final
cleanup:

```text
schema version:       9
attached rows:        2
attached bytes:       117924
temporary audit rows: deleted with zero reserved bytes
active audit devices: 0
content blobs:        1 shared blob
```

Preview health passed on `127.0.0.1:8791` and the isolated LAN TLS endpoint
`192.168.110.84:9443`. The official `127.0.0.1:8790` remained unchanged:

```text
health SHA256:
169e9de22c2ac0692d38b07ecfd8800519e99140c49bb935cb3cadb47f252f1b

container:
b4c2f7876e6d80a2731a7782e3a5cb88a32478e43234723958b7929ce7451fb0

image:
sha256:00d6a37fd5ec8e35e85eeb0e70eb5d856647e1452afff01f9ba98b94d6ae7ce7

state: running / healthy
listener: 127.0.0.1:8790
```
