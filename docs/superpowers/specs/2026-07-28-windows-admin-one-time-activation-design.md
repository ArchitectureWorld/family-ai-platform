# Windows Admin One-Time Activation Design

Date: 2026-07-28
Status: approved for implementation

## 1. Objective

Let an administrator who opens the existing trusted LAN Admin Web on a new
Windows browser enter the Family AI management console without copying or
disclosing the long-lived administrator entry credential.

The operator experience is:

1. Codex generates a new `XXXXX-XXXXX` activation code after the updated Preview
   is live.
2. Codex sends that short-lived code to the user in the active conversation,
   together with its exact expiration time.
3. The user enters the code in the current `/admin/` recovery page.
4. The page exchanges the code once over the existing trusted HTTPS origin and
   enters family management automatically.
5. The user can then select a family member and generate that member's separate
   five-minute pairing code.

The activation code must not be left only on the Linux host. Sending it to the
user is a required part of operational acceptance.

## 2. Current State and Root Cause

The Windows screenshot proves that the LAN address, TLS proxy, Admin Web route,
HTML, CSS, and JavaScript all load successfully. The page shows
`无法验证管理员身份` because an initialized Preview currently accepts an
administrator credential only from:

- a protected URL fragment generated on the Linux host; or
- the current browser tab's SessionStorage.

A new Windows browser has neither. The member pairing code is intentionally
available only after administrator authentication, so it cannot appear on the
recovery page.

## 3. Considered Approaches

### 3.1 Recommended: one-time activation-code exchange

Generate a short-lived random code, store only its salted hash, exchange it once
for the already persisted administrator entry, and keep the returned credential
only in the Windows tab's SessionStorage.

This preserves the existing entry-session authorization model, avoids
transmitting long-lived credentials in chat, and adds only a development Preview
recovery path.

### 3.2 Rejected: send the protected administrator URL

This is mechanically smaller but exposes a long-lived bearer credential in chat
history, clipboard history, screenshots, and browser history. It does not meet
the security boundary.

### 3.3 Rejected: introduce an administrator password

This creates a second persistent authentication system, password storage and
recovery requirements, and production-facing product decisions that are not
needed for LAN Preview access.

## 4. Scope

### In scope

- a development-only one-time activation exchange endpoint;
- a protected activation-record file beside the existing protected Admin entry;
- a script that generates a cryptographically random activation code;
- a recovery-page form for entering the activation code;
- browser SessionStorage handoff after successful exchange;
- explicit expired, invalid, unavailable, and already-used responses;
- automated API, browser-module, script, file-safety, and secret-leak tests;
- live deployment and Windows-facing code delivery through the active
  conversation.

### Out of scope

- production account recovery;
- internet exposure;
- a persistent administrator password;
- changing the existing member pairing protocol;
- exposing the long-lived administrator URL or token;
- storing the activation code in browser localStorage, URL query parameters,
  access logs, or repository files;
- changing or restarting the existing port 8790 service.

## 5. Components and Data Flow

### 5.1 Activation generator

`scripts/member-preview-admin-activate.mjs` generates ten symbols from the
existing unambiguous Preview alphabet and formats them as `XXXXX-XXXXX`. Ten
base-32 symbols provide 50 bits of entropy.

The script:

- resolves the existing `.runtime-preview/config` directory through the same
  protected runtime helpers used by other Preview scripts;
- verifies that the persisted `admin-entry.json` is a regular non-symlink file
  with mode `0600`;
- creates a random salt and stores only the salt plus SHA-256 code hash;
- writes `admin-activation.json` atomically with mode `0600`;
- sets `createdAt` and `expiresAt`, with a five-minute lifetime;
- prints only the activation code and expiration time, never the Admin entry,
  URL fragment, or token.

Generating a new code atomically replaces any unused earlier activation record,
making the earlier code invalid.

### 5.2 Development-only exchange endpoint

The Gateway registers:

```text
POST /api/v1/admin/preview-activation
```

only when all existing Admin Preview persistence requirements are present:

- Gateway mode is `development`;
- the protected Admin entry path is explicitly configured;
- the loopback Preview origin is explicitly configured.

The request body is exactly:

```json
{ "code": "XXXXX-XXXXX" }
```

The endpoint derives `admin-activation.json` from the configured Admin entry
directory, so no additional environment variable is required.

For every request, it:

1. validates the exact JSON shape and activation-code format;
2. opens regular protected files without following symlinks;
3. checks the activation version and timestamps;
4. recomputes the salted code hash and compares it with constant-time equality;
5. validates the persisted Admin entry schema;
6. authenticates that entry through `EntrySessionAuthenticator` and requires the
   `family_admin` audience;
7. atomically consumes the activation record;
8. returns the validated entry credential once.

The response is `Cache-Control: no-store`. A correct code cannot be replayed.
Wrong codes do not consume a valid record. Expired records cannot be exchanged.
The route remains absent in test and production modes.

### 5.3 Admin Web recovery form

The existing `recovery-required` state gains:

- one activation-code input;
- an `激活管理员设备` submit button;
- status text for progress and errors.

The browser normalizes lower-case input to upper case but still sends only the
strict `XXXXX-XXXXX` format. On success it validates the returned credential
with the existing `validateAdminCredential`, stores it in SessionStorage, and
loads the management view. It does not put the activation code or credential in
the URL or localStorage.

The form maps endpoint outcomes to concise Chinese messages:

- malformed or wrong code: `激活码不正确，请检查后重试。`
- expired code: `激活码已过期，请生成新码。`
- already used or missing record: `当前没有可用的激活码，请生成新码。`
- invalid persisted Admin entry: `管理员入口已失效，请重新启动预览。`
- network or invalid response: `暂时无法激活，请检查连接后重试。`

## 6. Security Properties

- The long-lived Admin entry never appears in conversation output, script
  stdout, command logs, URLs, QR codes, HTML, or source files.
- Only the five-minute one-time activation code is sent to the user.
- The Linux activation record contains no plaintext activation code.
- The activation record and Admin entry are regular non-symlink files with mode
  `0600` under the Preview-owned configuration directory.
- Comparisons use constant-time hash equality.
- Successful exchange consumes the record before another exchange can succeed.
- All browser exchange traffic uses the already trusted LAN HTTPS origin.
- Existing Content Security Policy, no-referrer, no-store, and frame-denial
  headers remain unchanged.
- This mechanism is not registered in production.

## 7. Testing and Verification

Automated tests must first fail for the missing behavior, then pass after the
minimal implementation.

Coverage includes:

- a correct code exchanges for the authenticated family-admin entry once;
- a second exchange of the same code fails;
- wrong and malformed codes fail without returning credential material;
- expired activation records fail;
- invalid or revoked Admin entries fail;
- symlinked or incorrectly permissioned activation/Admin files fail closed;
- the route is absent without explicit development configuration;
- the script writes only a salted hash with mode `0600`;
- script stdout contains the short code and expiry but no long-lived token;
- Admin API client performs a public no-credential exchange and strictly
  validates its response;
- Admin recovery markup and module behavior expose the intended form;
- static secret checks continue to reject token or protected-URL output;
- the repository passes focused tests followed by full `npm run check`.

Live acceptance on `admin-yr` includes:

1. confirm the updated Gateway and isolated Nginx listeners;
2. confirm the HTTPS Admin page and activation endpoint through port 9443;
3. generate a fresh activation code only after the live deployment is ready;
4. immediately send the code and exact expiration time to the user in the active
   conversation;
5. have the user enter the code on Windows and confirm the family management
   view appears;
6. generate a member pairing code from the management view;
7. confirm the activation code cannot be reused.

## 8. Acceptance Criteria

The work is complete only when:

- Windows can enter the management console from the ordinary LAN `/admin/` page
  by typing the delivered one-time activation code;
- Codex has sent that code to the user rather than leaving it only on Linux;
- the code is valid for five minutes at generation and succeeds only once;
- no long-lived administrator secret has been exposed;
- the user can reach the member list and generate a separate member pairing
  code;
- focused tests and full `npm run check` are green;
- the updated live Preview is verified on `admin-yr`.
