# Family AI Platform Development Roadmap

## Current execution overlay — 2026-08-16

本路线图描述产品能力顺序，不等于部署清单。A1–A5 发布基线整改已合入；当前 `main` 已包含 Stage 1–7 的多项源码能力和 development-only Admin/LAN Preview，但正式 `127.0.0.1:8790` 仍是旧 Compose、Schema V3、Fake-only 运行物。源码、自动化、隔离 Preview 与正式部署的逐项矩阵见 [`2026-08-16-current-platform-truth.md`](2026-08-16-current-platform-truth.md)。

下一阶段仍先完成 B/C/D/E 的安全与恢复 Gate，再由 F1 单独批准正式升级；不得因本路线图某项源码已存在而跳过发布依赖。Stage 8 当前 development LAN Preview 不是正式 LAN 能力，B4 仍要求先收口为 `disabled-verified`。

## Stable product direction

Family AI Platform has one Gateway core and multiple clients. Admin Entry is a privileged client of the same Gateway, not a separate control-plane product. New platform data starts empty; no legacy business data is imported.

## Stage 0 — Repository foundation

Deliverables:

- product and architecture specification;
- repository development rules;
- first Gateway implementation plan;
- direct-to-main PR workflow;
- explicit legacy code/data boundaries.

Acceptance: documentation has no conflicting architecture statements, no legacy data migration scope, and no placeholder decisions.

## Stage 1 — Local Gateway vertical slice

Deliverables:

- npm workspace and quality gate;
- contracts package;
- Provider Adapter SDK with Fake Provider;
- SQLite migrations and clean database;
- test device authentication;
- member-Agent binding;
- isolated conversations and messages;
- safe idempotency;
- restart history recovery.

Acceptance: test, typecheck, build, two-turn journey, restart recovery, cross-Agent denial, and idempotency conflict all pass.

## Stage 2 — Unified identity and RBAC

Deliverables:

- member credentials;
- `member`, `family_admin`, and `system_admin` roles;
- service-side permission policy;
- separate member/admin session audiences;
- typed audit events;
- `/api/member/*`, `/api/device/*`, and `/api/admin/*` boundaries.

Acceptance: ordinary members cannot access Admin APIs or other members’ resources; administrator access does not automatically expose private message bodies.

## Stage 3 — Device lifecycle

Deliverables:

- persistent browser sessions;
- owner-approved pairing;
- one-time claim completion;
- device list and revocation;
- session rotation based only on active sessions;
- rate limits and Origin protection.

Acceptance: claim replay fails, revoked devices cannot authenticate after restart, and all active sessions for a revoked device are invalidated.

## Stage 4 — Provider integrations

Deliverables:

- Hermes Adapter;
- Codex Adapter;
- explicit environment allowlist;
- timeout, output limit, cancellation, process-group termination, and concurrency controls;
- Provider health and safe error mapping.

Acceptance: no Gateway secrets enter Provider processes; timeout and termination journeys pass without orphaned processes.

## Stage 5 — Member Entry

Deliverables:

- ordinary member login;
- default personal-assistant experience;
- conversation creation and recovery;
- device self-management;
- responsive browser UI.

Acceptance: a non-technical user can log in, send two turns, refresh, recover history, and sign out without seeing internal Agent or Provider configuration.

## Stage 6 — Admin Entry

Deliverables:

- member, role, device, Agent, binding, Provider, health, and audit management;
- sensitive-operation confirmation;
- Admin API only; no direct database access.

Acceptance: all management actions are authorized and audited, while private member conversations remain protected by policy.

## Stage 7 — Attachments

Deliverables:

- controlled storage;
- explicit attachment states;
- hash and path validation;
- recoverable deletion and compensation;
- Provider attachment resolver.

Acceptance: Provider failures are retryable without corrupting attachment state; database and filesystem remain reconcilable.

## Stage 8 — Controlled LAN access

Deliverables:

- explicit LAN configuration;
- HTTPS/TLS;
- trusted-origin policy;
- deployment and rollback documentation;
- real mobile-browser acceptance.

Acceptance: loopback remains the default, LAN exposure requires explicit configuration, and no public internet exposure is introduced.

## Stage 9 — Native clients and additional terminals

Order:

1. iOS personal entry;
2. HarmonyOS personal entry;
3. multi-device synchronization;
4. family public voice terminal;
5. watches, displays, ESP32, television, vehicle, and other controlled terminals.

Each stage starts from the latest `main`, uses one independent branch and one PR, and must be merged before the next dependent stage begins.
