# Member Web Product Workbench Development Record

Date: 2026-07-25  
Delivery: PR #25 — `feat(web): complete Member Web product workbench`

## Product decision

Member Web is the normal Family AI personal product entry. It is not an acceptance console and does not expose test-only business state.

```text
one command verifies the platform
→ creates real Family / Person / Web pairing material
→ opens /member/
→ claims a real Web Device and Personal Entry
→ uses the same Chat, Work and Sync APIs as normal operation
```

The historical development acceptance page is not extended into the product.

## Delivered user experience

The `/member/` workbench now supports:

- restoring or pairing a real browser Personal Entry through HttpOnly cookies;
- one long-lived Home Chat with authoritative message history;
- sending Person messages and displaying Assistant replies;
- retrying the same logical message after Provider or transport failure;
- retaining offline input as a local draft without presenting it as sent;
- loading earlier Thread messages without discarding already loaded history;
- selecting Chat messages and creating a Work from their references;
- listing, creating and opening independent Work conversations;
- continuing a separate message Thread inside each Work;
- displaying Work goal, summary and structured progress when available;
- responsive desktop and mobile-browser navigation;
- logout, device-session recovery and permanent browser revocation.

No UI control was added for unsupported Work lifecycle commands such as pause, complete or archive.

## Browser architecture

The browser application remains a same-origin set of focused ES modules served by Gateway:

```text
entry.js   → Web Entry lifecycle
api.js     → same-origin Cookie API client
store.js   → in-memory reactive product state
cache.js   → IndexedDB disposable projection
thread.js  → message paging, outgoing state and retry
chat.js    → Home Chat and Chat → Work
work.js    → Work list, create, open and progress
sync.js    → catch-up, cumulative ACK, SSE and multi-tab notification
render.js  → accessible DOM rendering
product.js → product composition and lifecycle
```

User content is rendered through `textContent`; product modules do not read browser authentication cookies.

## Local projection and synchronization

IndexedDB stores only disposable product state:

```text
meta
threads
messages
works
progress
drafts
outgoing
```

It does not store Device Credential, Entry Session Token, Authorization headers or Provider External Session references.

The reliable sync path is:

```text
GET /api/v1/sync/events
→ refresh the minimum authoritative Chat / Work resources
→ commit resource projection + localAppliedSequence in one IndexedDB transaction
→ POST /api/v1/sync/ack
→ subscribe to GET /api/v1/events/stream
```

SSE delivery never advances the server cursor by itself. The browser ACKs only after the local projection transaction succeeds. `BroadcastChannel` informs other tabs that the shared cache advanced; replayed events remain idempotent.

## Message reliability

Every outgoing logical message preserves:

```text
clientMessageId
occurredAt
content
threadRef
```

Retry uses the exact same request payload. If Gateway accepted the Person message but the Provider reply failed, the authoritative Person message is rendered once and a separate retry status is shown instead of duplicating the user text.

Latest-page refreshes merge into IndexedDB and do not delete earlier pages already loaded by the user.

## Entry recovery

The product differentiates:

- ordinary Session expiry, which starts the normal browser recovery path;
- explicit logout, which retains Device authorization and offers “使用此浏览器恢复入口”;
- Device revocation, which clears the local product projection and rotates the browser installation identifier;
- expired or consumed deep links, which clear the old `pairingRef` before manual pairing.

The pairing explanation has its own DOM target and cannot overwrite the product eyebrow or title.

## One-command product handoff

`./scripts/verify-foundation.sh` leaves the verified Family state running and writes the real Member Web pairing handoff to an atomic local file with mode `0600`. Formal output reveals only that file's path; it never prints, logs or opens the secret-bearing URL.

The handoff file contains a fragment URL in this shape:

```text
http://127.0.0.1:8790/member/#pairingRef=pairing%3Aexample&code=ABCD-EFGH
```

Pairing data never appears in the query string. Do not inspect the handoff with `cat`, pipe it through `tee`, paste it into a shell command, or include it in a report. A controlled browser workflow consumes the ignored local file directly. Pairing codes, credentials and Session tokens are not committed to documentation.

## Verification summary

The final code head before documentation-only commits passed:

- Repository CI #505;
- Secret Scan #391;
- all workspace tests;
- static repository and deployment checks;
- TypeScript type checking;
- all workspace builds.

Detailed TDD and review evidence is recorded in:

- `docs/superpowers/evidence/2026-07-25-member-web-product-workbench.md`

## PR #14 isolation

PR #25 does not modify:

```text
clients/ios/**
.github/workflows/ios-ci.yml
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
```

Member Web consumes the same server-side Person, Chat, Work and Sync objects while keeping the iOS implementation branch independent.

## Next development sequence

```text
Push Notification wake-up
→ iOS Chat / Work and Device Sync integration
→ HarmonyOS personal entry
→ file, image and voice capabilities
→ formal Admin Web
```
