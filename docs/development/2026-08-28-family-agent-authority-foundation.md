# Family Agent authority foundation — isolated verification evidence

Verified on 2026-08-29 without deployment. This document covers the foundation only; it is not a production-release or deployment-readiness claim.

## Source identity and quality gate

- Implementation range: `04ee3b19bdc42bb53189e3af064bd999e6ada54d..c02f291ff4726f834acd0f28ae7a0bd9d4b29484`.
- Exact artifact and acceptance source: `c02f291ff4726f834acd0f28ae7a0bd9d4b29484`.
- The source worktree was clean before artifact generation and acceptance.
- Fresh `npm ci`: exit 0, 143 packages installed; the existing audit result remained 1 moderate and 1 high vulnerability.
- Fresh `npm run check`: exit 0.
  - Contracts: 8 files, 84 passed.
  - Provider Adapter SDK: 6 files, 57 passed.
  - Agent Broker: 4 files, 54 passed.
  - Gateway: 88 files, 868 passed.
  - Script tests: 4 passed.
  - Failures, cancellations, and skipped tests: 0.
  - Static deployment/public-repository checks, typechecks, and builds passed.
- Fresh `git diff --check`: exit 0.
- The image build repeated the full gate inside its pinned Node 22.16.0 build environment. It passed 867 Gateway tests and intentionally skipped only the real-OS pidfd/listener test under `FAMILY_AI_CONTAINER_BUILD=1`; that same test ran and passed in the zero-skip host gate.

## Immutable build artifacts

Durable root:

`/home/youran/data/artifacts/family-agent-authority-foundation/c02f291ff4726f834acd0f28ae7a0bd9d4b29484`

### Gateway

- Path: `gateway/`.
- Contract: exactly `gateway-image.tar`, `gateway-image.tar.sha256`, and `gateway-image-manifest.json`, all mode 0600.
- Manifest kind: `gateway-image-v1`.
- Image ID: `sha256:ec58ee9a18891aa67c4ef77938e1b322aac8c321736de98ebecb37a03cda09e3`.
- Archive SHA-256: `4524d198c6e0d8d3f6d170a77f1873f4efded5451ad329a64eff28a35e488c1a`.
- Build-input tree hash: `ed510a620a99902ddf8fe8d6cf2102ff355afe41f89a8bfd20acf2b068224c94`.
- Release-input manifest SHA-256: `2b77d3fd58679bca6c471611f3f8af295f1a33a321fbc1f2ffdacba05aed2dfb`.
- Capability receipt SHA-256: `dfc7ae48fe484734d6fb5a673eb238750353314b458ab45dc5917e9ca3030703`.
- Pinned base: `node:22.16.0-bookworm-slim` on `linux/amd64`, digest `sha256:1471ea646673136b8308550ac14b36d847ffb21c24bc31828279e443c924e488`.
- Client database version: 2. Gateway migration replay through V12 passed in the full gate.
- The revision, input-tree, capability, client-version, base-digest, platform, snapshot, and toolchain labels matched the manifest. The archive sidecar replayed successfully.
- The image was built and exported only; it was never started as a service.

### Agent Broker

- Path: `broker/`.
- Contract: exactly `agent-broker-source.tar`, `agent-broker-source.tar.sha256`, and `agent-broker-source-manifest.json`, all mode 0600.
- Manifest kind/version: `agent-broker-source-v1` / 1.
- Source selection: 78 regular committed Git blobs only; no symlink, submodule, untracked input, dependency directory, runtime database, log, Home, session, or credential file was selected.
- Archive SHA-256: `db48920914d6c55d1439c462177b04408243ae62cb6f548144c6d75328115908`.
- Selected Git input hash: `90cb1b4c1a1f04f96c0c732ad69b15f5a715f618818bb9b861c9d8986aa97ab9`.
- File-inventory SHA-256: `2ae7da5b6486439df022bd9018ab4ff11552dbcc86b68c69bb1a71b922574005`.
- Artifact toolchain: Node `v22.23.1`, npm `10.9.8`.
- Family, Broker, Contracts, and Provider Adapter SDK package versions: `0.1.0`; federation protocol version: 1.
- The archive sidecar replayed successfully.

## Isolated real HTTP acceptance

The journey used a mode-0700 disposable runtime, a real temporary SQLite file, a real temporary HTTP-over-UDS fake Broker, and an actual Fastify listener on an OS-selected loopback port. It made no real Hermes or model call.

- Canvas and ME service identities plus a Family Entry Cookie each obtained a 204 session context and a safe Agent projection. Spoofed Person, product, and role headers did not change the server-derived identity.
- The family-admin projection contained exactly Jarvis, 于途, and 乔晶晶. The normal-member projection contained only the exact active personal mount.
- Canvas and ME service credentials were denied on all five Agent allocation route shapes, for 10 denials total, without changing assignments.
- Jarvis was invokable for the family administrator and denied to a normal member before the Broker. 于途 and 乔晶晶 followed their exact active mounts.
- First invocation and exact continuation preserved one opaque product session binding. An unbound external reference plus cross-service, cross-product, cross-Person, cross-Agent, and cross-local-session reuse produced six zero-Broker-call denials.
- Two concurrent first calls for one local session produced statuses 200 and 409 and exactly one Broker call.
- Recreating the Broker on the same temporary UDS was rediscovered without restarting Gateway.
- Gateway restart reopened the same synthetic database on a newly resolved random listener, preserved bindings and audit counts, and reauthenticated the Family entry.
- Service, EntrySession, Device, mount, and assignment-version revocation each failed before the Broker.
- Final audit counts contained six succeeded and zero accepted rows. Persisted audit/binding rows contained none of the synthetic prompt, reply, service material, Entry material, Cookie names, or private runtime markers.

## Real browser acceptance

- Preview-auto `/admin/` loaded at 1280×800 and 375×812 with meaningful content, no framework error overlay, no console/page error, and no horizontal mobile overflow.
- Both viewports rendered exactly the Jarvis, 于途, and 乔晶晶 cards with textual runtime and allocation states.
- Jarvis exposed no allocation or default control. Personal add/remove/default controls were enabled and keyboard reachable with `tabIndex=0`.
- Keyboard Enter opened the add menu and assigned 于途. The `aria-live` result was `Agent 配置已更新。`; the refreshed card showed `已分配`, the default selector gained 于途, and shutdown verification found exactly one active personal mount.
- Body text and DOM attributes contained no Home, Profile ID, provider profile, model, key, endpoint, path, token, or Session material.
- `localStorage` and `sessionStorage` both remained empty before and after the mutation.
- Safe screenshots:
  - `evidence/admin-desktop.png`, SHA-256 `2cb22cb8695cd4fab6499e895994e49aeb105510fa8b8775bfaf1984a1ee82fb`.
  - `evidence/admin-mobile.png`, SHA-256 `a5b9bea6c982a5d5b33ec3382315457ee1f40629bc1878d8218621b595812d02`.
- The browser session, isolated listener, fake Broker, SQLite connection, and exact temporary runtime were closed and removed.

## Security and formal-runtime boundary

- Static documentation secret-pattern, deployment, public-repository, and artifact-input checks passed.
- No real model, Hermes Home, production database, real product credential, Tailscale/DNS setting, Compose runtime, systemd unit, or stable listener was used or changed.
- Formal Family before/after identity SHA-256 was identical: `038d2c53e0d1859444156813a40a9de29cf9479eba48cc3d50fb9ebe205132fd`.
- Formal `family-ai-gateway.service` remained loaded but `inactive/dead` with MainPID 0, and port 8790 remained without a listener.
- All acceptance ports were ephemeral; no service-port inventory change was required.
- The superseded `0bc2b3a47027cee698169f47fdd9adeb76b963af` artifact directory and its uniquely labelled, unreferenced image were removed only after the c02 artifacts and browser checks passed.

## Explicitly untested later boundaries

The following remain for later plans: a real Hermes/model canary, systemd unit installation, product deployment, Tailscale/LAN publication, real product credential provisioning, Canvas integration, ME integration, and the forward-only three-product cutover. This foundation evidence does not authorize or assert any of them.
