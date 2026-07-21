# Gateway Foundation Verification Record

**Date:** 2026-07-21  
**Branch:** `feat/gateway-foundation`  
**PR:** #2  
**Status:** Draft; not ready to merge

## Scope verified in isolated Node 22 environment

A clean isolated working directory was assembled from the current Foundation implementation and verified with Node.js 22.16.0 and npm 10.9.2.

The environment could access the npm registry but could not download or compile the native `better-sqlite3` binary. Gateway runtime tests therefore used a test-only compatibility wrapper over Node 22 `node:sqlite` with the same prepared statement and transaction calls used by the application. This validates the Gateway schema, SQL, repositories, services, HTTP routes and restart behavior, but it does not replace native-addon and Docker verification on the target Linux host.

## Executed quality gate

```bash
NODE_NO_WARNINGS=1 npm run check
```

Result: exit code 0.

### Tests

| Workspace | Test files | Tests | Result |
|---|---:|---:|---|
| `@family-ai/contracts` | 1 | 7 | PASS |
| `@family-ai/provider-adapter-sdk` | 1 | 2 | PASS |
| `@family-ai/gateway` | 5 | 10 | PASS |
| **Total** | **7** | **19** | **PASS** |

No failed or skipped tests were reported.

The Gateway tests cover:

- numbered migration reopening;
- foreign-key validation;
- development bootstrap not overwriting device state or Token Hash;
- local-only configuration;
- strict development-console headers;
- device authentication;
- member and Agent conversation isolation;
- two-turn Fake Provider continuity;
- authorization before idempotency lookup;
- identical request replay;
- same key with different request conflict;
- restart history recovery;
- Provider continuation to turn three after restart.

### Static deployment checks

```bash
bash scripts/static-check.sh
```

Result: PASS.

Verified:

- all shell scripts parse with `bash -n`;
- Compose publishes only `127.0.0.1:8790:8790`;
- `.runtime/` is ignored;
- runtime acceptance reports are ignored;
- project source/configuration does not contain legacy database names or historical absolute deployment paths.

### Type checking

All workspace TypeScript checks passed:

```text
@family-ai/contracts
@family-ai/provider-adapter-sdk
@family-ai/gateway
```

### Build

All workspace builds passed:

```text
@family-ai/contracts
@family-ai/provider-adapter-sdk
@family-ai/gateway
```

## Scripted end-to-end acceptance

The exact repository commands were executed against a real local Gateway HTTP process:

```bash
./scripts/dev-reset.sh --yes
./scripts/dev-up.sh
./scripts/acceptance.sh
./scripts/dev-down.sh
```

Because Docker is not available in the isolated environment, a test-only Compose-compatible command adapter implemented only `version`, `up`, `down`, `restart`, `ps`, `logs` and `exec` by starting and restarting the built Gateway process directly. No repository code was changed for this adapter.

This verifies the scripts' argument flow, generated runtime files, actual HTTP requests, SQLite persistence, Gateway restart behavior, report generation and error handling. It does not prove the Dockerfile or Compose engine behavior.

All twelve acceptance steps passed:

| Step | Result |
|---|---|
| Health | PASS |
| Device authentication | PASS |
| Create conversation | PASS |
| First message | PASS |
| Second message | PASS |
| History before restart | PASS |
| Idempotent replay | PASS |
| Idempotency conflict | PASS |
| Cross-Agent rejection | PASS |
| Restart history recovery | PASS |
| Post-restart continuation | PASS |
| Final history | PASS |

Observed results:

- first response: `Fake Provider 第 1 轮回复。`;
- second response: `Fake Provider 第 2 轮回复。`;
- history before restart: four messages;
- restart recovered the four messages;
- first response after restart: `Fake Provider 第 3 轮回复。`;
- final history: six messages.

The generated Markdown report was scanned and contained no actual device Token, Bearer credential, `/tmp/` path or `/home/` path.

Runtime permissions were verified:

| Path | Mode |
|---|---:|
| `.runtime/` | `700` |
| `.runtime/config/` | `700` |
| `.runtime/data/` | `700` |
| `.runtime/config/device-token` | `600` |
| `.runtime/config/gateway.env` | `600` |
| `.runtime/config/compose.env` | `600` |

## Dependency lock

A new lockfile was generated from the new repository manifests only. It contains the three current workspaces and no legacy Control Center workspace. Because the current connector cannot reliably upload the generated 110 KB lockfile, it remains a required target-host step before the PR can become Ready:

```bash
npm install
npm run check
git add package-lock.json
git commit -m "chore: lock Gateway foundation dependencies"
git push
npm ci
npm run check
```

The old repository lockfile must not be copied.

## Remaining mandatory verification

The PR must remain Draft until the target Linux/Docker environment records all of the following:

```bash
npm install
npm run check
docker compose build
./scripts/dev-reset.sh --yes
./scripts/dev-up.sh
./scripts/acceptance.sh
```

Manual browser acceptance must then confirm:

1. identity loads without exposing the Token;
2. a new conversation can be created;
3. first response is `Fake Provider 第 1 轮回复。`;
4. second response is `Fake Provider 第 2 轮回复。`;
5. refresh restores four messages;
6. container restart restores history;
7. the next response after restart is `Fake Provider 第 3 轮回复。`;
8. the page displays no SQL, stack trace, secret or local path.

## GitHub Actions limitation

GitHub Actions currently fails before workflow steps start and produces no usable job output or artifact. This is treated as unavailable CI infrastructure, not as code success or code failure. Local Linux/Docker evidence is required before merge.

## Merge decision

Do not mark PR #2 Ready and do not merge it until native `better-sqlite3`, Docker build, one-click deployment, scripted acceptance and browser acceptance have current successful evidence.
