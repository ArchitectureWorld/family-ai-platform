# Hermes Provider Adapter Development Record

Date: 2026-07-25  
PR: #28

## Outcome

Family AI Gateway now has a real, reusable Hermes Provider runtime boundary while preserving the existing Gateway-owned Person, Thread, Work, Message, Turn, idempotency and sync model.

```text
Provider Profile Ref
→ exact ProviderAdapterRouter route
→ HermesProviderAdapter
→ authenticated Hermes Profile API Server
→ formal ProviderInvocationResult
→ existing Assistant message persistence
```

## Delivered components

```text
packages/provider-adapter-sdk/src/hermes.ts
packages/provider-adapter-sdk/src/router.ts
apps/gateway/src/providerRuntime.ts
```

### Hermes Adapter

- OpenAI-compatible `/v1/chat/completions` invocation;
- `/v1/models` health;
- Bearer authentication;
- stable transcript Session mapping;
- stable profile memory scope;
- Gateway Idempotency-Key propagation;
- strict response and error mapping;
- timeout handling;
- redirect rejection;
- no upstream body or secret exposure.

### Runtime router

- exact Provider Profile ownership;
- no cross-profile fallback;
- aggregate health;
- development Fake + Hermes coexistence;
- production real-provider-only behavior.

### Deployment

- ignored `.runtime/config/providers.json`;
- read-only runtime config mount;
- Docker host gateway resolution;
- optional development activation;
- explicit production startup gate.

## Verification summary

Latest code head before this documentation record passed:

```text
Repository CI #529     success
Secret Scan #415       success
```

The full gate includes all workspace tests, static checks, TypeScript type checking and builds.

Detailed evidence:

```text
docs/superpowers/evidence/2026-07-25-hermes-provider-adapter.md
```

## Assignment status

This PR intentionally does not change live assignments. Current production domain defaults remain unchanged until the next PR.

Next intended mapping:

```text
family_admin → agent:jarvis → provider-profile:hermes-jarvis
Owner personal → agent:yutu → provider-profile:hermes-zzh
other members → unchanged
```

## Next step

Create an independent assignment and host-configuration PR that:

1. registers Jarvis and 于途;
2. registers both Hermes Provider Profiles;
3. migrates the current Family Manager and only the Owner personal Assistant;
4. writes ignored provider runtime JSON;
5. configures Hermes profile API servers on ports 8650 and 8651;
6. performs live `/v1/models` and product-message verification without exposing keys.
