# Admin Preview Reliability and Repository Consolidation Design

Date: 2026-07-29
Status: direction approved; document review pending

## 1. Objective

Make the current LAN Preview directly usable by the administrator, repair the
Jarvis false failure, remove Preview-only identity noise, let the system
workspace use the display width, and prepare a safe consolidation into the one
non-legacy project directory.

The repository must not be merged or any worktree removed until the user has
reviewed an exact merge-and-removal inventory.

## 2. Confirmed Product Decisions

- Development LAN Preview opens `/admin/` directly as the administrator.
- Anyone who can reach that LAN Preview Admin URL receives administrator access;
  the user explicitly accepts this development-only security boundary.
- The ordinary Member Web remains a separate entry and pairing flow.
- Production must never inherit Preview auto-admin access.
- The future production Admin Web authentication method is email plus password.
  Other convenient methods are deferred.
- The current change does not ship a partial production login: production Admin
  Web is currently absent and remains closed until the complete email/password
  authentication feature is designed and implemented.
- `family-ai-platform-legacy` is a separate historical project and is not
  merged into, renamed as, or deleted with the non-legacy project.

## 3. Current Evidence and Root Causes

### 3.1 Jarvis false failure

Hermes quiet single-query mode can print a non-empty final response and a valid
`session_id` marker, then exit with code 1 when its result carries a failed
flag. The current Family AI adapter returns `PROVIDER_UNAVAILABLE` for every
non-zero exit code before parsing either output. A real response is therefore
discarded and the UI shows Jarvis as broken.

### 3.2 Preview owner appears as a member

The Preview bootstrap creates an internal owner named `Member Web Preview 成员`.
The Admin member projection currently returns every active family membership,
including the owner used by the administrator entry. That internal identity is
then rendered as if it were an ordinary configurable member.

### 3.3 Workspace width is capped

The outer `.admin-shell` has a fixed maximum width of 920 px. After state-card
padding, the two-column workspace has about 790 px at a 1280 px viewport. The
grid is responsive, but its parent prevents it from using the display.

### 3.4 Activation is unnecessary for accepted Preview trust

The five-minute activation flow was designed to protect the persisted Admin
entry from other LAN users. The new product decision explicitly trusts every
device that can reach the development LAN Preview, so the code form adds friction
without preserving a required boundary.

### 3.5 Multiple directories are Git worktrees, not duplicate products

`/home/youran/Development` contains one non-legacy main checkout and one parent
directory holding eleven linked worktrees. Every worktree branch has zero unique
patches relative to the active feature branch. One worktree has two untracked
SDD records that must be preserved before removal.

## 4. Chosen Design

### 4.1 Jarvis adapter: validate the payload before classifying the exit

The Hermes adapter will parse stdout and the stderr session marker before making
the final status decision.

A run is accepted only when all of the following are true:

1. stdout contains a non-empty response within the existing output bound;
2. stderr contains exactly one syntactically valid Hermes session marker;
3. the marker passes the existing external-session validation;
4. execution did not time out and was not aborted;
5. stderr does not contain a recognized credential, resume, or startup failure.

Exit code 0 keeps the existing success path. Exit code 1 may be accepted only
when the strict valid-output conditions above hold. Other non-zero codes and any
ambiguous or malformed output remain `PROVIDER_UNAVAILABLE`. No automatic retry
is added, so a user message cannot be submitted twice.

This is intentionally an adapter compatibility fix. Hermes upstream behavior
can be optimized separately later.

### 4.2 Member projection: exclude the administrator owner

The Admin member-management query will return configurable non-owner family
members only. The owner row, entry binding, administrator workspace, sessions,
and historical data remain intact. No production data is deleted or renamed.

Agent assignment APIs continue to validate that a target is an active member.
They additionally reject owner targets from the ordinary member-mount surface,
so hiding the card cannot be bypassed by calling the UI endpoint directly.

### 4.3 Responsive management shell

Initialization, onboarding, and recovery cards keep the readable narrow shell.
The management state receives a wide modifier capped by the viewport rather
than 920 px, with a practical desktop maximum of 1600 px and stable side
gutters.

The system workspace remains a balanced two-column layout on wide screens.
Existing narrow-screen behavior stacks the panes vertically. The member page
also benefits from the wider shell without changing its card semantics.

### 4.4 Development Preview auto-admin

The Admin page first asks a public, non-secret access-mode endpoint how access is
configured. In explicitly configured development Preview mode it calls a
same-origin auto-entry endpoint. The endpoint:

- is registered only in `development` with the existing protected Admin entry
  path and loopback Preview origin;
- reads the regular mode-0600 Admin entry without following symlinks;
- validates the exact stored shape and configured origin;
- authenticates the entry and requires `family_admin`;
- returns only the validated credential with `Cache-Control: no-store`.

The activation-code input, exchange client, generator script, runtime activation
record, and live acceptance instructions are retired from the active Preview
workflow. Historical design documents remain as history.

The route is absent in test and production unless a test directly constructs
the development configuration. Production continues to serve no Admin Web in
this change, so there is no accidental fallback to auto-admin.

### 4.5 Production email/password boundary

Before production Admin Web can be enabled, a separate approved design must
cover at minimum:

- normalized unique administrator email identity;
- memory-hard salted password hashing and constant-time verification;
- first-run credential creation and password rotation;
- bounded login attempts and non-enumerating errors;
- secure authenticated browser session creation, expiry, logout, and revocation;
- recovery and audit behavior;
- migration and end-to-end production-mode tests.

Preview credentials, activation records, and auto-entry routes are forbidden as
production authentication. Email/password is the only approved first production
method; passkeys, magic links, OAuth, and other methods are deferred.

## 5. Repository Consolidation Procedure

Implementation stays in
`/home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening`
until all gates pass.

Before requesting merge approval:

1. preserve the two untracked Task 12 SDD records in the active feature branch;
2. list the feature commits that would enter `main`;
3. list every linked worktree, branch, HEAD, cleanliness state, and patch-equivalence result;
4. list every exact directory and local branch proposed for removal;
5. prove no proposed branch has a unique patch relative to the feature branch;
6. show the full test, build, live Preview, and rollback evidence.

Only after the user approves that inventory:

1. merge the feature branch into `main` in the main checkout;
2. rerun the release gate from the main checkout;
3. switch the isolated Preview to the verified main checkout without touching
   the existing port-8790 service;
4. remove only the approved clean or preserved linked worktrees;
5. delete only the approved patch-equivalent local task branches;
6. prune Git worktree metadata;
7. remove the empty `family-ai-platform-worktrees` parent;
8. verify the sole non-legacy project directory is
   `/home/youran/Development/family-ai-platform`.

Any new dirty state, unique commit, failed gate, or path mismatch stops cleanup
and returns to review. No legacy directory is in the removal set.

## 6. Testing and Acceptance

Tests are written red-first for each behavior:

- Hermes exit 1 with a valid response and one valid session marker succeeds;
- non-zero Hermes failures, malformed markers, empty output, timeout, and abort
  still fail closed;
- Admin member projection excludes owners while retaining real members;
- owner mount mutations are rejected;
- the management state applies the wide responsive layout and mobile stack;
- development auto-entry succeeds with a valid protected Admin entry;
- unsafe, missing, revoked, wrong-origin, and non-admin entries fail closed;
- Preview auto-entry and Admin Web remain absent from production mode;
- activation UI and active generator references are gone;
- existing member pairing, Admin workspace, SSE, privacy, static, and secret
  boundaries remain green.

Live acceptance on `admin-yr` must prove:

- Windows and phone can open the LAN Admin URL without an activation code;
- the management page shows only real configurable members;
- Jarvis and Codex both accept at least two turns in their own persisted sessions;
- the workspace expands on a desktop viewport and stacks on a phone viewport;
- Member Web remains separate and functional;
- port 8790 remains unchanged.

## 7. Completion Boundary

Passing implementation tests is not permission to merge or delete. The change
pauses after producing the exact inventory and evidence requested by the user.
Merge and cleanup require a new explicit approval.
