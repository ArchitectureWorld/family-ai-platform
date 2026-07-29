# Admin Preview Reliability and Repository Consolidation Implementation Plan

> **For Codex:** Execute this plan task by task in the current session. Use the
> test-driven-development and verification-before-completion skills. Do not
> merge `main`, remove a worktree, delete a branch, or touch port 8790 before
> the user approves the final inventory.

**Goal:** Repair Jarvis response handling, hide the internal Preview owner from
member configuration, make the Admin workspace responsive, replace activation
codes with development-only auto-admin access, and produce a verified merge and
cleanup inventory.

**Architecture:** Keep the existing entry-session authorization model. Add only
a development Preview adapter that validates and returns the protected persisted
family-admin entry. Make the Hermes CLI adapter recognize a bounded valid answer
before classifying exit code 1. Keep production Admin Web closed; email/password
is a separate next iteration.

**Tech stack:** Node.js 22, TypeScript, Fastify, better-sqlite3, Vitest, browser
ES modules, CSS, Docker Compose, Nginx, Git worktrees.

**Design:**
`docs/superpowers/specs/2026-07-29-admin-preview-reliability-and-repository-consolidation-design.md`

## Task 1: Preserve Worktree-Only Evidence

**Files:**

- Add: `.superpowers/sdd/2026-07-28-admin-agent-management-system-workspace/task-12-report.md`
- Modify: `.superpowers/sdd/2026-07-28-admin-agent-management-system-workspace/progress.md`

1. Compare the two Task 12 files in
   `family-ai-platform-worktrees/task12-runtime-composition` with the active
   branch copies.
2. Add the missing Task 12 report verbatim.
3. Append only the three missing Task 12 ledger lines to the active progress
   file, preserving every existing line.
4. Run `git diff --check` and compare SHA-256 for the report.
5. Commit only these evidence files:

```bash
git commit -m "docs: preserve task 12 execution evidence"
```

## Task 2: Accept Strictly Valid Hermes Output After Exit 1

**Files:**

- Modify: `packages/provider-adapter-sdk/test/hermesCliProvider.test.ts`
- Modify: `packages/provider-adapter-sdk/src/hermesCliProvider.ts`

1. Extend the fake Hermes executable with cases for:
   - exit 1 plus non-empty answer and exactly one valid session marker;
   - exit 1 with empty output;
   - exit 1 with missing or duplicate markers;
   - exit 1 with a recognized missing-session diagnostic;
   - exit 2 with otherwise valid-looking output.
2. Add a RED test proving only the exit-1 valid payload succeeds and persists
   the exact external session.
3. Run:

```bash
npm run test -w @family-ai/provider-adapter-sdk -- --run test/hermesCliProvider.test.ts
```

4. In `invoke`, classify timeout/abort first, parse the one session marker and
   bounded stdout next, preserve resumed-session equality, then:
   - accept valid output for exit 0 or 1;
   - preserve the specific missing-session failure;
   - map all other non-zero exits to the existing sanitized failures.
5. Rerun the focused test and the complete Provider Adapter SDK test suite.
6. Commit:

```bash
git commit -m "fix: accept valid Hermes partial responses"
```

## Task 3: Keep the Preview Owner Out of Member Configuration

**Files:**

- Modify: `apps/gateway/test/familyOnboarding.test.ts`
- Modify: `apps/gateway/test/agentRoutes.test.ts`
- Modify: `apps/gateway/src/familyDomain.ts`
- Modify: `apps/gateway/src/agentManagement.ts`

1. Add a RED onboarding test proving `GET /api/v1/admin/members` omits the
   active owner while retaining newly created adult, child, and elder members.
2. Add RED mutation tests proving the ordinary Agent mount, unmount, and default
   endpoints reject the owner as not found, while owner Admin workspace
   assignments remain intact.
3. Run the two focused test files.
4. Filter `FamilyDomainRepository.listMembers` to active non-owner memberships.
5. Tighten `AgentManagementRepository.requireActiveMember` to the same
   non-owner boundary. Do not change `ensureOwnerAdminAssignments`.
6. Rerun focused tests plus Admin workspace privacy and Agent route regressions.
7. Commit:

```bash
git commit -m "fix: separate admin owner from member configuration"
```

## Task 4: Replace Preview Activation With Direct Development Access

**Files:**

- Rename: `apps/gateway/src/adminPreviewActivation.ts` to
  `apps/gateway/src/adminPreviewAccess.ts`
- Rename: `apps/gateway/test/adminPreviewActivation.test.ts` to
  `apps/gateway/test/adminPreviewAccess.test.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/test/adminWeb.test.ts`

1. Rewrite the endpoint tests RED-first for:
   - `GET /api/v1/admin/access-mode` returning exactly
     `{ mode: "preview-auto" }` with no-store in configured development;
   - `POST /api/v1/admin/preview-access` returning the validated entry without
     a code;
   - missing, unsafe, invalid, wrong-origin, revoked, and non-admin entries
     failing closed without raw secret material;
   - both routes absent without explicit Preview configuration and in
     production.
2. Run the focused test and observe RED.
3. Remove activation-record parsing, hashing, expiry, and consumption. Retain
   protected absolute regular-file reads, strict schema validation, configured
   loopback origin validation, entry authentication, and `family_admin` check.
4. Register the new access module from `app.ts`; remove the activation module
   registration.
5. Update Admin Web route expectations to prove the code form is absent and
   production Admin Web remains absent.
6. Rerun the focused server tests.
7. Commit:

```bash
git commit -m "feat: open configured development preview to admins"
```

## Task 5: Auto-Enter the Admin Web and Widen Management

**Files:**

- Modify: `apps/gateway/admin-public/admin-api.js`
- Modify: `apps/gateway/admin-public/admin.js`
- Modify: `apps/gateway/admin-public/index.html`
- Modify: `apps/gateway/admin-public/admin.css`
- Modify: `apps/gateway/test/adminWebModules.test.ts`
- Modify: `apps/gateway/test/adminWeb.test.ts`

1. Replace the activation client test with RED tests for strict access-mode and
   direct-access response validation. The POST request must have no credential,
   no code, and no JSON body.
2. Add RED Admin document/module assertions proving:
   - no activation input, form, or one-time-code copy remains;
   - initialized Preview with no stored credential requests direct access;
   - the recovery state contains only a fixed entry-unavailable message;
   - `showAdminState("management")` adds the wide-shell modifier and every
     other state removes it.
3. Update the browser start flow:
   - sanitize forbidden query/fragment material as before;
   - honor a valid bootstrap or stored entry credential;
   - for initialized Preview without an entry, confirm `preview-auto`, request
     direct access, store the validated result only in SessionStorage, and
     render management;
   - fail closed into the fixed recovery state.
4. Remove activation code normalization, handlers, markup, and CSS.
5. Add `.admin-shell.is-management` with a viewport-bounded desktop width up to
   1600 px. Keep 920 px for initialization/onboarding/recovery and retain the
   existing `max-width: 700px` single-column workspace.
6. Run Admin Web module and route tests.
7. Commit:

```bash
git commit -m "fix: streamline responsive admin preview entry"
```

## Task 6: Retire Active Activation Tooling

**Files:**

- Delete: `scripts/member-preview-admin-activate.mjs`
- Modify: `apps/gateway/test/memberPreviewScripts.test.ts`
- Modify: `scripts/static-check.sh`
- Modify: `README.md`
- Modify: `docs/development/2026-07-28-lan-admin-member-experience.md`

1. Add or update RED/static assertions so active scripts and current
   operational documentation no longer tell an operator to generate an Admin
   activation code.
2. Remove the generator and its script tests. Do not rewrite historical
   approved specs/plans from 2026-07-28.
3. Update current Preview instructions: open the Admin LAN URL directly; use the
   separate Member URL and pairing flow for members.
4. Run:

```bash
npm run test -w @family-ai/gateway -- --run test/memberPreviewScripts.test.ts
bash scripts/static-check.sh
git diff --check
```

5. Commit:

```bash
git commit -m "chore: retire preview activation tooling"
```

## Task 7: Focused Regression Gate

Run from the active remote worktree:

```bash
npm run test -w @family-ai/provider-adapter-sdk -- --run test/hermesCliProvider.test.ts
npm run test -w @family-ai/gateway -- --run \
  test/adminPreviewAccess.test.ts \
  test/adminWeb.test.ts \
  test/adminWebModules.test.ts \
  test/familyOnboarding.test.ts \
  test/agentRoutes.test.ts \
  test/adminWorkspacePrivacy.test.ts
npm run typecheck -w @family-ai/provider-adapter-sdk
npm run typecheck -w @family-ai/gateway
git diff --check
```

Fix any failure using a new RED reproduction when the failure is behavioral.
Commit only verified fixes.

## Task 8: Full Repository and Container Gate

1. Confirm the active worktree is clean and port 8790 owner/SHA is unchanged.
2. Run the repository gates required by `AGENTS.md`:

```bash
npm ci
npm run check
docker compose build
```

3. Start or update only the isolated 8791/9443 Preview using the repository's
   approved Preview scripts. Do not stop or restart port 8790.
4. Verify health, TLS, and no public secret/path leakage.

## Task 9: Browser and Real-Agent Acceptance

Using the trusted LAN HTTPS Preview:

1. Open `/admin/` in a fresh browser session with empty SessionStorage and
   confirm it enters management without an activation code.
2. Confirm the member page contains the real members and does not contain
   `Member Web Preview 成员`.
3. At a desktop viewport, measure the shell and workspace width and prove it is
   wider than 920 px while remaining within the viewport.
4. At a phone viewport, prove Jarvis and Codex panes stack.
5. Send two unique turns to Jarvis and two to Codex; prove each Agent keeps its
   own persisted session and returns successful responses.
6. Open `/member/` separately and verify pairing/member entry remains intact.
7. Reconfirm the existing port-8790 process, listener, and active SHA did not
   change.

## Task 10: Produce the Approval Inventory and Stop

Generate a read-only report containing:

- current main and feature SHAs;
- exact commits proposed for merge;
- full automated, Docker, live, responsive, and real-Agent evidence;
- every worktree path, branch, HEAD, dirty count, and patch-equivalence count;
- SHA-256 proof that Task 12 untracked evidence was preserved;
- exact local branches proposed for deletion;
- exact directories proposed for removal;
- explicit exclusions, including any legacy directory and port 8790;
- rollback point and post-merge verification commands.

Present the report to the user and stop. Do not merge, remove, prune, or delete
anything until the user explicitly approves that exact inventory.
