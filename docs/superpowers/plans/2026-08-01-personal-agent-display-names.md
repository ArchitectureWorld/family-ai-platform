# Personal Agent Display Names Implementation Plan

> **Required sub-skill:** Use `superpowers:executing-plans` to execute this plan task by task. Use `superpowers:test-driven-development` for Tasks 1 and 2 and `superpowers:verification-before-completion` before reporting completion.

**Goal:** Present Hermes personal Agents consistently as `于途` and `乔晶晶` throughout the Admin and Member experiences while keeping the internal profile names, Agent refs, Provider refs, session history, assignments, and routing unchanged.

**Architecture:** Keep identity and presentation separate. `buildProviderRuntime()` remains the server-owned source of the Agent catalog and applies a narrow allowlist from normalized Hermes profile identifiers to display names. Catalog reconciliation propagates those display names to existing rows on Gateway startup. The Member renderer receives the selected catalog display name when rendering a thread, so a concrete Assistant message is attributed to the selected Agent rather than the generic role label.

**Tech Stack:** Node.js 22, TypeScript, browser ES modules, Vitest, SQLite, repository Preview scripts.

**Deployment boundary:** Work only in `/home/youran/Development/family-ai-platform` on `Admin-YR` through `ssh admin-yr`. The user explicitly approved direct execution on the canonical `main` checkout. Preview ports `8791/9080/9443` may be refreshed; formal port `8790` must remain untouched and byte-for-byte comparable at the health boundary.

---

## Task 1: Map personal Hermes profiles to catalog display names

**Files:**

- Modify: `apps/gateway/test/config.test.ts`
- Modify: `apps/gateway/src/config.ts`

- [ ] **Step 1: Add literal behavior expectations before implementation**

Update `composes deterministic Agent and Provider refs for every real runtime` so the expected catalog entries are:

```ts
{
  agentRef: "agent:hermes-zzh",
  displayName: "于途",
  providerProfileRef: "provider-profile:hermes-zzh",
  providerKind: "hermes"
},
{
  agentRef: "agent:hermes-nsy",
  displayName: "乔晶晶",
  providerProfileRef: "provider-profile:hermes-nsy",
  providerKind: "hermes"
}
```

Keep the existing invocation assertions proving the Hermes adapter still receives `-p zzh`. Add an unmapped profile fixture such as `zzg` and assert its display name falls back to `zzg` while its refs remain deterministic.

The mutation caught by this test is either exposing the internal abbreviation again or accidentally changing the internal route/profile identity while renaming the UI.

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
npx vitest run apps/gateway/test/config.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: the catalog equality fails because production still returns `zzh` and `nsy`.

- [ ] **Step 3: Implement the smallest server-owned mapping**

Add a private, immutable mapping near `buildProviderRuntime()`:

```ts
const PERSONAL_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  zzh: "于途",
  nsy: "乔晶晶"
};

function personalAgentDisplayName(profileName: string): string {
  return PERSONAL_AGENT_DISPLAY_NAMES[profileName] ?? profileName;
}
```

Use only this helper for `ConfiguredAgentRuntime.displayName` in the personal Hermes profile loop:

```ts
displayName: personalAgentDisplayName(profileName)
```

Do not alter `agentRef`, `providerProfileRef`, `profileName`, `cwd`, environment, or Hermes invocation arguments.

- [ ] **Step 4: Run the focused test and observe GREEN**

Run the same focused Vitest command. Expected: all `config.test.ts` tests pass.

- [ ] **Step 5: Review the diff for identity preservation**

Run:

```bash
git diff -- apps/gateway/src/config.ts apps/gateway/test/config.test.ts
```

Confirm the only runtime behavior change is `displayName`, with `zzh/nsy/zzg` still used internally.

## Task 2: Attribute concrete Assistant messages to the selected Agent

**Files:**

- Modify: `apps/gateway/test/memberRenderLifecycle.test.ts`
- Modify: `apps/gateway/member-public/render.js`

- [ ] **Step 1: Add a real-renderer failing test**

Change the `mountedAgents` fixture's `agent:hermes-zzh` display name to `于途` and update the selected-Agent workspace expectations accordingly. Extend the state with a real Assistant message:

```ts
messagesByThread: {
  "thread:chat-0001": [{
    messageRef: "message:assistant-0001",
    actor: { type: "assistant" },
    content: { text: "我来继续处理。" },
    occurredAt: "2026-07-25T10:01:00.000Z"
  }]
}
```

Assert the rendered `.message-meta` text and message-selection accessible label identify `于途`. Switch to Codex and assert a render of the same actor type identifies `Codex`, proving the label follows the current Agent rather than being hard-coded.

The mutation caught by this test is a static `个人助理` sender label or a stale label after Agent switching.

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
npx vitest run apps/gateway/test/memberRenderLifecycle.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: the workspace name assertions pass from fixture data, but the concrete Assistant message still renders `个人助理`.

- [ ] **Step 3: Pass selected display name through the rendering boundary**

Change the helper boundaries to accept the concrete selected Agent display name:

```js
function actorLabel(message, agentName) {
  switch (message.actor?.type) {
    case "person": return "你";
    case "assistant": return agentName ?? "个人助理";
    case "agent": return agentName ?? "执行 Agent";
    case "system": return "系统";
    default: return "消息";
  }
}
```

Pass `input.agentName` from `renderThread()` into `messageNode()`, and from both Chat and Work `renderThread()` calls using the already-derived `agentName`. Use the same value for visible message metadata and selection `aria-label`. Preserve the generic fallback when no Agent is selected.

- [ ] **Step 4: Run the focused test and observe GREEN**

Run the same focused Vitest command. Expected: all member renderer lifecycle tests pass.

- [ ] **Step 5: Run both behavior suites together**

Run:

```bash
npx vitest run apps/gateway/test/config.test.ts apps/gateway/test/memberRenderLifecycle.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: both suites pass and switching Agent updates every concrete identity surface.

## Task 3: Verify catalog reconciliation, regression suite, and isolated Preview

**Files:**

- Verify: `apps/gateway/test/agentManagement.test.ts`
- Verify: `apps/gateway/test/adminAgentModules.test.ts`
- Verify: `apps/gateway/test/memberPreviewScripts.test.ts`
- Verify: `scripts/member-preview-up.sh`
- Verify: `scripts/member-preview-lan-up.sh`

- [ ] **Step 1: Capture the formal service baseline without mutating it**

Record to a temporary evidence directory outside Git:

```bash
curl --fail --silent --show-error http://127.0.0.1:8790/health | sha256sum
docker ps --no-trunc --format '{{.ID}} {{.Image}} {{.Names}} {{.Ports}}'
ss -H -ltnp '( sport = :8790 )'
```

- [ ] **Step 2: Run the full repository gate**

Run:

```bash
npm run check
```

Expected: tests, static checks, typechecking, and builds all succeed.

- [ ] **Step 3: Confirm the diff contains no internal-identity migration**

Run:

```bash
git diff --check
git diff --stat
git grep -n -E 'agent:hermes-(zzh|nsy)|provider-profile:hermes-(zzh|nsy)|profileName' -- apps/gateway/src/config.ts apps/gateway/test/config.test.ts
```

Expected: internal identifiers remain and no database migration, assignment rewrite, history rewrite, or session reset exists.

- [ ] **Step 4: Refresh only the isolated Preview**

Run:

```bash
./scripts/member-preview-lan-down.sh
./scripts/member-preview-lan-up.sh
curl --fail --silent --show-error http://127.0.0.1:8791/health
```

The scripts may restart only repository-owned Preview processes on `8791/9080/9443`.

- [ ] **Step 5: Verify reconciled state and user-visible pages**

Read the protected Preview database path from the repository's own Preview configuration without printing credentials. Query the Agent catalog and confirm:

```text
agent:hermes-zzh | 于途   | provider-profile:hermes-zzh
agent:hermes-nsy | 乔晶晶 | provider-profile:hermes-nsy
agent:hermes-zzg | zzg    | provider-profile:hermes-zzg
```

Verify `/admin/` and `/member/` through the Preview endpoint. In a real browser, confirm:

- Admin catalog/mount controls show `于途` and `乔晶晶`.
- Member Agent selector, current-Agent card, Chat/Work titles, placeholders, and concrete Assistant reply labels show the selected display name.
- Switching between the personal Agent and Codex immediately changes the main workspace identity and reply attribution.
- Existing conversations/assignments remain available.

Hermes may still be upgrading, so availability is recorded separately from display-name acceptance; do not change Hermes configuration as part of this task.

- [ ] **Step 6: Prove formal service isolation**

Repeat the port `8790` health hash, exact Docker row, and listener capture. Expected: identical to Step 1.

- [ ] **Step 7: Commit the implementation, then stop for merge/push approval**

Run:

```bash
git add apps/gateway/src/config.ts apps/gateway/test/config.test.ts apps/gateway/member-public/render.js apps/gateway/test/memberRenderLifecycle.test.ts
git commit -m "fix: show personal Agent display names"
git status --short --branch
git log --oneline --decorate -3
```

Report the exact test results, Preview result, formal-service comparison, and commits. Do not push until the user approves the verified implementation.

## Self-review checklist

- [ ] Every visible concrete Agent identity uses catalog `displayName`.
- [ ] Assistant reply sender labels update after an Agent switch.
- [ ] `zzh`, `nsy`, and `zzg` remain internal runtime/profile identifiers.
- [ ] Unknown Hermes profiles retain safe identifier fallback.
- [ ] Existing catalog reconciliation updates names without database migrations.
- [ ] Generic role copy remains only where no concrete Agent identity exists.
- [ ] No formal `8790` process, container, configuration, or data is changed.
- [ ] No unrelated files or user changes are committed.
