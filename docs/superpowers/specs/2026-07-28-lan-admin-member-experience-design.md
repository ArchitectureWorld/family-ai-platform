# Family AI LAN Admin and Member Experience Design

Date: 2026-07-28
Status: approved for implementation

## 1. Objective

Provide one coherent, directly experienceable Family AI development environment
in which:

1. an administrator opens a real browser management page;
2. the administrator creates or restores the development family;
3. the administrator manages family members and generates a five-minute browser
   pairing code;
4. another browser on the same trusted LAN scans the QR code or enters the short
   code;
5. that browser enters the existing Member Web Chat and Work product;
6. both pages use the same Gateway process and SQLite database.

The normal Member Web remains the product root for the Gateway itself. The LAN
experience proxy has its own root redirect to the Admin Web so a novice opening
the advertised LAN URL reaches the administrator experience first.

## 2. Current State and Root Cause

The merged Gateway registers `registerMemberWeb()` in every mode. It redirects
`/` to `/member/` and serves the Member Web product. The repository still
contains the former development onboarding console, but `buildGatewayApp()` no
longer registers it. Consequently:

- `/member/` is available;
- `/admin/` is absent;
- the old acceptance assets are absent;
- the Preview Pair helper creates a protected one-click Member handoff instead
  of displaying a short code to an administrator;
- Preview listeners are deliberately restricted to `127.0.0.1`.

The old container on port 8790 is not a solution. It runs an earlier image, does
not contain the current Member Web, and uses a different database from the
8791 Preview.

Plain LAN HTTP is also insufficient. Member Web deliberately requires browser
Web Locks for safe entry mutations, and Web Locks are restricted to secure
contexts. Therefore the LAN experience must use trusted HTTPS.

## 3. Scope

### In scope

- a development-only Admin Web at `/admin/`;
- family initialization when the Preview database is new;
- restoring the administrator entry in an authorized Preview browser;
- listing and adding family members;
- generating, displaying, revoking, and expiring member pairing codes;
- a browser Member pairing QR and a manual short code;
- explicit LAN HTTPS Preview startup and shutdown;
- local CA creation, leaf certificate rotation, and CA certificate download;
- safe, path-only administrator handoff output;
- automated and real-runtime acceptance evidence;
- local merge into `main` after review.

### Out of scope

- production account recovery;
- internet exposure;
- a production certificate authority;
- changing the existing 8790 service;
- weakening the Web Locks, Cookie, entry-session, or device-credential
  boundaries;
- exposing Admin APIs without an authenticated `family_admin` entry;
- automatically trusting the CA on every third-party device;
- pushing to a Git remote without separate authorization.

## 4. Architecture

### 4.1 Internal Gateway

The existing Preview Gateway continues to listen only on:

```text
http://127.0.0.1:8791
```

The optional claim-loss proxy remains loopback-only on 8792. LAN enablement does
not change either listener or the existing process-ownership contracts.

### 4.2 Isolated LAN TLS proxy

An isolated Nginx instance, launched with a Preview-owned prefix and
configuration, listens on:

```text
https://0.0.0.0:9443
http://0.0.0.0:9080
```

It does not modify `/etc/nginx`, the system Nginx service, or any system virtual
host.

The HTTPS server:

- redirects `/` to `/admin/`;
- proxies all other paths to `127.0.0.1:8791`;
- preserves the external `Host`;
- sets `X-Forwarded-Proto: https`;
- disables proxy buffering for streaming routes;
- supports long-lived SSE connections;
- accepts TLS 1.2 and TLS 1.3 only.

The HTTP server serves exactly:

```text
/family-ai-preview-ca.crt
```

Every other HTTP path returns 404. The HTTP endpoint contains no application
page, redirect, credential, pairing material, or private key.

### 4.3 LAN address

Startup discovers the active private IPv4 address from the default route. The
address must be an RFC1918 address and currently resolves to:

```text
192.168.110.84
```

The advertised URLs are:

```text
http://192.168.110.84:9080/family-ai-preview-ca.crt
https://192.168.110.84:9443/
https://192.168.110.84:9443/admin/
https://192.168.110.84:9443/member/
```

If the active LAN address changes, startup issues a new leaf certificate for
the new address while retaining the same local root CA unless the root is
invalid or expired.

## 5. Admin Web

### 5.1 Route boundary

Admin Web is registered only when `GatewayMode` is `development`.

```text
GET /admin       -> 302 /admin/
GET /admin/      -> protected Admin HTML
GET /admin/assets/* -> protected Admin JavaScript and CSS
```

The routes and assets return 404 in `test` and `production` modes. The existing
Gateway root and Member Web routes are unchanged.

Every Admin asset uses:

- `Cache-Control: no-store`;
- a restrictive same-origin Content Security Policy;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- `X-Frame-Options: DENY`;
- a restrictive Permissions Policy.

### 5.2 User-visible states

The Admin Web contains four explicit states:

1. **Initializing** — health and onboarding status are being read.
2. **Create family** — available only with a valid bootstrap handoff on a new
   database.
3. **Family management** — authenticated administrator dashboard.
4. **Recovery required** — the family exists but this browser has no authorized
   Admin entry.

The management dashboard displays family and administrator identity, the member
list, role, personal-entry status, and active personal-device count. It supports
adding an adult, child, or elder and generating a pairing code for any active
member.

It does not display entry tokens, device credentials, hashes, database rows, or
private certificate material.

### 5.3 Pairing dialog

The pairing dialog displays:

- family and member display names;
- the eight-character short code;
- a five-minute countdown;
- a QR code containing a same-origin Member Web handoff;
- the plain Member URL for manual entry;
- revoke and close actions.

The QR URL has this shape:

```text
https://192.168.110.84:9443/member/#pairingRef=...&code=...
```

The fragment is never sent to Nginx or the Gateway. Member Web captures it into
SessionStorage and removes it from the address bar before constructing its API
client. Closing the dialog revokes any unconsumed pairing code.

## 6. Administrator Handoff

The Preview must support both database states without resetting data.

### 6.1 New database

The handoff carries the existing development bootstrap device and token to
`/admin/`. The Admin page captures them into SessionStorage, immediately scrubs
the fragment, and permits the one-time family creation flow.

### 6.2 Initialized database

The handoff carries the existing protected Admin entry-session reference and
token from `.runtime-preview/config/admin-entry.json`. The Admin page captures
them into SessionStorage, immediately scrubs the fragment, validates
`/api/v1/portal/context`, and opens family management.

### 6.3 Handoff persistence contract

`scripts/member-preview-admin.mjs` writes the full handoff to:

```text
.runtime-preview/config/admin-web-url-9443
```

The runtime and parent directories are `0700`; the file is a regular,
non-symlink file with mode `0600`; writes are exclusive, synchronized, and
atomically renamed. Standard output contains only the absolute file path.

No complete handoff, token, bootstrap credential, pairing code, or URL fragment
may appear in terminal output, logs, reports, Git, Nginx access logs, or error
messages.

## 7. TLS and Certificate Lifecycle

### 7.1 Local CA

The LAN Preview creates a dedicated ECDSA P-256 root CA under the protected
Preview runtime:

```text
.runtime-preview/lan-tls/ca.key
.runtime-preview/lan-tls/ca.crt
```

The CA key is mode `0600`, never leaves the protected runtime, and is never
served. The CA certificate is public and is the only file available from port
9080. Startup prints its SHA-256 fingerprint so a user can verify an installed
copy.

### 7.2 Leaf certificate

The leaf certificate:

- is signed by the Preview CA;
- has a SAN containing the current LAN IPv4 address;
- is valid for at most 30 days;
- uses an ECDSA P-256 key;
- is regenerated when absent, expired, invalid, or missing the current IP SAN.

The CA is valid for at most one year. An invalid or expired CA causes startup to
fail closed rather than silently replacing a CA already trusted by other
devices.

### 7.3 Device setup

Each LAN device performs a one-time trust setup:

1. download the CA certificate from port 9080;
2. compare the displayed SHA-256 fingerprint;
3. install and explicitly trust the CA;
4. open the HTTPS Admin or Member URL.

Platform-specific trust instructions are displayed without embedding secrets.

## 8. Preview Lifecycle

### 8.1 Start

`scripts/member-preview-lan-up.sh`:

1. verifies `Admin-YR`, `youran`, the approved repository/worktree, and branch;
2. starts or validates the existing loopback Preview Gateway;
3. discovers and validates the private LAN address;
4. validates ports 9080 and 9443 are unused or exactly owned;
5. prepares or validates CA and leaf material;
6. writes a protected isolated Nginx configuration;
7. starts Nginx without changing the system service;
8. validates the Nginx PID, start time, cwd, argv, configuration fingerprint,
   certificate fingerprint, and exact listeners;
9. performs HTTP CA and trusted HTTPS health/Admin/Member probes;
10. confirms the 8790 health bytes, Docker identity, and listener are unchanged;
11. prints only public URLs, the CA fingerprint, and fixed readiness messages.

### 8.2 Stop

`scripts/member-preview-lan-down.sh`:

1. validates the same ownership manifest and exact listeners;
2. terminates only the owned Nginx process through pidfd;
3. removes only the still-matching manifest and generated non-secret Nginx
   runtime files;
4. leaves the CA, leaf certificate, protected handoffs, Gateway database, and
   loopback Preview intact;
5. confirms 8790 is unchanged.

Stopping the base Preview remains a separate explicit action.

## 9. Failure Handling

Startup fails closed with fixed non-secret errors when:

- no private LAN IPv4 exists;
- a LAN port is occupied by an unowned process;
- Nginx is absent or its configuration test fails;
- a protected runtime path is a symlink or non-regular file;
- permissions cannot be tightened;
- the CA or leaf certificate fails validation;
- the leaf SAN does not match the current LAN address;
- the Gateway is unhealthy;
- the proxy cannot verify its exact process ownership;
- trusted HTTPS probes fail;
- the 8790 baseline changes.

The Admin UI maps API failures to fixed user-safe messages and never renders raw
response bodies, stack traces, credentials, or database details.

## 10. Testing Strategy

Implementation follows strict RED-GREEN TDD.

### 10.1 Gateway tests

- development `/admin` redirects to `/admin/`;
- development Admin HTML and every Admin asset return 200 with strict headers;
- `test` and `production` Admin routes and assets return 404;
- `/` still redirects to `/member/` in every Gateway mode;
- Member routes and assets remain unchanged;
- Admin initialization, restored-session, missing-session, member creation,
  pairing display, revoke, expiry, and secret-redaction behavior are covered
  through the real browser adapter boundary.

### 10.2 Script and TLS tests

- private-address discovery and rejection of public/ambiguous addresses;
- CA and leaf generation, permissions, validity, fingerprint, and IP SAN;
- reuse of a valid CA and leaf rotation after an address change;
- exact Nginx configuration and configuration fingerprint;
- no system Nginx mutation;
- occupied/unowned port failure;
- exact manifest ownership, PID reuse defense, and pidfd termination;
- HTTP serves only the CA certificate;
- HTTPS root redirects to Admin and proxies Admin, Member, API, and SSE;
- Admin handoff writes only a `0600` protected file and prints only its path;
- hostile fragments and malformed protected files fail closed;
- logs and reports exclude all credential and pairing sentinels.

### 10.3 Real-runtime acceptance

On `Admin-YR`:

1. start the LAN Preview;
2. verify 8790 is unchanged;
3. install/trust the CA on the Mac;
4. open the protected Admin handoff;
5. confirm family management is visible;
6. generate a fresh member pairing;
7. use a clean browser profile to claim it through the LAN HTTPS Member URL;
8. verify Member Chat and Work load;
9. verify the database contains one claimed device, one personal binding, and
   one claim session for that pairing;
10. verify logout/resume and device removal;
11. leave the approved LAN Preview running for direct user experience.

Automated browser evidence and direct user-visible evidence are reported
separately. A missing browser-control connection must never be represented as a
successful visual run.

## 11. Acceptance Criteria

The work is complete only when:

- opening `https://192.168.110.84:9443/` reaches Admin Web;
- `/admin/` and `/member/` use the same 8791 database;
- an authorized administrator can add a member and visibly generate a short
  code and browser QR;
- a trusted LAN browser can claim the code and enter Member Chat and Work;
- an unauthorized browser cannot perform Admin operations;
- Admin assets are unavailable outside development mode;
- the default loopback-only Preview behavior remains unchanged;
- CA private material and all entry/pairing credentials stay out of output,
  logs, Git, and reports;
- full focused tests, Gateway typecheck, static checks, certificate checks, and
  real TLS probes pass;
- 8790 remains byte-, Docker-, and listener-identical across the exercise;
- changes are independently reviewed, committed, and fast-forward merged
  locally without deleting the retained worktree or pushing remotely.
