# Mobile Entry Gateway v1 Acceptance

## Scope

This acceptance covers the Gateway vertical slice for iPhone pairing and Personal Entry lifecycle:

- administrator-created five-minute pairing material for one active Person;
- manual short-code and QR-derived pairing requests;
- person-scoped ManagedDevice, DeviceBinding, personal EntryBinding, and seven-day EntrySession creation;
- claim idempotency and installation credential conflict protection;
- Device authentication, renewal, logout, local unbind, and administrator remote revoke;
- versioned Personal Portal context;
- Web member pairing controls and active mobile-device count;
- hash-only persistence of pairing codes, installation identifiers, Device Credentials, and EntrySession Tokens.

## Automated verification

Run from the repository root:

```bash
npm ci
npm run check
./scripts/verify-foundation.sh
bash scripts/acceptance-mobile-pairing.sh
```

`verify-foundation.sh` must run before the Mobile Entry acceptance. It leaves a clean development Gateway running with a fresh local Bootstrap Token. The Mobile Entry script then builds a synthetic family and devices through the public HTTP interfaces.

## Runtime acceptance coverage

The script verifies:

1. the formal Family domain starts empty;
2. Bootstrap authentication is used only for one-time family initialization;
3. a Personal Entry cannot create pairing material;
4. an administrator can generate QR and manual pairing material;
5. manual preview resolves the intended Family and Person;
6. QR claim creates a personal-only mobile entry;
7. an identical claim retry reuses the ManagedDevice;
8. Personal Portal context contains `protocolVersion: 1`;
9. Device authentication cannot access Portal, Admin, or Chat APIs;
10. renewal replaces the active Personal Session;
11. logout revokes only the Session and preserves Device authorization;
12. SQLite contains no plaintext pairing or credential material;
13. local unbind revokes Device authorization and all related bindings/sessions;
14. administrator remote revoke uses the same effective lifecycle;
15. revoked devices cannot renew.

The Vitest suites additionally cover mismatch attempt accounting, expiry, consumed and revoked codes, five failed attempts, inactive targets, code collision regeneration, claim transaction rollback, credential conflicts, authorization interchange, and Foundation regressions.

## Secret-handling rules

The runtime script keeps synthetic credentials in process variables only. Generated reports omit:

- pairing codes and QR payloads;
- installation identifiers;
- Device Credentials;
- EntrySession Tokens;
- Authorization headers;
- request bodies containing credentials;
- SQL rows and host filesystem paths.

The Web pairing dialog keeps pairing material in module memory only. It does not write that material to `localStorage`, `sessionStorage`, or browser console output. Closing, expiring, consuming, or revoking a pairing clears the DOM and in-memory state; closing an active dialog also revokes the server-side pairing record.

## Physical iPhone boundary

This PR can establish API integration readiness, but physical-device acceptance remains a separate Mobile Entry E2E activity. It must verify Tailscale Serve HTTPS reachability, camera scanning, Keychain persistence, local authentication, offline behavior, and administrator revocation on an actual iPhone.
