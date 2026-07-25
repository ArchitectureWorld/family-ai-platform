# Member Web Product Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the real `/member/` entry into a usable Chat / Work product workbench with IndexedDB persistence, explicit Device Sync, SSE recovery, optimistic sending and Chat-to-Work conversion.

**Architecture:** Keep the same-origin Gateway-hosted ES Module architecture introduced by PR #24. Split the browser application into small modules, persist only non-secret product projections in IndexedDB, apply events before cumulative ACK, and use existing Chat / Work / Sync APIs without adding acceptance-only routes or business states.

**Tech Stack:** Browser ES Modules, IndexedDB, EventSource, BroadcastChannel, TypeScript/Vitest integration tests, Fastify 5, SQLite, GitHub Actions.

## Global Constraints

- Work only on `feat/member-web-product-workbench`, based on `main` commit `d7e4530b2bce9d99fa44696d5754b7112a2a42f5`.
- Do not modify `clients/ios/**`, `.github/workflows/ios-ci.yml`, `packages/contracts/src/mobileEntry.ts`, `packages/contracts/fixtures/mobile-entry/**`, `apps/gateway/src/mobilePairing.ts`, or `apps/gateway/src/mobileRoutes.ts`.
- Do not create an acceptance console, debug panel, acceptance-only endpoint, acceptance-only data model, or product button labelled as acceptance.
- Browser code must never read or persist Device Credential, Entry Session Token, Authorization Header, Provider External Session, or pairing code after claim.
- Existing HttpOnly Cookie, SameSite, Header precedence and unsafe-request protection remain unchanged.
- Gateway remains the source of truth. IndexedDB is a disposable local projection.
- Device Sync ACK occurs only after the IndexedDB transaction for the corresponding events succeeds.
- Offline input is saved as a draft and must not be displayed as sent.
- Work status is display-only because Gateway has no status command in this phase.
- Every behavior task follows RED → observed CI failure → minimal GREEN → observed CI success.

---

## File Map

### New browser modules

- `apps/gateway/member-public/api.js` — same-origin API client and PublicError normalization.
- `apps/gateway/member-public/store.js` — in-memory product state and subscription boundary.
- `apps/gateway/member-public/cache.js` — IndexedDB schema, transactions and queries.
- `apps/gateway/member-public/thread.js` — message merge, pagination, outgoing and retry logic shared by Chat and Work.
- `apps/gateway/member-public/sync.js` — catch-up, EventSource, ACK, reconnect and BroadcastChannel.
- `apps/gateway/member-public/chat.js` — Home Chat controller and Chat-to-Work selection.
- `apps/gateway/member-public/work.js` — Work list, creation, detail, progress and Work thread controller.
- `apps/gateway/member-public/render.js` — DOM rendering and accessible interaction helpers.
- `apps/gateway/member-public/product.js` — workbench orchestration and lifecycle.

### Modified browser files

- `apps/gateway/member-public/entry.js` — entry/session lifecycle only; start and stop ProductWorkbench.
- `apps/gateway/member-public/index.html` — full Chat / Work product structure.
- `apps/gateway/member-public/member.css` — responsive desktop/mobile product layout.

### Gateway registration

- `apps/gateway/src/memberWeb.ts` — serve all explicit product ES modules under `/member/assets/`.

### Tests and evidence

- `apps/gateway/test/memberWebModules.test.ts` — JavaScript syntax, security and module-boundary checks.
- `apps/gateway/test/memberProductFlow.test.ts` — real pairing, Chat, Assistant, Work, conversion and Sync API integration.
- `apps/gateway/test/memberSyncModel.test.ts` — pure browser sync/event planning and ACK-order tests.
- `apps/gateway/test/memberThreadModel.test.ts` — merge, optimistic reconciliation and retry invariants.
- `apps/gateway/test/memberWeb.test.ts` — update static product route and UI assertions.
- `docs/superpowers/evidence/2026-07-25-member-web-product-workbench.md` — final RED/GREEN and scope evidence.
- `docs/development/2026-07-25-member-web-product-workbench.md` — product-stage development record.
- `README.md` — current stage and one-click product workbench instructions.

---

### Task 1: Freeze pure thread and sync models

**Files:**
- Create: `apps/gateway/member-public/thread.js`
- Create: `apps/gateway/member-public/sync.js`
- Create: `apps/gateway/test/memberThreadModel.test.ts`
- Create: `apps/gateway/test/memberSyncModel.test.ts`

**Interfaces:**
- Produces `mergeThreadMessages(existing, incoming)`.
- Produces `createOutgoingMessage(input)` and `reconcileOutgoing(outgoing, messages)`.
- Produces `retryPayload(outgoing)` preserving `clientMessageId`, `occurredAt` and content.
- Produces `eventRefreshPlan(event, activeThreadRef)`.
- Produces `nextReconnectDelay(attempt)` capped at 30 seconds.
- Produces `highestContiguousSequence(current, events)`.

- [ ] Write failing tests proving message merge is deduplicated by `messageRef`, sorted by `threadSequence`, and preserves different optimistic messages.
- [ ] Write failing tests proving retry payload preserves the original logical message identity.
- [ ] Write failing tests for all seven known Sync event refresh plans plus an opaque event.
- [ ] Write failing tests proving reconnect delay is bounded and sequence calculation rejects gaps and regressions.
- [ ] Run Repository CI and record RED because the modules do not exist.
- [ ] Implement the pure functions without browser globals.
- [ ] Run Repository CI and record GREEN.

### Task 2: Implement IndexedDB product projection

**Files:**
- Create: `apps/gateway/member-public/cache.js`
- Create: `apps/gateway/test/memberWebModules.test.ts`

**Interfaces:**
- Produces `openMemberCache()`.
- Produces `readBootstrapSnapshot(cache)`.
- Produces `replaceThreadMessages(cache, threadRef, messages)`.
- Produces `mergeThreadPage(cache, threadRef, messages)`.
- Produces `saveWorks(cache, works)` and `saveProgress(cache, snapshot)`.
- Produces `saveDraft(cache, threadRef, text)`.
- Produces `saveOutgoing(cache, outgoing)` and `removeOutgoing(cache, clientMessageId)`.
- Produces `applyEventTransaction(cache, eventSequence, writes)` that updates `localAppliedSequence` in the same transaction.
- Produces `clearMemberCache()`.

- [ ] Add failing static tests requiring IndexedDB stores `meta`, `threads`, `messages`, `works`, `progress`, `drafts` and `outgoing`.
- [ ] Add tests requiring the module source to contain no Cookie names, Token fields, Authorization or Provider Session persistence.
- [ ] Add a testable in-memory transaction adapter used by Node tests to prove sequence advancement occurs only after writes succeed.
- [ ] Run CI and observe RED.
- [ ] Implement the IndexedDB wrapper and in-memory test adapter.
- [ ] Run CI and observe GREEN.

### Task 3: Add API client and in-memory store

**Files:**
- Create: `apps/gateway/member-public/api.js`
- Create: `apps/gateway/member-public/store.js`
- Extend: `apps/gateway/test/memberWebModules.test.ts`

**Interfaces:**
- `apiRequest(path, options)` sends `X-Family-AI-Web-Request: 1` for unsafe methods and normalizes `GatewayError`.
- Chat methods: `getHomeChat`, `getThreadMessages`, `sendThreadMessage`, `convertChatToWork`.
- Work methods: `listWorks`, `createWork`, `getWorkProgress`.
- Sync methods: `getSyncEvents`, `ackSyncEvent`.
- Store methods: `createStore(initial)`, `getState`, `setState`, `subscribe`, `reset`.

- [ ] Write failing tests for exported method names, unsafe-header behavior and absence of credential handling.
- [ ] Write failing tests for immutable store snapshots and single notification per update.
- [ ] Run CI and record RED.
- [ ] Implement API and store modules.
- [ ] Run CI and record GREEN.

### Task 4: Implement shared Thread controller

**Files:**
- Extend: `apps/gateway/member-public/thread.js`
- Extend: `apps/gateway/test/memberThreadModel.test.ts`
- Create: `apps/gateway/test/memberProductFlow.test.ts`

**Interfaces:**
- Produces `createThreadController({ api, cache, store, now, uuid })`.
- Methods: `loadLatest`, `loadEarlier`, `saveDraft`, `send`, `retry`, `refresh`.
- `send` creates an outgoing record before the request and reconciles against authoritative messages.
- `retry` reuses the original request body.

- [ ] Write failing model tests for latest/earlier page merge, outgoing lifecycle, offline draft-only behavior and provider failure retention.
- [ ] Add Gateway integration setup that creates a real Web Entry Cookie and opens Home Chat.
- [ ] Run CI and observe RED.
- [ ] Implement the shared controller using injected dependencies so Node tests do not require a DOM.
- [ ] Verify a real Cookie-authenticated Chat send produces Person plus Assistant messages.
- [ ] Run CI and observe GREEN.

### Task 5: Implement Chat and Chat-to-Work

**Files:**
- Create: `apps/gateway/member-public/chat.js`
- Extend: `apps/gateway/test/memberProductFlow.test.ts`
- Extend: `apps/gateway/test/memberWebModules.test.ts`

**Interfaces:**
- Produces `createChatController({ api, cache, store, threadController, timeZone })`.
- Methods: `initialize`, `refresh`, `toggleMessageSelection`, `clearSelection`, `convertSelectionToWork`.

- [ ] Write failing integration assertions for Home Chat initialization with timezone, message history, unique selected message refs and Chat-to-Work conversion.
- [ ] Write failing static assertions that Chat never exposes a new-Chat action.
- [ ] Run CI and observe RED.
- [ ] Implement Chat controller and conversion request.
- [ ] Run CI and observe GREEN.

### Task 6: Implement Work list, creation, detail and Work conversation

**Files:**
- Create: `apps/gateway/member-public/work.js`
- Extend: `apps/gateway/test/memberProductFlow.test.ts`
- Extend: `apps/gateway/test/memberWebModules.test.ts`

**Interfaces:**
- Produces `createWorkController({ api, cache, store, threadController })`.
- Methods: `initialize`, `refreshList`, `create`, `open`, `refreshProgress`.

- [ ] Write failing integration assertions for create/list/open, independent Work thread messages and absent-progress 404 handling.
- [ ] Write failing assertions that the product does not render unsupported pause/complete/archive commands.
- [ ] Run CI and observe RED.
- [ ] Implement Work controller and progress projection.
- [ ] Run CI and observe GREEN.

### Task 7: Implement durable Sync and SSE recovery

**Files:**
- Extend: `apps/gateway/member-public/sync.js`
- Extend: `apps/gateway/test/memberSyncModel.test.ts`
- Extend: `apps/gateway/test/memberProductFlow.test.ts`

**Interfaces:**
- Produces `createSyncController({ api, cache, store, refreshers, EventSourceClass, BroadcastChannelClass })`.
- Methods: `start`, `catchUp`, `connect`, `stop`, `reconnectNow`.

- [ ] Write failing tests proving each page is applied before ACK and a write failure prevents ACK.
- [ ] Write failing tests for EventSource URL Cursor, domain-event parsing, opaque-event ACK, reconnect backoff and BroadcastChannel notification.
- [ ] Write failing integration assertions for explicit catch-up after Person, Assistant and Work events.
- [ ] Run CI and observe RED.
- [ ] Implement catch-up loop, event refreshes, cumulative ACK, SSE reconnect and multi-tab broadcast.
- [ ] Run CI and observe GREEN.

### Task 8: Build the normal product UI

**Files:**
- Create: `apps/gateway/member-public/render.js`
- Create: `apps/gateway/member-public/product.js`
- Modify: `apps/gateway/member-public/index.html`
- Modify: `apps/gateway/member-public/member.css`
- Modify: `apps/gateway/member-public/entry.js`
- Modify: `apps/gateway/test/memberWeb.test.ts`
- Extend: `apps/gateway/test/memberWebModules.test.ts`

**Interfaces:**
- `startProductWorkbench(context)` starts cache, controllers, initial REST refresh and Sync.
- `stopProductWorkbench()` closes SSE/BroadcastChannel and clears subscriptions.
- Rendering supports Chat timeline, Work list/detail, composer, status, dialogs, Toasts and mobile layout.

- [ ] Write failing static tests for message list, composer, load-earlier control, Work list/create dialog, Work detail/progress, Chat-to-Work dialog and mobile bottom navigation.
- [ ] Write failing accessibility tests for labels, live regions, dialog elements and reduced-motion CSS.
- [ ] Write failing syntax checks for every product ES module.
- [ ] Run CI and observe RED.
- [ ] Implement HTML, CSS, renderer and entry orchestration.
- [ ] Ensure logout stops product controllers while device revoke also clears IndexedDB and installation ID.
- [ ] Run CI and observe GREEN.

### Task 9: Serve all product modules and preserve deployment

**Files:**
- Modify: `apps/gateway/src/memberWeb.ts`
- Modify: `apps/gateway/test/memberWeb.test.ts`
- Verify: `Dockerfile`

**Interfaces:**
- All module paths under `/member/assets/*.js` return protected, no-store JavaScript.
- Product route remains available in test, development and production modes.

- [ ] Write failing tests for each new module route and security headers.
- [ ] Verify no historical acceptance asset route is reintroduced.
- [ ] Run CI and observe RED.
- [ ] Register explicit asset routes; do not add a broad filesystem route.
- [ ] Confirm Docker already copies `member-public`; modify only if required by evidence.
- [ ] Run CI and observe GREEN.

### Task 10: Product one-click experience and documentation

**Files:**
- Modify: `scripts/verify-foundation.sh`
- Modify: `README.md`
- Create: `docs/development/2026-07-25-member-web-product-workbench.md`
- Create: `docs/superpowers/evidence/2026-07-25-member-web-product-workbench.md`

**Interfaces:**
- One command leaves a real Family state running and prints the normal Member Web link.
- Instructions ask the user to send a Chat message, create/open a Work, refresh and restart Gateway in normal product UI.

- [ ] Write failing static tests requiring the product experience steps and forbidding acceptance-console language.
- [ ] Run CI and observe RED.
- [ ] Update scripts and README without exposing credentials in tracked files.
- [ ] Record exact RED/GREEN run numbers, final Head and scope boundary in Git evidence.
- [ ] Run CI and observe GREEN.

### Task 11: Final review, browser-oriented evidence and PR readiness

**Files:**
- Update: `docs/superpowers/evidence/2026-07-25-member-web-product-workbench.md`
- Update: PR #25 body.

- [ ] Review all changed files for credential persistence, XSS-prone `innerHTML`, unescaped user content, unsafe URL use and unsupported product controls.
- [ ] Add a failing regression test for every Important issue found before fixing it.
- [ ] Confirm changed-path intersection with PR #14 is zero.
- [ ] Run fresh full Repository CI and Secret Scan on the final Head.
- [ ] Verify PR comments and unresolved Review Threads are empty or addressed.
- [ ] Mark PR #25 Ready for review only after all gates pass.
- [ ] Squash merge PR #25 only after the user-authorized completion gate and exact Head verification.
