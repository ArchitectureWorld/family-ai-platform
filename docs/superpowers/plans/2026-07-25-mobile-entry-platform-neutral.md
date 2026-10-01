# Mobile Entry Platform-Neutral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow RED → GREEN and keep this PR Draft.

**Goal:** Extend Mobile Entry v1 from iOS-only to the backward-compatible mobile platform set `ios | harmonyos`, and persist the validated platform in Gateway SQLite.

**Architecture:** Keep one Mobile Entry protocol and one pairing domain. Expand only the public platform enum, then replace Gateway's hard-coded device platform with the already-validated request descriptor. No client, Web, identity or authorization changes.

**Tech Stack:** TypeScript 6, Zod, Fastify, better-sqlite3, Vitest, Node 22.

## Constraints

- Base directly on current `main`.
- Do not modify `clients/ios/**`, `clients/harmonyos/**`, Member Web or iOS CI.
- Keep `MOBILE_ENTRY_PROTOCOL_VERSION = 1`.
- Keep `terminalType = mobile`.
- Preserve all existing iOS fixtures and tests.
- Reject unknown platforms and unknown fields.
- Platform metadata never grants permissions.
- No merge without explicit user authorization.

---

### Task 1: Define RED Contract behavior

**Files:**
- Create: `packages/contracts/fixtures/mobile-entry/pairing-claim-harmonyos-request.json`
- Create: `packages/contracts/test/mobileEntryPlatform.test.ts`

- [ ] Add a canonical HarmonyOS claim fixture.
- [ ] Add a test requiring `pairingClaimRequestSchema` to accept the fixture.
- [ ] Add negative tests for `android`, unknown platform, non-mobile terminal type and unknown fields.
- [ ] Run focused Contract tests and record the expected RED failure caused by `platform: z.literal("ios")`.

### Task 2: Define RED Gateway persistence behavior

**Files:**
- Create: `apps/gateway/test/mobileHarmonyPairing.test.ts`

- [ ] Initialize a synthetic Family through the formal onboarding route.
- [ ] Create pairing material through a `family_admin` Entry Session.
- [ ] Claim using `terminalType = mobile`, `platform = harmonyos`.
- [ ] Require HTTP 201.
- [ ] Query `managed_devices` and require the stored row to contain `mobile / harmonyos` plus supplied system/app/model metadata.
- [ ] Run focused Gateway test and record the expected RED rejection.

### Task 3: Expand the Contract minimally

**Files:**
- Modify: `packages/contracts/src/mobileEntry.ts`

- [ ] Replace only:

```ts
platform: z.literal("ios")
```

with:

```ts
platform: z.enum(["ios", "harmonyos"])
```

- [ ] Keep all other request fields and strictness unchanged.
- [ ] Run Contract tests; require GREEN.

### Task 4: Persist validated device metadata

**Files:**
- Modify: `apps/gateway/src/mobilePairing.ts`

- [ ] Replace SQL literals for terminal type and platform with placeholders.
- [ ] Bind `input.device.terminalType` and `input.device.platform`.
- [ ] Keep the transaction and idempotency semantics unchanged.
- [ ] Run focused Gateway tests; require GREEN.

### Task 5: Full verification

- [ ] Run Contracts tests.
- [ ] Run Gateway mobile tests.
- [ ] Run `npm run check`.
- [ ] Verify Secret Scan.
- [ ] Verify PR path intersection is zero with PR #14, #25 and #26.
- [ ] Record RED → GREEN and final Actions evidence.
- [ ] Keep PR Draft.
