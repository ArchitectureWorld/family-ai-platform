# Gateway Chat / Work Outbox Events — Verification Evidence

- Branch: `feat/gateway-chat-work-outbox-events`
- Pull Request: #19
- Base: `main` @ `97adaa08bb0b015e7a9b8ade3a43e55aab282238`
- Date: 2026-07-23

## TDD and Review Sequence

### 1. Missing event subsystem

- Test commit required durable Person sequences, events and Outbox tables.
- CI #276: **failure**, as expected.
- Root cause: the event subsystem had not been implemented.
- Secret Scan #162: **success**.

### 2. Event schema, Outbox store and lifecycle

Implemented:

```text
domain_event_schema_migrations
person_event_sequences
domain_events
outbox_events
DomainEventStore
```

Covered Person sequence allocation, paging, Claim lease, Attempt count, Publish, Failed retry, expired Claim recovery and restart persistence.

- CI #280: **success**.
- Secret Scan #166: **success**.

### 3. Formal Chat / Work / Provider events

Added transactional capture for:

```text
chat.home.created
work.created
thread.message.created
chat.work.created
work.progress.updated
thread.provider_turn.failed
thread.provider_turn.succeeded
```

Verified Event / Outbox rollback with invalid Chat → Work, message and Turn replay idempotency, and Payload privacy.

- CI #281: **success**.
- Secret Scan #167: **success**.

### 4. Expired Worker finalization

Review identified that `markPublished()` and `markFailed()` checked Worker identity but did not reject a matching Worker after Lease expiry.

- Regression test commit: CI #283 **failure**, as expected.
- Fix: both transitions now require `claimed_until > completion timestamp`.
- CI #285: **success**.
- Secret Scan #171: checked on the documentation-complete sequence.

### 5. Chat → Work source references

Review identified that a remote terminal could not reconstruct which Chat messages were converted if `chat.work.created` contained an empty `sourceMessageRefs` array.

- Regression test commit: CI #286 **failure**, as expected.
- Fix: an `AFTER INSERT` trigger on `chat_work_conversion_messages` appends each ordered message reference to the existing conversion event inside the same transaction.
- CI #287: **success**.
- Secret Scan #173: **success**.

## Security Assertions

Tests and code review confirm Event Payloads do not include:

```text
Bearer Token
Device Credential
Entry Session Token
Authorization header
Provider External Session
Person message text
Assistant output text
raw exception stack
```

Provider Failure events store only bounded public error metadata:

```text
code
category
retryable
```

## PR #14 Isolation

PR #19 is based directly on the merged PR #18 main commit. It does not stack on PR #14.

Expected PR #19 path family:

```text
apps/gateway/src/app.ts
apps/gateway/src/domainEvents.ts
apps/gateway/test/database.test.ts
apps/gateway/test/domainEvents.test.ts
apps/gateway/test/chatWorkEvents.test.ts
docs/superpowers/**
```

PR #14 remains restricted to:

```text
.github/workflows/ios-ci.yml
clients/ios/**
```

The final path intersection must remain zero before PR #19 is marked Ready.

## Final Gate

The final head must pass:

```bash
npm run check
```

This includes all workspace tests, static checks, TypeScript typechecks and builds. Secret Scan must also pass before completion is claimed.
