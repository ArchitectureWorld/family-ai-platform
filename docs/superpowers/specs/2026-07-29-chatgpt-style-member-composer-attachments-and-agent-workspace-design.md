# ChatGPT-Style Member Composer, Attachments, and Agent Workspace Design

**Date:** 2026-07-29
**Repository:** `/home/youran/Development/family-ai-platform`
**Target surface:** Member Web Chat and Work
**Approved limits:** 200 MB per file, 10 files per message, 20 GB attachment quota per family

## 1. Goal

Make the member experience behave like a modern ChatGPT conversation:

1. A submitted message appears optimistically and the text editor clears immediately.
2. Members can attach common images, documents, spreadsheets, presentations, text, Markdown, and source-code files.
3. Each mounted Agent owns an independent Chat and Work context.
4. Selecting an Agent produces an immediate, unmistakable change in the right conversation workspace.
5. Attachments remain visible and downloadable from the same conversation on every authorized member device.

## 2. Current Faults

### 2.1 Composer retains submitted text

`member-public/render.js` currently clears the textarea only after
`actions.send()` returns `{ status: "succeeded" }`. The thread controller
optimistically adds the outgoing message before the Provider finishes, so the
message can already be visible while the old text remains in the composer.

The correct boundary is acceptance into the local durable outgoing queue, not
completion of the Provider turn.

### 2.2 Agent switching is visually weak

The current state model already stores a separate Agent selection and projects
separate Chat and Work state, but the right workspace communicates the change
only through compact title and status text. Loading and empty states do not
strongly identify the target Agent, so the user can select a different Agent
without perceiving a corresponding conversation change.

### 2.3 Messages are text-only

The current public contracts, browser cache, database records, routes, thread
controller, and Provider invocation accept only text. Adding a file input
without an authenticated upload lifecycle and durable message association
would create an unsafe UI-only attachment feature.

## 3. Product Interaction

### 3.1 Agent-specific workspace

- Every mounted Agent has an independent Home Chat, Work list, selected Work,
  message history, drafts, outgoing queue, and attachment tray.
- Selecting an Agent updates the selected card and the right workspace
  immediately, before network requests complete.
- The right header prominently shows the Agent avatar, display name, public
  status, and the label `独立会话`.
- While the target Agent state loads, the previous Agent transcript is removed
  and replaced by a skeleton headed with the target Agent name.
- An empty Chat says `开始和 <Agent> 对话`.
- An Agent-load failure leaves the target Agent identity visible and presents a
  bounded retry action. It never restores another Agent's transcript beneath
  the selected Agent name.
- Agent switches are generation-guarded. A slow earlier switch cannot overwrite
  a later selection.

### 3.2 Composer

- The composer remains fixed below the active Chat or Work transcript.
- The textarea grows automatically up to the existing bounded height.
- `Enter` submits, `Shift+Enter` inserts a newline, and IME composition Enter
  does not submit.
- A paperclip button, file picker, drag-and-drop, and clipboard paste add
  attachments.
- The attachment tray shows file name, type, human-readable size, upload
  progress, and remove/cancel controls.
- A message may contain text, attachments, or both.
- Send is enabled only when there is non-blank text or at least one ready
  attachment, and no attachment is still uploading or failed.
- When the message is accepted into the durable outgoing queue, its text and
  attachment cards appear immediately in the transcript. The textarea and
  attachment tray clear immediately and focus returns to the textarea.
- Provider completion is not required to clear the composer.
- A failed outgoing message retains its text and attachment references in the
  message bubble and exposes `重试`. It does not overwrite a newer draft.
- If the device is offline, the text and ready attachment references remain as
  the Agent-specific draft and the UI explicitly reports that the message was
  not submitted.

### 3.3 Supported files

The initial allowlist is:

- Images: PNG, JPEG, WebP, and GIF.
- Documents: PDF, DOC, and DOCX.
- Spreadsheets: CSV, XLS, and XLSX.
- Presentations: PPT and PPTX.
- Text: TXT and Markdown.
- Common source code and configuration files that are valid text, including
  JavaScript, TypeScript, JSX, TSX, Python, Java, C, C++, headers, Go, Rust,
  Ruby, PHP, shell source, SQL, HTML, CSS, JSON, YAML, TOML, and XML.

SVG, archives, disk images, native executables, installers, shared libraries,
and unknown binary formats are rejected. Source files are treated only as data
and are never executed.

The enforced limits are:

- Maximum original file size: 200 MB.
- Maximum attachment count per message: 10.
- Maximum attachment bytes per message: 2 GB.
- Maximum attachment storage per family: 20 GB.
- Default upload chunk size: 8 MB.
- Incomplete upload expiry: 24 hours.

## 4. Architecture

### 4.1 Storage boundary

Attachment bytes live outside the Git repository and outside SQLite under a
configured attachment root. Preview uses a protected directory inside
`.runtime-preview`; formal deployments receive an explicit data-volume path.

SQLite stores only attachment identity and lifecycle metadata:

- Random attachment and upload references.
- Family, Person, and owning Thread.
- Original display name and normalized safe name.
- Declared and detected media type.
- Expected and actual size.
- SHA-256 digest.
- Opaque storage key.
- Upload state and timestamps.

The storage key is generated by the server and never contains the user-supplied
file name. Final files are regular files beneath the canonical attachment root,
are not symlinks, and are created with mode `0600`.

### 4.2 Database model

Add an attachment migration with these logical records:

1. `attachment_uploads`: resumable upload state, owner, expected size, received
   chunks, expiry, and terminal status.
2. `attachments`: finalized immutable metadata and opaque storage key.
3. `message_attachments`: ordered association from a durable message to an
   attachment.

An attachment can be finalized only once and attached to at most one logical
member message. A message association requires the same family, Person, Agent
Thread, and active personal authorization as the message.

The message transaction validates all attachment references and records the
message plus `message_attachments` atomically. No Provider call starts until
that transaction commits.

### 4.3 Resumable upload API

All unsafe requests use the existing same-origin member write protection and
the authenticated personal Entry Session.

1. `POST /api/v1/attachments/uploads`
   - Accepts protocol version, original name, declared media type, and exact
     size.
   - Validates the allowlist, 200 MB boundary, active Agent Thread, family
     quota reservation, and the member's authorization.
   - Returns the upload reference, 8 MB chunk size, received chunk indexes, and
     24-hour expiry.
2. `PUT /api/v1/attachments/uploads/:uploadRef/chunks/:index`
   - Accepts one raw binary chunk with an exact content length and offset.
   - Is idempotent for an identical already stored chunk and rejects conflicting
     replacement bytes.
3. `GET /api/v1/attachments/uploads/:uploadRef`
   - Returns only the authenticated owner's safe progress projection so another
     device can resume an upload when it possesses the draft reference.
4. `POST /api/v1/attachments/uploads/:uploadRef/complete`
   - Streams chunks in order, verifies total size, computes SHA-256, detects the
     file type, atomically renames the final file, and returns immutable
     attachment metadata.
5. `DELETE /api/v1/attachments/uploads/:uploadRef`
   - Cancels the upload and removes its temporary chunks.
6. `GET /api/v1/attachments/:attachmentRef/download`
   - Requires current ownership through an attached message or the owner's
     active draft.
   - Uses `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
     and a safe display filename.

Upload creation reserves quota. Cancellation, expiry, or failed finalization
releases the reservation. Attached files count against the 20 GB family quota.

### 4.4 Message contract

The existing text content remains the visible message text. A message gains an
ordered `attachments` projection containing only safe public metadata and an
authorized download reference.

Submission accepts `attachmentRefs` in addition to text. Validation requires
at least one of:

- Non-blank text.
- One to ten finalized attachment references.

Attachment-only messages persist an empty visible text value and a non-empty
attachment list. The server creates a bounded internal Provider instruction
for attachment-only turns; this internal instruction is not displayed as user
text.

The browser's outgoing record stores the same attachment metadata so optimistic
rendering, restart recovery, and exact retry do not depend on the upload tray.

The browser queue boundary is explicit:

1. `threadController.enqueue()` atomically writes the outgoing message and its
   immutable attachment references to IndexedDB, clears the Thread draft and
   attachment tray, updates optimistic state, and returns `{ status: "queued" }`.
2. The renderer clears the visible composer only after that durable queue
   transaction succeeds.
3. A tracked background transmission performs the existing server message and
   Provider turn request. The submit handler does not await Provider completion.
4. Background success replaces the optimistic projection with durable server
   history. Background failure changes the original outgoing bubble to failed
   and retains exact retry material.

Background transmission is bound to the outgoing message's immutable Agent and
Thread, not to the currently selected Agent. Switching from zzh to Codex while
zzh is responding does not cancel or misclassify the zzh turn. Completion
updates zzh's cache and is rendered immediately only if zzh is still selected;
otherwise it appears when the member switches back.

### 4.5 Provider integration

The Provider SDK invocation gains an immutable array of attachment descriptors:

- Attachment reference.
- Original safe display name.
- Detected media type.
- Exact size.
- Verified absolute local path.

Before invoking Codex or Hermes, the Gateway verifies that each path resolves to
a regular `0600` file beneath the configured attachment root. The adapters
receive only attachments bound to the current message.

The prompt contains a machine-generated, safely encoded attachment manifest
with the read-only paths. User-controlled names are encoded as data, not
instructions. Codex and Hermes may inspect the files with their existing tools,
but the Gateway never executes an attachment.

If an Agent cannot parse a supported file, it must state that limitation in its
reply. The UI and Gateway do not claim that every Provider model has native
vision or Office parsing capability.

## 5. Security and Failure Handling

- Upload bodies are streamed; neither Gateway nor browser code builds a full
  200 MB in-memory copy.
- File count, declared size, actual size, chunk size, family quota, extension,
  declared MIME, detected type, canonical path, ownership, Agent, and Thread are
  all independently validated.
- Cross-family, cross-Person, cross-Agent, cross-Thread, expired-session, and
  revoked-device access returns the existing bounded public error envelope.
- File names are never used as storage paths and are stripped of control
  characters for display/download.
- Active web content is never served inline.
- Chunk conflicts, missing chunks, digest mismatches, quota exhaustion, and
  type mismatches fail finalization without creating an attachment.
- A scheduled cleanup removes expired temporary uploads and orphaned finalized
  attachments that were never associated with a message.
- Retry reuses the original durable message, idempotency identity, and immutable
  attachments. It never creates duplicate message-attachment rows or reruns an
  upload.

## 6. Browser State and Multi-Device Behavior

- Text drafts remain keyed by Thread as they are today.
- Attachment draft records are also keyed by Agent Thread in IndexedDB and
  contain only upload/attachment references plus safe metadata, never file
  bytes.
- Switching Agents restores the selected Agent's text draft and attachment
  tray.
- A finalized attachment draft can be resumed on another authorized device
  only through its server-side reference. A browser-local file selection that
  has not uploaded any bytes remains local to that browser.
- Sent message attachments are part of durable thread history and therefore
  appear on all authorized devices.

## 7. Testing and Acceptance

### 7.1 Automated gates

- Contract tests for text-only, text-plus-attachments, and attachment-only
  messages.
- Migration and repository tests for atomic associations and restart recovery.
- Boundary tests for 200 MB accepted, 200 MB plus one byte rejected, ten files
  accepted, eleven rejected, and 20 GB family quota enforcement.
- Streaming tests prove bounded memory behavior without allocating a 200 MB
  buffer.
- Resumable upload tests cover duplicate chunks, conflicting chunks, missing
  chunks, cancellation, expiry, completion, and cleanup.
- Security tests cover traversal names, symlinks, MIME/extension disagreement,
  active content, executable formats, and every ownership boundary.
- Provider tests prove that only current-message paths are passed to the
  selected Agent and that no attachment is executed.
- Renderer tests prove immediate composer clearing at queue acceptance,
  preservation on offline draft, failure retry without draft overwrite,
  attachment tray behavior, keyboard behavior, and visible Agent-specific
  loading/empty/error/history states.
- Lifecycle tests prove a slow earlier Agent switch cannot overwrite a later
  one, drafts never cross Agent boundaries, and an in-flight zzh turn completes
  correctly after the member switches to Codex.

### 7.2 Real product acceptance

On preview ports only:

1. Select zzh and verify the right workspace immediately names zzh.
2. Send a text message and confirm the message appears and the editor clears
   before zzh replies.
3. Attach representative image, PDF, DOCX, XLSX, PPTX, Markdown, and code files;
   verify progress, removal, send, reply, history, and authorized download.
4. Interrupt and resume a large upload without restarting from zero.
5. Switch to Codex while zzh has an unsent draft and attachment; verify Codex
   shows its own conversation and empty/own draft, then switch back and recover
   the zzh draft.
6. Verify Codex receives only Codex attachments and zzh receives only zzh
   attachments.
7. Verify Enter, Shift+Enter, IME Enter, drag-and-drop, paste, retry, mobile
   layout, and desktop layout.
8. Verify no product console errors and no visible secret material.

Formal port `8790` remains unchanged during design, implementation, and preview
acceptance. A formal deployment requires separate user approval after all
automated and browser gates pass.

## 8. Non-Goals

- No arbitrary binary or archive upload.
- No attachment execution.
- No OCR service, document conversion service, vector database, semantic
  indexing, or background knowledge-base ingestion in this iteration.
- No claim that every configured Provider can interpret every allowed format.
- No production `8790` deployment without a later explicit approval.
