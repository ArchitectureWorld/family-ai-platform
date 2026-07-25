# Member Web Product Workbench Verification Evidence

Date: 2026-07-25  
PR: #25 — `feat(web): complete Member Web product workbench`

## Scope under verification

```text
/member/ normal product workbench
Chat timeline, paging, send and retry
Chat selection → Work
Work list, create, detail, progress and independent Thread
IndexedDB product projection and offline drafts
Device Sync catch-up and cumulative ACK
SSE realtime delivery and reconnect
multi-tab cache notification
responsive desktop and mobile-browser UI
Web Entry recovery, logout and device revocation
```

No acceptance console, acceptance-only endpoint, debug panel or test-only business state is part of the product.

## Automated gates

Final implementation head before development-record commits:

```text
5d19782d2b20bf0278db0b24e9831561c383dbec
Repository CI #505       success
Secret Scan #391         success
```

Implementation plus development-record head:

```text
848db9dacaf0d25d7524db7d548be78334828b79
Repository CI #507       success
Secret Scan #393         success
```

Repository CI completed:

- workspace tests;
- script and public-repository checks;
- TypeScript type checking;
- all workspace builds.

## TDD evidence

Development used failing tests before production behavior. Representative GitHub Actions RED → GREEN cycles include:

| Capability | RED | GREEN |
|---|---:|---:|
| API client and product store foundation | CI #428 | CI #430 |
| IndexedDB projection and atomic cache behavior | CI #432 | CI #435 |
| Thread history, outgoing message and retry model | CI #436 | CI #439 |
| Sync event mapping, reconnect and contiguous sequence rules | CI #440 | CI #445 |
| Provider failure / success projection and entry recovery | CI #498 | CI #500 |
| Consumed deep-link cleanup, pairing copy target and logout recovery | CI #503 | CI #505 |

The RED runs failed because the new behavior was absent or because review tests exposed a real inconsistency. The corresponding GREEN runs include the production change and full repository quality gate.

## End-to-end Gateway evidence

`apps/gateway/test/memberProductFlow.test.ts` verifies the real browser Cookie entry through formal Gateway routes:

```text
claim Web Device
→ open Home Chat
→ send Person message
→ persist and read Assistant reply
→ create Work
→ send within the Work Thread
→ convert a selected Chat message to Work
→ read durable sync events
→ cumulative ACK
→ restart Gateway
→ restore the same Entry, Chat and messages
```

The product flow does not use a test-only Chat, Work or authentication endpoint.

## Local projection evidence

Tests cover:

- required IndexedDB stores;
- message and Work sorting;
- event writes and `localAppliedSequence` in one transaction;
- transaction rollback without partial projection writes;
- replay idempotency;
- no credentials or Provider external session in the cache module;
- latest-page refresh preserving earlier pages;
- drafts stored locally while offline;
- exact logical message identity on retry;
- authoritative message reconciliation;
- selected section and Work restoration after refresh.

## Sync evidence

Tests cover:

- all known public Sync events;
- opaque future events without invented product behavior;
- strictly contiguous event application;
- catch-up before SSE subscription;
- cumulative ACK only after local transaction success;
- EventSource `id` / `eventSequence` consistency;
- exponential reconnect bounded at 30 seconds;
- inactive Thread refresh so later navigation is not stale;
- BroadcastChannel cache-advanced notification;
- Session expiry and Device revocation returning to the Entry lifecycle instead of reconnecting forever.

SSE receipt alone does not advance the server cursor.

## Message reliability review

Completion review added regression coverage for:

1. Earlier message pages remain available after realtime latest-page refresh.
2. A background Work or Chat Thread still refreshes when its event arrives.
3. An accepted Person message plus Provider failure is rendered once with a separate retry state.
4. Retry preserves the original `clientMessageId`, `occurredAt` and content.
5. Provider success removes the failed outgoing state.
6. Provider failure creates a retryable outgoing state from the authoritative Person message.

## Entry lifecycle review

Completion review added regression coverage for:

- reading or creating the browser installation id only at claim time;
- rotating the installation id after permanent Device revocation;
- clearing a consumed or invalid deep-link `pairingRef` before manual pairing;
- updating a dedicated `pairingMessage` node instead of overwriting the product eyebrow;
- explicit “使用此浏览器恢复入口” after logout;
- same-browser Device Session renewal through the formal Web Entry endpoint.

## UI and accessibility evidence

Static and module tests verify:

- focused ES modules are syntactically valid and served through explicit product routes;
- Chat and Work product structures exist without acceptance or debug controls;
- user content is rendered through `textContent`, not `innerHTML`;
- keyboard Enter / Shift+Enter behavior;
- dialogs with accessible labels;
- `aria-live` message and status regions;
- minimum touch target sizing;
- responsive layouts and mobile bottom navigation;
- reduced-motion handling;
- mobile Work selection without relying on the desktop sidebar.

## Security evidence

Verified boundaries:

```text
HttpOnly browser credentials
SameSite=Strict
Secure in production
same-origin Cookie write guard
explicit Authorization Header precedence
no document.cookie access in product modules
no credential or token in IndexedDB
no user HTML concatenation
no Provider External Session in browser cache
```

Secret Scan #393 passed with the implementation and committed development records.

## One-command product experience

`./scripts/verify-foundation.sh`:

- runs the repository and Docker-oriented preflight checks;
- builds and verifies the image on the target host;
- creates and validates real Family / Person / Entry state;
- retains the verified data;
- prints a real Member Web pairing link;
- opens the normal product path rather than a dedicated acceptance page.

The pairing URL and logs remain under Git-ignored runtime paths. This connector session verified the committed implementation and CI gates; the target Linux/NAS command remains the operational product-experience check.

## PR #14 isolation

PR #25 changed paths have no overlap with PR #14. It does not modify:

```text
clients/ios/**
.github/workflows/ios-ci.yml
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
```

PR #14 remains an independent Draft pending physical-device acceptance.
