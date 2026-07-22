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

## Beginner one-click browser acceptance

The local development page now provides a beginner-facing **“一键体验验收”** button. After the clean development Gateway opens in the browser, the reviewer clicks once and the page performs the complete visible flow without terminal commands, API tools, database inspection, or credential handling.

The browser runner visibly reports ten steps:

1. confirm the Gateway and clean experience environment;
2. create an experience Family, administrator, and management computer;
3. compare Family Admin and Personal Entry isolation;
4. create a mobile-entry family member;
5. generate five-minute pairing material and preview the manual short code;
6. simulate an iPhone claim and verify Personal-only Portal context;
7. verify renewal, logout, and renewal after logout;
8. verify local iPhone unbind;
9. create a second simulated iPhone and verify administrator remote revoke;
10. generate a downloadable Chinese acceptance report.

The progress list shows `等待 / 进行中 / 通过 / 失败` for every step. The final report contains only user-readable evidence and excludes pairing codes, QR contents, installation identifiers, Device Credentials, EntrySession Tokens, Authorization headers, SQL data, and local paths. Pairing and simulated-device material remain in JavaScript module memory and are cleared when the flow finishes.

For local development only, the loopback acceptance page may generate a contract-safe `https://127.0.0.1:8790` QR Gateway value while the console itself is served on loopback HTTP. This exception is restricted to `development` mode and does not relax HTTPS generation in `test` or `production` mode.

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

The Vitest suites additionally cover mismatch attempt accounting, expiry, consumed and revoked codes, five failed attempts, inactive targets, code collision regeneration, claim transaction rollback, credential conflicts, authorization interchange, development-only loopback QR generation, browser-module syntax, and Foundation regressions.

## Secret-handling rules

The runtime script keeps synthetic credentials in process variables only. Generated reports omit:

- pairing codes and QR payloads;
- installation identifiers;
- Device Credentials;
- EntrySession Tokens;
- Authorization headers;
- request bodies containing credentials;
- SQL rows and host filesystem paths.

The Web pairing dialog and one-click runner keep pairing material in module memory only. They do not write that material to `localStorage`, `sessionStorage`, or browser console output. Closing, expiring, consuming, or revoking a manual pairing clears the DOM and in-memory state; closing an active dialog also revokes the server-side pairing record. The one-click runner clears both simulated mobile devices from its module state before returning control to the reviewer.

## Physical iPhone boundary

The browser runner simulates the iPhone protocol path and does not replace physical-device acceptance. Physical Mobile Entry E2E must still verify Tailscale Serve HTTPS reachability, camera scanning, Keychain persistence, local authentication, offline behavior, and administrator revocation on an actual iPhone.
