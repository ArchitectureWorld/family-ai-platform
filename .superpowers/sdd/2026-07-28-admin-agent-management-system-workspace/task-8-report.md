# Task 8 Report — Member Web Agent Selection and Per-Agent Projection

## Scope and remote identity

- Host: `Admin-YR` via `ssh admin-yr`
- Worktree: `/home/youran/Development/family-ai-platform-worktrees/task8-member-agent-ui`
- Branch: `feat/admin-agent-task8`
- Base: `3892561432949bf862f6d8c51a1195ba213a22a7`
- Production was not started, restarted, or modified.

## Delivered

- Added deterministic initial Agent selection: a still-mounted temporary device choice wins, otherwise the mounted server default is used, otherwise the member gets the exact selection-required or unconfigured empty state.
- Added desktop Agent chips and a mobile selector with public text-and-color status only (`空闲`, `工作中`, `有问题`). No provider profile, assignment internals, session reference, active-turn detail, or private problem detail is rendered.
- Chat and Work list/create requests now carry the selected `agentRef`. Chat, Work, selected Work, drafts, outgoing state, and cached projections are isolated by Agent.
- Agent switching clears the visible projection before asynchronous cache/API work and guards every asynchronous boundary so a late response from the previous Agent cannot flash or overwrite the selected Agent.
- Broadcast cache reload and Sync event application project only the selected Agent while still advancing the shared durable event cursor.
- Personal Portal context is refreshed every five seconds. If the current Agent is unmounted, the current projection is cleared immediately, the temporary selection is discarded, and the bounded selector fallback is shown without deleting the other Agent caches.
- Added the new static module route and responsive Member Web markup/styles for desktop, mobile, and Windows-oriented layouts.

## TDD evidence

RED was observed before each implementation slice:

1. `memberAgentSelector.test.ts` failed because `agent-selector.js` did not exist.
2. API/cache/controller tests failed on missing Agent query/body parameters, missing per-Agent Work replacement, and controllers omitting `agentRef`.
3. `memberProductFlow.test.ts` failed against the stale Web Entry context route; the client was moved to the strict Personal Portal context.
4. The late Thread page race test resolved and projected stale data before Agent selection guards were added.

GREEN after implementation:

- Focused and adjacent regression bundle:
  - `npx vitest run apps/gateway/test/memberAgentSelector.test.ts apps/gateway/test/memberControllers.test.ts apps/gateway/test/memberProductFlow.test.ts apps/gateway/test/memberWeb.test.ts apps/gateway/test/memberWebModules.test.ts apps/gateway/test/memberCacheModel.test.ts apps/gateway/test/memberRenderLifecycle.test.ts apps/gateway/test/memberProductWorkbenchLifecycle.test.ts apps/gateway/test/memberIdentityCache.test.ts apps/gateway/test/memberPersistenceReview.test.ts apps/gateway/test/memberThreadHistory.test.ts apps/gateway/test/memberSecretBoundary.test.ts`
  - Result: **12 files passed, 121 tests passed**.
- Gateway typecheck:
  - `npm run typecheck -w @family-ai/gateway`
  - Result: passed.
- Static verification:
  - `node --check` for every changed/new Member Public JS module and `git diff --check`
  - Result: passed.

The task-requested npm command was also executed:

- `npm run test -w @family-ai/gateway -- memberAgentSelector.test.ts memberControllers.test.ts memberProductFlow.test.ts`
- Because the existing workspace script expands this into `vitest run test ...`, it ran the entire Gateway suite rather than only the three requested files.
- Result: **675 passed, 13 failed**. All Task 8 focused files passed. The remaining failures are outside this task surface: existing V6 multi-Agent migration setup, legacy Web Entry route assertions, SSE/Work setup, and load-sensitive Preview/fixture timeouts.

## Files

- Added:
  - `apps/gateway/member-public/agent-selector.js`
  - `apps/gateway/test/memberAgentSelector.test.ts`
- Updated:
  - Member Public API/cache/controllers/product/render/HTML/CSS modules
  - `apps/gateway/src/memberWeb.ts`
  - focused Member Web test harness, controller, flow, rendering, web-route, and secret-boundary tests

## Concerns

- The repository-wide Gateway command is not fully green on this base because it unintentionally includes unrelated failing suites noted above. Task 8 focused tests, adjacent regression tests, syntax checks, diff checks, and Gateway typecheck are green.
