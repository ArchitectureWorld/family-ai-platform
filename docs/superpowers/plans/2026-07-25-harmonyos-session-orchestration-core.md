# HarmonyOS Session Orchestration Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transport-independent Mobile Gateway client and SessionManager that can be verified before DevEco system adapters exist.

**Architecture:** `MobileGatewayClient` owns endpoint/authentication/decoding semantics over an injected `GatewayTransport`. `SessionManager` owns restore, serialized renewal, logout and unbind over injected Gateway and CredentialStore ports. No system API, file system or network implementation enters the core.

**Tech Stack:** TypeScript 6, Node.js 22 test runner, existing HarmonyOS core parsers and request builders.

## Global Constraints

- Work only on `feat/harmonyos-mobile-entry-foundation` / PR #26.
- Keep PR #26 Draft.
- Do not modify `clients/ios/**`, `apps/gateway/**`, `packages/contracts/**`, Member Web or existing workflows except HarmonyOS Core CI if strictly required.
- Follow RED → GREEN for every production module.
- logout uses Device Credential.
- timeout / unreachable preserve credentials.
- Device revoke clears Device + Session authorization.
- No real Token, Device Credential, hostname or pairing material enters tests or docs.

---

### Task 1: Gateway Client RED Tests

**Files:**
- Create: `clients/harmonyos/core/test/gatewayClient.test.ts`

**Interfaces:**
- Consumes: existing `GatewayRequest`, `MOBILE_ENDPOINTS`, strict response parsers.
- Produces expected API for `GatewayTransport`, `MobileGatewayClient`, `GatewayClientError`, `GatewayTransportError`.

- [x] **Step 1: Write tests for exact request semantics**

Require:

```ts
client.fetchPortalContext(profile, session)
client.renew(profile, device)
client.logout(profile, device)
client.unbind(profile, device)
```

and assert exact method, path and Header isolation.

- [x] **Step 2: Write tests for response/error mapping**

Cover strict success parsing, stable server code, malformed success/error, timeout, unreachable and insecure Gateway.

- [x] **Step 3: Push tests and observe `ERR_MODULE_NOT_FOUND` for `gatewayClient.ts`**

Observed: HarmonyOS Core CI #4 failed before the production module existed.

### Task 2: Minimal Gateway Client

**Files:**
- Create: `clients/harmonyos/core/src/gatewayClient.ts`
- Modify: `clients/harmonyos/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
interface GatewayProfile { baseURL: string }
interface GatewayTransportResponse { status: number; body: unknown }
interface GatewayTransport {
  send(input: { baseURL: string; request: GatewayRequest }): Promise<GatewayTransportResponse>;
}
class GatewayTransportError extends Error
class GatewayClientError extends Error
class MobileGatewayClient
```

- [x] **Step 1: Implement request dispatch through injected Transport**
- [x] **Step 2: Validate base URL before calling Transport**
- [x] **Step 3: Parse 2xx response with endpoint-specific parser**
- [x] **Step 4: Parse non-2xx response with `parseMobileGatewayError`**
- [x] **Step 5: Map Transport error kinds without leaking raw errors**
- [x] **Step 6: Run GatewayClient tests and strict typecheck; require GREEN**

### Task 3: Credential Store Port and SessionManager RED Tests

**Files:**
- Create: `clients/harmonyos/core/src/credentialStore.ts`
- Create: `clients/harmonyos/core/test/sessionManager.test.ts`

**Interfaces:**
- Produces expected API for:

```ts
interface MobileCredentialStore
interface SessionGateway
class SessionManager
```

- [x] **Step 1: Define only the CredentialStore interface**
- [x] **Step 2: Write tests for restore decision table**
- [x] **Step 3: Write tests for serialized renewal**
- [x] **Step 4: Write tests for logout and unbind lifecycle**
- [x] **Step 5: Push tests and observe `ERR_MODULE_NOT_FOUND` for `sessionManager.ts`**

Observed: HarmonyOS Core CI #11 failed before the production module existed.

### Task 4: Minimal SessionManager

**Files:**
- Create: `clients/harmonyos/core/src/sessionManager.ts`
- Modify: `clients/harmonyos/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
type SessionRestoreResult =
  | { kind: "needsPairing" }
  | { kind: "authenticated"; context: PersonalPortalContext }
  | { kind: "offline" }
  | { kind: "revoked" };

class SessionManager {
  restore(): Promise<SessionRestoreResult>;
  validSession(): Promise<EntrySessionCredential>;
  logout(): Promise<void>;
  unbind(): Promise<void>;
}
```

- [x] **Step 1: Implement no-device and valid-session paths**
- [x] **Step 2: Implement missing/expired Session renewal**
- [x] **Step 3: Implement one retry after Entry Session invalid/expired**
- [x] **Step 4: Serialize concurrent renewals**
- [x] **Step 5: Implement offline/revoked mapping**
- [x] **Step 6: Implement Device-authenticated logout and unbind**
- [x] **Step 7: Run SessionManager tests and strict typecheck; require GREEN**

### Task 5: Full Verification and Documentation

**Files:**
- Modify: `clients/harmonyos/core/README.md`
- Modify: `clients/harmonyos/README.md`
- Create: `docs/superpowers/evidence/2026-07-25-harmonyos-session-orchestration-core.md`

- [x] **Step 1: Run `bash ./scripts/verify-harmonyos-core.sh`**
- [x] **Step 2: Verify Repository CI, HarmonyOS Core CI and Secret Scan**
- [x] **Step 3: Verify final PR path intersection against PR #14, #25 and #27 is zero**
- [x] **Step 4: Update PR #26 description with exact evidence**
- [x] **Step 5: Keep PR Draft and do not merge**
