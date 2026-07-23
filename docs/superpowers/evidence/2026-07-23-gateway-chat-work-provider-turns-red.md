# Gateway Chat / Work Provider Turns — TDD Evidence

## Migration V5 RED definition

Before production implementation, the new database test required:

- schema migration ledger version 5;
- `thread_provider_contexts`;
- `thread_provider_turns`;
- exact context and turn columns.

At that point production `database.ts` still supported versions 1–4 only. GitHub did not schedule a check run for those initial Draft commits, so the missing behavior is documented from the committed test and production diff rather than represented as a numbered Actions run.

## Current verification trigger

Migration V5, the Provider repository, Thread Lane service, route integration and compatibility test updates are now committed. This follow-up commit occurs while PR #18 is Ready for review so the pull-request `synchronize` event can run the full repository quality gate.
