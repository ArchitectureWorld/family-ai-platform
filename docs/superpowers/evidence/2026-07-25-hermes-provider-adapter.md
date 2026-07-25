# Hermes Provider Adapter Verification Evidence

- Date: 2026-07-25
- Actual PR: #28 — `feat(provider): connect Gateway to Hermes profiles`
- Base: `main` @ `d3e4d2302bf9f0329b3205a07282adb9aaf46ec3`

## Scope verified

```text
Hermes OpenAI-compatible API invocation
Bearer authentication
Idempotency-Key propagation
X-Hermes-Session-Id continuation
X-Hermes-Session-Key memory scope
strict Provider Profile routing
runtime-only provider JSON
production without Fake fallback
Docker host-gateway reachability
Gateway Assistant turn persistence
Chat / Work Session isolation
```

This PR does not change Family Manager or Personal Assistant assignments. Jarvis / 于途 registration and binding remain in the next independent PR.

## TDD evidence

| Capability | RED | GREEN |
|---|---:|---:|
| Hermes request, Session and success mapping | CI #511 | CI #513 |
| Exact Provider Profile router | CI #515 | CI #517 |
| Runtime Provider JSON composition | CI #518 | CI #520 |
| Explicit Gateway production config | CI #521 | CI #523 |
| Docker host-gateway and ignored config mount | CI #524 | CI #526 |
| Redirect credential protection | CI #528 | CI #529 |

CI #519 exposed an `exactOptionalPropertyTypes` integration defect after the first runtime loader implementation. The fix omitted absent `fetchImpl` and `clock` fields rather than passing explicit `undefined`; CI #520 then passed the full quality gate.

## Adapter behavior

Verified:

- `POST /v1/chat/completions` is non-streaming;
- `GET /v1/models` is used for health;
- `Authorization`, Session, Session Key and Idempotency headers are present;
- HTTP redirects are rejected for both invocation and health requests;
- a first Thread turn derives a stable `external-session:hermes-*` ref;
- subsequent turns use the persisted Session ref exactly;
- response text is preserved and only trimmed for empty-value validation;
- 401/403, 408/429, 5xx, other 4xx, network errors, timeout and malformed success bodies map to bounded formal Provider errors;
- upstream response bodies, exception text, URL and API key never enter public results.

## Runtime composition

The ignored runtime file is:

```text
.runtime/config/providers.json
```

Development behavior:

```text
no file     → Fake Provider only
valid file  → Fake + exact Hermes Profile routes
```

Production behavior:

```text
no file / invalid file → startup rejected
valid Hermes file      → Hermes routes only
unknown Profile        → formal failure; no fallback
```

## End-to-end Gateway evidence

`apps/gateway/test/hermesProviderIntegration.test.ts` uses a real temporary SQLite Gateway lifecycle:

```text
initialize Family
→ register a test Hermes Profile and Agent
→ switch only the test Owner Assistant Assignment
→ open Home Chat
→ send two Person messages
→ persist two Hermes Assistant replies
→ create Work
→ send a Work message
```

Assertions verify:

- the two Home Chat turns use the same Hermes Session;
- the Work uses a different Hermes Session;
- every turn has a distinct Gateway Idempotency-Key;
- Assistant messages retain `agent:yutu` and `provider-profile:hermes-zzh` provenance;
- two Thread Provider Context rows persist two distinct external Session refs;
- API key and host URL do not enter the inspected domain tables.

The integration test passed in CI #527 and remained green in CI #529.

## Deployment boundary

Compose keeps Gateway published only at:

```text
127.0.0.1:8790
```

and adds:

```text
host.docker.internal:host-gateway
./.runtime/config:/app/.runtime/config:ro
```

`dev-up.sh` adds `GATEWAY_PROVIDER_CONFIG_PATH` only when the ignored provider JSON exists. It does not read the JSON into terminal output or overwrite it.

## Security review

Verified:

- no API key in Git, SQLite, public errors or health responses;
- runtime config remains under `.runtime/`;
- URL credentials, query and fragment are rejected;
- model and Session Key reject control characters;
- redirect following is disabled;
- exact Profile routing prevents cross-Agent fallback;
- production never registers Fake Provider;
- Web and mobile clients do not receive Hermes credentials.

## PR #14 isolation

PR #28 changed paths do not intersect:

```text
clients/ios/**
.github/workflows/ios-ci.yml
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
```

It also does not modify Mobile Pairing routes or Agent Assignment production code.

## Remaining operational requirement

No claim is made that the user's host Hermes profiles are already configured or running. The next PR will create the Jarvis / zzh runtime configuration, apply the intended Assignments and provide one-command live health and product verification. Actual Linux host execution remains required before claiming live Hermes acceptance.
