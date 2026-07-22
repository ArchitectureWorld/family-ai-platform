# Mobile Entry Contract v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one validated TypeScript and JSON source of truth for the Gateway and iOS mobile-entry implementations.

**Architecture:** Add a focused `mobileEntry.ts` contract module beside the existing message and provider schemas, re-export it from the package entry point, validate representative success and error fixtures in Vitest, and keep all fixture values synthetic. The schemas describe API payloads, not database rows or HTTP headers.

**Tech Stack:** TypeScript 6, Zod 4, Vitest 4, JSON fixtures, npm workspaces.

## Global Constraints

- Mobile entry protocol version is integer `1`.
- QR Gateway URLs must use HTTPS and contain no username, password, query, or fragment.
- Pairing code format is four safe uppercase characters, a hyphen, and four safe uppercase characters.
- Device credentials and session tokens in fixtures are synthetic values and never copied from runtime output.
- Contract types contain no SQLite fields, credential hashes, filesystem paths, or Tailnet-specific hostnames.
- Existing `PROTOCOL_VERSION = "1.0"` for message/provider contracts remains unchanged.

---

### Task 1: Add failing mobile-entry schema tests

**Files:**
- Create: `packages/contracts/test/mobileEntry.test.ts`
- Test fixtures: `packages/contracts/fixtures/mobile-entry/*.json`

**Interfaces:**
- Consumes: exports from `packages/contracts/src/mobileEntry.ts`.
- Produces: executable expectations for every public mobile-entry payload.

- [ ] **Step 1: Write fixture-loading test helpers**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/mobile-entry/${name}`, import.meta.url)),
      "utf8"
    )
  );
}
```

- [ ] **Step 2: Write failing success-fixture tests**

Validate:

```ts
pairingPreviewRequestSchema.parse(fixture("pairing-preview-request.json"));
pairingPreviewResponseSchema.parse(fixture("pairing-preview-success.json"));
pairingClaimRequestSchema.parse(fixture("pairing-claim-request.json"));
pairingClaimResponseSchema.parse(fixture("pairing-claim-success.json"));
personalPortalContextSchema.parse(fixture("portal-context-personal.json"));
sessionRenewResponseSchema.parse(fixture("session-renew-success.json"));
```

- [ ] **Step 3: Write failing rejection tests**

Reject:

- `http://` Gateway URLs;
- URLs with credentials;
- unknown protocol versions;
- ambiguous pairing characters such as `0`, `O`, `1`, or `I`;
- `family_admin` portal contexts;
- device credentials shorter than 43 base64url characters;
- unknown fields on strict request and response objects.

- [ ] **Step 4: Run the focused test and verify failure**

Run:

```bash
npm run test -w @family-ai/contracts -- mobileEntry.test.ts
```

Expected: FAIL because the mobile-entry module and fixtures do not exist.

- [ ] **Step 5: Commit the red test**

```bash
git add packages/contracts/test/mobileEntry.test.ts
git commit -m "test(contracts): define mobile entry protocol expectations"
```

---

### Task 2: Implement the mobile-entry schema module

**Files:**
- Create: `packages/contracts/src/mobileEntry.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces constants, schemas, and inferred types imported by Gateway and tests.

- [ ] **Step 1: Define protocol and primitive schemas**

```ts
export const MOBILE_ENTRY_PROTOCOL_VERSION = 1 as const;

const protocolVersionSchema = z.literal(MOBILE_ENTRY_PROTOCOL_VERSION);
const timestampSchema = z.string().datetime({ offset: true });
const pairingCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
const deviceCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
```

- [ ] **Step 2: Define stable reference schemas**

Create strict schemas for:

```text
family
person
device
device-binding
entry-binding
entry-session
pairing
assignment
agent
provider-profile
```

Each accepts the existing `<prefix>:<safe-id>` format and rejects a wrong prefix.

- [ ] **Step 3: Define and export payload schemas**

Required exports:

```ts
pairingQrPayloadSchema
pairingPreviewRequestSchema
pairingPreviewResponseSchema
pairingClaimRequestSchema
pairingClaimResponseSchema
sessionRenewResponseSchema
mobileOperationResponseSchema
personalPortalContextSchema
mobileGatewayErrorSchema
```

The QR Gateway URL refinement must enforce:

```ts
const parsed = new URL(value);
return parsed.protocol === "https:" &&
  parsed.username === "" &&
  parsed.password === "" &&
  parsed.search === "" &&
  parsed.hash === "";
```

- [ ] **Step 4: Define stable error-code enum**

```ts
export const mobileGatewayErrorCodeSchema = z.enum([
  "PAIRING_INVALID",
  "PAIRING_EXPIRED",
  "PAIRING_CONSUMED",
  "PAIRING_ATTEMPTS_EXCEEDED",
  "PAIRING_TARGET_INACTIVE",
  "DEVICE_AUTH_INVALID",
  "DEVICE_REVOKED",
  "ENTRY_SESSION_EXPIRED",
  "ENTRY_SESSION_INVALID",
  "ENTRY_AUDIENCE_FORBIDDEN",
  "PROTOCOL_VERSION_UNSUPPORTED"
]);
```

- [ ] **Step 5: Export inferred TypeScript types**

Export one type per schema using `z.infer`, including `PairingClaimRequest`, `PairingClaimResponse`, `EntrySessionCredential`, `PersonalPortalContext`, and `MobileGatewayError`.

- [ ] **Step 6: Re-export from the package entry point**

Append to `packages/contracts/src/index.ts`:

```ts
export * from "./mobileEntry.js";
```

- [ ] **Step 7: Run typecheck and focused tests**

```bash
npm run typecheck -w @family-ai/contracts
npm run test -w @family-ai/contracts -- mobileEntry.test.ts
```

Expected: tests still fail only because fixture files are missing.

- [ ] **Step 8: Commit the schema module**

```bash
git add packages/contracts/src/mobileEntry.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add mobile entry protocol v1 schemas"
```

---

### Task 3: Add canonical synthetic fixtures

**Files:**
- Create: `packages/contracts/fixtures/mobile-entry/pairing-preview-request.json`
- Create: `packages/contracts/fixtures/mobile-entry/pairing-preview-success.json`
- Create: `packages/contracts/fixtures/mobile-entry/pairing-claim-request.json`
- Create: `packages/contracts/fixtures/mobile-entry/pairing-claim-success.json`
- Create: `packages/contracts/fixtures/mobile-entry/session-renew-success.json`
- Create: `packages/contracts/fixtures/mobile-entry/portal-context-personal.json`
- Create: `packages/contracts/fixtures/mobile-entry/pairing-expired-error.json`
- Create: `packages/contracts/fixtures/mobile-entry/device-revoked-error.json`
- Create: `packages/contracts/fixtures/mobile-entry/session-expired-error.json`

**Interfaces:**
- Produces cross-language examples for Gateway tests and Swift decoding tests.

- [ ] **Step 1: Add success fixtures**

Use only reserved example hostnames such as:

```text
family-ai-gateway.example.ts.net
```

Use deterministic synthetic references ending in `test-*`; never paste runtime values.

- [ ] **Step 2: Add error fixtures**

Each error fixture uses:

```json
{
  "protocolVersion": 1,
  "error": {
    "code": "PAIRING_EXPIRED",
    "category": "conflict",
    "message": "配对码已过期。",
    "retryable": false
  }
}
```

Change the code, category, and message as appropriate.

- [ ] **Step 3: Run contract tests**

```bash
npm run test -w @family-ai/contracts -- mobileEntry.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full repository verification**

```bash
npm run check
```

Expected: all tests, typechecks, static checks, and builds pass.

- [ ] **Step 5: Commit fixtures**

```bash
git add packages/contracts/fixtures/mobile-entry packages/contracts/test/mobileEntry.test.ts
git commit -m "test(contracts): add mobile entry protocol fixtures"
```

---

### Task 4: Document contract ownership and change control

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/ios-terminal-development-plan.md`

**Interfaces:**
- Produces repository guidance that prevents Gateway and Swift models from drifting.

- [ ] **Step 1: Add source-of-truth rule**

Document that `packages/contracts/src/mobileEntry.ts` plus `packages/contracts/fixtures/mobile-entry/` define mobile-entry v1.

- [ ] **Step 2: Add compatibility rule**

Any breaking field, semantic, error-code, or QR-format change requires a new protocol version and updated fixtures; clients must reject unsupported versions.

- [ ] **Step 3: Run documentation and static checks**

```bash
npm run test:scripts
```

Expected: PASS.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/architecture/ios-terminal-development-plan.md
git commit -m "docs: define mobile entry contract change control"
```

## Final verification

```bash
npm ci
npm run check
```

Expected: exit code 0 with no secret-like runtime values in logs or fixtures.