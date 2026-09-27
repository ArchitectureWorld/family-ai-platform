# Family Agent authority foundation — isolated verification evidence

Verified on 2026-08-29 without deployment. This document covers the foundation only; it is not a production-release or deployment-readiness claim.

## Source identity and quality gate

- Implementation range: `04ee3b19bdc42bb53189e3af064bd999e6ada54d..67e6bcafec84df72d67a62384048fb821a39c841`.
- Exact artifact and acceptance source: `67e6bcafec84df72d67a62384048fb821a39c841`.
- The source worktree was clean before artifact generation and acceptance.
- Fresh `npm ci`: exit 0, 143 packages installed; the existing audit result remained 1 moderate and 1 high vulnerability.
- Fresh `npm run check`: exit 0.
  - Contracts: 8 files, 84 passed.
  - Provider Adapter SDK: 6 files, 57 passed.
  - Agent Broker: 4 files, 54 passed.
  - Gateway: 88 files, 874 passed.
  - Script tests: 4 passed.
  - Failures, cancellations, and skipped tests: 0.
  - Static deployment/public-repository checks, typechecks, and builds passed.
- Fresh `git diff --check`: exit 0.
- The image build repeated the full gate inside its pinned Node 22.16.0 build environment. It passed 873 Gateway tests and intentionally skipped only the real-OS pidfd/listener test under `FAMILY_AI_CONTAINER_BUILD=1`; that same test ran and passed in the zero-skip host gate.

## Immutable build artifacts

Durable root:

`/home/youran/data/artifacts/family-agent-authority-foundation/67e6bcafec84df72d67a62384048fb821a39c841`

### Gateway

- Path: `gateway/`.
- Contract: exactly `gateway-image.tar`, `gateway-image.tar.sha256`, and `gateway-image-manifest.json`, all mode 0600.
- Manifest kind: `gateway-image-v1`.
- Image ID: `sha256:4bebcec4146801997b59d54d11687b93c2f393f978dcd3ae70f6a7314d23330e`.
- Archive SHA-256: `4cbde980476492013ca7feffcaa7a44aeac84aa8bccd9d90f3f2ee148df861f6`.
- Build-input tree hash: `0e951043a609275d2238fba4ed699e9c2f6c024339277476dfde1e5533c78174`.
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
- Archive SHA-256: `51509ad4083d8d341fc90c068b6a9f64ad8f7456b76c07563de5bd09cc8efd63`.
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
- The Broker-mode Admin system workspace contained exactly one Jarvis assignment; 于途 and 乔晶晶 were absent from that system workspace, while the owner could use 于途 as a personal Agent.
- Direct personal mount and default selection of Jarvis were denied before Broker access. A deliberately inserted historical Jarvis personal assignment was also denied by Personal Chat before Broker access.
- Two further Gateway restarts reconciled the historical rows idempotently: one active Jarvis system Admin assignment, zero active Jarvis personal assignments, and the owner's active 于途 personal assignment remained.
- The safe HTTP receipt recorded six Broker calls, six succeeded and zero accepted audit rows, and only aggregated HTTP status counts.

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
- Shutdown verification found one active personal mount, one active Jarvis system Admin assignment, and zero active Jarvis personal assignments. The browser session, isolated listener, fake Broker, SQLite connection, and exact temporary runtime were closed and removed.

## Safe evidence receipts

Every receipt and screenshot below is mode 0600 under `evidence/`. `evidence-manifest.json` binds their SHA-256 values and the Gateway/Broker artifact manifests; its own SHA-256 is `834ba4506365a2f75869d85c767970f02121b9a9d463ab39c7ccb76b5319518f`.

- `quality-gate.json`: `871ad70cba081145f4e487b5bddf2d71f3b445b1a737d00706a3c81bb30afe19`.
- `http-acceptance.json`: `bfe1b861fae79c5ae9d38f21c4d3d9ffa531650aa85d12cbea0f6469a291983f`.
- `browser-acceptance.json`: `4dfa89b339a0a2ca75600e600a439d0730538bed34c31e65e65b044c6b52b6c5`.
- `formal-runtime-before-after.json`: `1eb4b6fb446ab371508996e188b6793cf10755d304296b6ee856d3fd60a1f635`.
- `admin-desktop.png`: `2cb22cb8695cd4fab6499e895994e49aeb105510fa8b8775bfaf1984a1ee82fb`.
- `admin-mobile.png`: `a5b9bea6c982a5d5b33ec3382315457ee1f40629bc1878d8218621b595812d02`.
- Gateway manifest: `9e5d43d9d310e54ba63d0eab648ac6ad06e34b9a4915a6f47c87f3f0532fd749`.
- Broker manifest: `9d273b5e69118aea2714b3d4e07b9f61eff3b2bdabf3e3d50d61162642ee769c`.

## Security and formal-runtime boundary

- Static documentation secret-pattern, deployment, public-repository, and artifact-input checks passed.
- No real model, Hermes Home, production database, real product credential, Tailscale/DNS setting, Compose runtime, systemd unit, or stable listener was used or changed.
- Formal Family before/after identity SHA-256 was identical: `038d2c53e0d1859444156813a40a9de29cf9479eba48cc3d50fb9ebe205132fd`.
- Formal `family-ai-gateway.service` remained loaded but `inactive/dead` with MainPID 0, and port 8790 remained without a listener.
- All acceptance ports were ephemeral; no service-port inventory change was required.
- The superseded `c02f291ff4726f834acd0f28ae7a0bd9d4b29484` artifact directory and its uniquely labelled, unreferenced image were removed only after the 67e6 artifacts and expanded HTTP/browser checks passed.

## Explicitly untested later boundaries

The following remain for later plans: a real Hermes/model canary, systemd unit installation, product deployment, Tailscale/LAN publication, real product credential provisioning, Canvas integration, ME integration, and the forward-only three-product cutover. This foundation evidence does not authorize or assert any of them.
