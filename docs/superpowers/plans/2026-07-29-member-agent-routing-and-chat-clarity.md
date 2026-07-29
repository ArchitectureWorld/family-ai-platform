# Member Agent Routing and Chat Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Family AI invoke every Hermes Agent with its own profile configuration, clearly identify the selected Agent in the member workspace, and implement standard chat keyboard behavior.

**Architecture:** Keep the existing Hermes CLI adapter and session-resume flow, but remove the gateway's global model/provider override so Hermes resolves those values from each `HERMES_HOME`. Derive the member workspace identity from `context.mountedAgents` plus `currentAgentRef`, and route all keyboard sends through the existing form submit path with an IME guard.

**Tech Stack:** Node.js 22, TypeScript, JavaScript ES modules, Vitest, HTML/CSS, Bash, Fastify, Hermes Agent CLI.

## Global Constraints

- Execute every Linux command through `ssh admin-yr`; the verified target must be `youran@Admin-YR`.
- Modify only `/home/youran/Development/family-ai-platform`, branch `main`; do not use a legacy checkout or create another worktree.
- Write a failing test and observe the intended failure before every production behavior change.
- Preserve Hermes profile selection with `HERMES_HOME` and `-p <profile>`.
- Preserve the existing `externalSessionRef` and `--resume` session continuation.
- Do not read, print, copy, or commit provider keys, device credentials, pairing material, or Hermes session identifiers.
- Deploy first to preview ports 8791/9080/9443; do not restart, rebuild, or mutate the official service on port 8790.
- Do not add ACP, direct multiplex-gateway transport, authentication changes, detailed monitoring, or per-Agent themes.

## File Map

- `apps/gateway/src/config.ts`: validates and builds the real provider runtime.
- `apps/gateway/test/config.test.ts`: proves the runtime no longer requires or exposes a global Hermes route override.
- `scripts/member-preview-up.sh`: writes the protected preview gateway environment.
- `apps/gateway/test/memberPreviewScripts.test.ts`: locks the exact protected environment contract.
- `apps/gateway/member-public/index.html`: declares the current-Agent identity container.
- `apps/gateway/member-public/member.css`: styles the compact identity badge without changing the workspace theme.
- `apps/gateway/member-public/render.js`: renders selected-Agent copy and handles composer keys.
- `apps/gateway/test/helpers/memberBrowserHarness.ts`: models the added DOM node and `isComposing` keyboard state.
- `apps/gateway/test/memberRenderLifecycle.test.ts`: verifies visible identity and real keyboard submission behavior.
- `apps/gateway/test/memberWebModules.test.ts`: locks the public page structure and accessibility contract.

---

### Task 1: Let Hermes Profiles Own Their Model Routing

**Files:**
- Modify: `apps/gateway/test/config.test.ts`
- Modify: `apps/gateway/test/memberPreviewScripts.test.ts`
- Modify: `apps/gateway/src/config.ts`
- Modify: `scripts/member-preview-up.sh`

**Interfaces:**
- Consumes: `HermesCliProviderOptions.profileName?: string` and the existing
  `ProviderAdapterRouter`; the adapter's already-tested `--resume` behavior is
  unchanged.
- Produces: `RealGatewayProviderRuntimeConfig.hermes` with exactly `executable`, `jarvisHome`, `personalHome`, and `profiles`; Jarvis has no profile flag, while personal Agents keep `-p <profile>`.

- [ ] **Step 1: Write failing configuration tests**

Remove `FAMILY_AI_HERMES_MODEL` and `FAMILY_AI_HERMES_PROVIDER` from
`realEnvironment()`. Change the real-runtime expectation to:

```ts
expect(loadGatewayConfig(valid).providerRuntime).toMatchObject({
  mode: "real",
  hermes: {
    executable: fixture.executable,
    jarvisHome: fixture.jarvisHome,
    personalHome: fixture.personalHome,
    profiles: ["zzh", "nsy"]
  },
  codex: {
    executable: fixture.executable,
    workingDirectory: fixture.codexWorkingDirectory
  }
});
```

Keep only executable and directory variables in the missing-input rejection
loop:

```ts
for (const key of [
  "FAMILY_AI_HERMES_EXECUTABLE",
  "FAMILY_AI_CODEX_EXECUTABLE"
]) {
  const env = { ...valid };
  delete env[key];
  expect(() => loadGatewayConfig(env)).toThrow("runtime configuration");
}
```

Replace the obsolete unsafe-identifier test with a regression proving stale
override variables cannot affect the runtime:

```ts
it("ignores stale global Hermes model routing overrides", () => {
  const runtime = loadGatewayConfig({
    ...realEnvironment(),
    FAMILY_AI_HERMES_MODEL: "deepseek-v4-flash --quiet",
    FAMILY_AI_HERMES_PROVIDER: "SenseNova"
  }).providerRuntime;

  expect(runtime).toMatchObject({ mode: "real" });
  if (runtime.mode !== "real") throw new Error("real runtime expected");
  expect(runtime.hermes).not.toHaveProperty("model");
  expect(runtime.hermes).not.toHaveProperty("provider");
});
```

- [ ] **Step 2: Write a failing built-runtime invocation test**

Extend `runtimeFixture()` with an executable that records only argv and returns
a valid Hermes-shaped result:

```ts
const invocationLog = join(root, "invocations.jsonl");
writeFileSync(executable, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(
  ${JSON.stringify(invocationLog)},
  JSON.stringify(process.argv.slice(2)) + "\\n"
);
process.stdout.write("Profile native reply");
process.stderr.write("session_id: profile_native_session_42\\n");
`, { mode: 0o700 });
```

Return `invocationLog` from the fixture and add the following test. Use
`readFileSync` from `node:fs`.

```ts
it("builds Jarvis and personal invocations without global route overrides", async () => {
  const fixture = runtimeFixture();
  const runtime = buildProviderRuntime(
    loadGatewayConfig(realEnvironment(fixture)).providerRuntime
  );
  const baseRequest = {
    protocolVersion: "1.0" as const,
    invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f31",
    correlationRef: "correlation:018f47a2-1f10-7a3d-8c2d-61f369284f32",
    idempotencyKey: "device:test:message:routing",
    requestedAt: "2026-07-29T08:00:00.000Z",
    targetAgentRef: "agent:test",
    conversationRef: "conversation:018f47a2-1f10-7a3d-8c2d-61f369284f33",
    content: [{ type: "text" as const, text: "route probe" }],
    timeoutMs: 2_000
  };

  for (const providerProfileRef of [
    "provider-profile:hermes-jarvis",
    "provider-profile:hermes-zzh"
  ]) {
    await runtime.router.resolve(providerProfileRef).invoke({
      ...baseRequest,
      providerProfileRef
    });
  }

  const [jarvisArgs, zzhArgs] = readFileSync(
    fixture.invocationLog,
    "utf8"
  ).trim().split("\n").map(line => JSON.parse(line) as string[]);

  for (const args of [jarvisArgs, zzhArgs]) {
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--provider");
  }
  expect(jarvisArgs).not.toContain("-p");
  expect(zzhArgs).toContain("-p");
  expect(zzhArgs).toContain("zzh");
});
```

Do not change `hermesCliProvider.test.ts`; its existing continuation case
continues to prove `--resume` is carried forward.

- [ ] **Step 3: Write failing preview-environment tests**

In `memberPreviewScripts.test.ts`, remove the two global override names from
the expected provider key lists and expected generated environment. Add:

```ts
expect(up).not.toContain("FAMILY_AI_HERMES_MODEL");
expect(up).not.toContain("FAMILY_AI_HERMES_PROVIDER");
expect(gatewayEnvironment.some(line =>
  line.startsWith("FAMILY_AI_HERMES_MODEL=")
)).toBe(false);
expect(gatewayEnvironment.some(line =>
  line.startsWith("FAMILY_AI_HERMES_PROVIDER=")
)).toBe(false);
```

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
cd /home/youran/Development/family-ai-platform
npm exec vitest -- run \
  apps/gateway/test/config.test.ts \
  apps/gateway/test/memberPreviewScripts.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because `config.ts` still requires and exposes `model/provider`,
and `member-preview-up.sh` still writes both variables.

- [ ] **Step 5: Remove the gateway-level override**

Change the Hermes runtime type in `config.ts` to:

```ts
hermes: {
  executable: string;
  jarvisHome: string;
  personalHome: string;
  profiles: readonly string[];
};
```

Build it without route values:

```ts
hermes: {
  executable: existingExecutable(env.FAMILY_AI_HERMES_EXECUTABLE),
  jarvisHome: existingDirectory(env.FAMILY_AI_HERMES_JARVIS_HOME),
  personalHome: existingDirectory(env.FAMILY_AI_HERMES_PERSONAL_HOME),
  profiles: profileNames(env.FAMILY_AI_HERMES_PROFILES)
},
```

Delete `hermesModel()` and `hermesProvider()`. In both
`new HermesCliProviderAdapter(...)` calls, omit `model` and `provider`.
Preserve `profileName` only inside the personal-profile loop.

- [ ] **Step 6: Remove the override from preview configuration**

Delete the two `builtin printf` lines, the two expected-key entries, and the
two value assertions for:

```text
FAMILY_AI_HERMES_MODEL
FAMILY_AI_HERMES_PROVIDER
```

Keep every path, token, permission, ownership, and atomic-write validation
unchanged.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the command from Step 4.

Expected: all selected test files PASS with no warnings or secret material in
the output.

- [ ] **Step 8: Run type and static gates**

Run:

```bash
npm run typecheck
npm run test:scripts
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit the routing fix**

```bash
git add \
  apps/gateway/src/config.ts \
  apps/gateway/test/config.test.ts \
  apps/gateway/test/memberPreviewScripts.test.ts \
  scripts/member-preview-up.sh
git commit -m "fix: respect Hermes profile model routing"
```

---

### Task 2: Make the Selected Agent Obvious and Fix Composer Keys

**Files:**
- Modify: `apps/gateway/member-public/index.html`
- Modify: `apps/gateway/member-public/member.css`
- Modify: `apps/gateway/member-public/render.js`
- Modify: `apps/gateway/test/helpers/memberBrowserHarness.ts`
- Modify: `apps/gateway/test/memberRenderLifecycle.test.ts`
- Modify: `apps/gateway/test/memberWebModules.test.ts`

**Interfaces:**
- Consumes: `state.context.mountedAgents`, `state.currentAgentRef`,
  `publicAgentStatus(agent)`, `actions.send(target, text)`, and native form
  submission.
- Produces: DOM node `#currentAgentIdentity`; helper
  `selectedAgent(state)` returning the mounted Agent or `null`; keyboard helper
  support for `isComposing`.

- [ ] **Step 1: Extend only the test harness**

Add `currentAgentIdentity: "div"` to the harness tag map. Append it to
`workspaceView` in the harness and set
`currentAgentIdentity: "workspaceView"` in `parentById`, matching the nearest
real ancestor with an ID.

Add `placeholder = ""` to the fake element class so the TypeScript harness can
observe dynamic textarea placeholders.

Extend the keyboard event helper without changing existing call sites:

```ts
dispatchKeyboard(
  type: string,
  key: string,
  shiftKey = false,
  isComposing = false,
) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey },
    isComposing: { value: isComposing },
  });
  this.dispatchEvent(event);
  return event;
}
```

Expose the fourth argument:

```ts
key(id: string, key: string, shiftKey = false, isComposing = false) {
  return nodes[id].dispatchKeyboard(
    "keydown",
    key,
    shiftKey,
    isComposing,
  );
}
```

- [ ] **Step 2: Write the failing selected-Agent rendering test**

Add a fixture with zzh and Codex:

```ts
const mountedAgents = [
  {
    assignmentRef: "assignment:zzh",
    agentRef: "agent:hermes-zzh",
    displayName: "zzh",
    providerProfileRef: "provider-profile:hermes-zzh",
    isDefault: true,
    status: "idle",
    statusLabel: "空闲",
  },
  {
    assignmentRef: "assignment:codex",
    agentRef: "agent:codex-cli",
    displayName: "Codex",
    providerProfileRef: "provider-profile:codex-cli",
    isDefault: false,
    status: "working",
    statusLabel: "工作中",
  },
];
```

Then verify reactive copy:

```ts
it("makes the selected Agent explicit throughout the main workspace", () => {
  const harness = createMemberDocumentHarness();
  const store = createStore(memberState({
    context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
    currentAgentRef: "agent:hermes-zzh",
  }));
  const renderer = createRenderer({
    store,
    actions: memberActions(),
    documentRef: harness.document,
  });

  expect(harness.elements.currentAgentIdentity.textContent)
    .toContain("当前 Agentzzh空闲");
  expect(harness.elements.workspaceTitle.textContent).toBe("和 zzh 继续聊");
  expect(harness.elements.messageInput.placeholder).toBe("给 zzh 发消息…");

  store.setState({ currentAgentRef: "agent:codex-cli" });

  expect(harness.elements.currentAgentIdentity.textContent)
    .toContain("当前 AgentCodex工作中");
  expect(harness.elements.workspaceTitle.textContent).toBe("和 Codex 继续聊");
  expect(harness.elements.messageInput.placeholder).toBe("给 Codex 发消息…");
  expect(harness.elements.workMessageInput.placeholder)
    .toBe("让 Codex 继续推进当前 Work…");
  renderer.destroy();
});
```

- [ ] **Step 3: Write failing Chat and Work keyboard tests**

Add this table-driven test:

```ts
it.each([
  ["chat", "messageInput"],
  ["work", "workMessageInput"],
] as const)(
  "submits %s with Enter but not Shift+Enter, IME Enter, or empty Enter",
  async (target, inputId) => {
    const harness = createMemberDocumentHarness();
    const actions = memberActions();
    const renderer = createRenderer({
      store: createStore(memberState({
        context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
        currentAgentRef: "agent:hermes-zzh",
      })),
      actions,
      documentRef: harness.document,
    });

    harness.input(inputId, "第一行");
    const shifted = harness.key(inputId, "Enter", true);
    expect(shifted.defaultPrevented).toBe(false);

    const composing = harness.key(inputId, "Enter", false, true);
    expect(composing.defaultPrevented).toBe(false);
    expect(actions.send).not.toHaveBeenCalled();

    harness.elements[inputId].value = "   ";
    harness.key(inputId, "Enter");
    await harness.whenIdle();
    expect(actions.send).not.toHaveBeenCalled();

    harness.elements[inputId].value = "发送内容";
    const entered = harness.key(inputId, "Enter");
    expect(entered.defaultPrevented).toBe(true);
    await harness.whenIdle();
    expect(actions.send).toHaveBeenCalledOnce();
    expect(actions.send).toHaveBeenCalledWith(target, "发送内容");
    renderer.destroy();
  },
);
```

- [ ] **Step 4: Lock the new public structure**

In `memberWebModules.test.ts`, require:

```ts
'id="currentAgentIdentity"'
```

In the real-index/harness parity test, update the expected ID count from 73 to
74.

- [ ] **Step 5: Run focused tests and verify RED**

Run:

```bash
npm exec vitest -- run \
  apps/gateway/test/memberRenderLifecycle.test.ts \
  apps/gateway/test/memberWebModules.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because the public HTML and renderer do not yet provide
`currentAgentIdentity`, dynamic Agent copy, or the IME guard.

- [ ] **Step 6: Add the current-Agent identity container**

Place this as the first child of `.header-actions` inside the existing
workspace header, immediately before `#syncStatus`, without moving the Agent
configuration UI:

```html
<div class="workspace-agent-identity unselected"
     id="currentAgentIdentity"
     aria-live="polite">
  <span class="agent-status-dot" aria-hidden="true"></span>
  <span>当前 Agent</span>
  <strong>尚未选择</strong>
</div>
```

Add compact CSS:

```css
.workspace-agent-identity {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 32px;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
}

.workspace-agent-identity.unselected {
  color: var(--muted);
}

.workspace-agent-identity.idle .agent-status-dot {
  background: #47745a;
  box-shadow: 0 0 0 3px rgba(71, 116, 90, 0.12);
}

.workspace-agent-identity.working .agent-status-dot {
  background: #ad8b52;
  box-shadow: 0 0 0 3px rgba(173, 139, 82, 0.12);
}

.workspace-agent-identity.problem .agent-status-dot {
  background: #a34f45;
  box-shadow: 0 0 0 3px rgba(163, 79, 69, 0.12);
}
```

Reuse the existing `idle`, `working`, and `problem` status class names and
matching status-dot colors; do not introduce a per-Agent theme.

- [ ] **Step 7: Render identity, title, and placeholders from one Agent**

Add:

```js
function selectedAgent(state) {
  return (state.context?.mountedAgents ?? [])
    .find((agent) => agent.agentRef === state.currentAgentRef) ?? null;
}

function renderCurrentAgent(documentRef, state) {
  const agent = selectedAgent(state);
  const identity = $(documentRef, "currentAgentIdentity");
  clear(identity);
  identity.className = `workspace-agent-identity ${agent?.status ?? "unselected"}`;
  identity.append(element(documentRef, "span", "agent-status-dot"));
  identity.append(element(documentRef, "span", "", "当前 Agent"));
  identity.append(element(
    documentRef,
    "strong",
    "",
    agent?.displayName ?? "尚未选择",
  ));
  if (agent) {
    identity.append(element(
      documentRef,
      "span",
      "agent-status",
      publicAgentStatus(agent),
    ));
  }
  return agent;
}
```

At the start of `render(state)`, call it once and derive every visible string
from the returned Agent:

```js
const currentAgent = renderCurrentAgent(documentRef, state);
const agentName = currentAgent?.displayName ?? null;

$(documentRef, "workspaceTitle").textContent = section === "chat"
  ? agentName ? `和 ${agentName} 继续聊` : "和个人助理继续聊"
  : agentName ? `使用 ${agentName} 推进重要事项` : "持续推进重要事项";
$(documentRef, "messageInput").placeholder = agentName
  ? `给 ${agentName} 发消息…`
  : "给个人助理发消息…";
$(documentRef, "workMessageInput").placeholder = agentName
  ? `让 ${agentName} 继续推进当前 Work…`
  : "在当前 Work 中继续…";
```

- [ ] **Step 8: Add the IME guard while preserving form submission**

Change only the key condition:

```js
if (
  event.key === "Enter" &&
  !event.shiftKey &&
  !event.isComposing
) {
  event.preventDefault();
  form.requestSubmit();
}
```

Do not duplicate `actions.send()` in the key handler. Empty text remains
rejected by the existing submit handler.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run the command from Step 5.

Expected: both files PASS, including Chat and Work keyboard cases.

- [ ] **Step 10: Run the complete gateway test suite**

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 11: Commit the member experience fix**

```bash
git add \
  apps/gateway/member-public/index.html \
  apps/gateway/member-public/member.css \
  apps/gateway/member-public/render.js \
  apps/gateway/test/helpers/memberBrowserHarness.ts \
  apps/gateway/test/memberRenderLifecycle.test.ts \
  apps/gateway/test/memberWebModules.test.ts
git commit -m "fix: clarify selected member Agent"
```

---

### Task 3: Full Verification, Preview Acceptance, and Synchronization

**Files:**
- Verify only; no new production files.

**Interfaces:**
- Consumes: the two implementation commits, preview lifecycle scripts, the
  member web entry, zzh Hermes Profile, and Codex CLI Agent.
- Produces: full-green test evidence, preview acceptance evidence, unchanged
  official-service evidence, and aligned local/tracking/GitHub SHAs.

- [ ] **Step 1: Record the untouched official-service baseline**

Run through SSH:

```bash
curl --fail --silent --show-error http://127.0.0.1:8790/health
ss -ltnp | grep -E ':8790[[:space:]]'
docker ps --filter publish=8790 \
  --format '{{.ID}}|{{.Image}}|{{.Ports}}'
```

Record the health response hash, listener, container ID, and image ID without
printing environment variables or credentials.

- [ ] **Step 2: Run every repository gate**

```bash
cd /home/youran/Development/family-ai-platform
npm run check
git diff --check
git status --short
```

Expected: contracts, adapter, gateway, script, typecheck, and build gates all
pass; the worktree is clean.

- [ ] **Step 3: Rebuild only the preview**

```bash
cd /home/youran/Development/family-ai-platform
./scripts/member-preview-up.sh
curl --fail --silent --show-error http://127.0.0.1:8791/health
ss -ltnp | grep -E ':(8791|9080|9443)[[:space:]]'
```

Expected: the preview health endpoint succeeds and all three preview listeners
are present. Do not call the official deployment or Compose lifecycle.

- [ ] **Step 4: Verify the protected preview route configuration**

Read only key names from `.runtime-preview/config/gateway.env` and assert:

```text
FAMILY_AI_HERMES_PROFILES
FAMILY_AI_HERMES_EXECUTABLE
FAMILY_AI_HERMES_JARVIS_HOME
FAMILY_AI_HERMES_PERSONAL_HOME
```

are present, while:

```text
FAMILY_AI_HERMES_MODEL
FAMILY_AI_HERMES_PROVIDER
```

are absent. Never print any environment values.

- [ ] **Step 5: Perform member-browser acceptance**

Using the current member entry:

1. Select zzh and verify the main badge says `当前 Agent zzh 空闲` or its live
   status, the title says `和 zzh 继续聊`, and the placeholder names zzh.
2. Send a unique harmless prompt with Enter and verify a real zzh reply arrives
   without `PROVIDER_UNAVAILABLE`.
3. Press Shift+Enter and verify the draft remains in the textarea with a
   newline and no message is sent.
4. Exercise Chinese IME Enter and verify it confirms composition without
   sending.
5. Select Codex and verify badge, title, and placeholder all change before
   sending.
6. Send a unique harmless Codex prompt and verify a real Codex reply arrives.

Do not display or copy cookies, device credentials, pairing material, or
external Hermes session IDs.

- [ ] **Step 6: Prove port 8790 was not changed**

Repeat Step 1. Expected: the health response hash, listener ownership,
container ID, and image ID are identical to the baseline.

- [ ] **Step 7: Synchronize GitHub only after acceptance**

```bash
cd /home/youran/Development/family-ai-platform
git status --short
git push origin main
git rev-parse HEAD
git rev-parse '@{u}'
git ls-remote --heads origin main
```

Expected: the worktree is clean and local `HEAD`, upstream, and GitHub `main`
all resolve to the same full SHA.

- [ ] **Step 8: Report the experience path**

Report:

- the member entry URL already used for acceptance;
- the selected-Agent cues to look for;
- Enter, Shift+Enter, and IME behavior;
- successful zzh and Codex evidence;
- full gate results;
- unchanged port 8790 evidence;
- final synchronized SHA.
