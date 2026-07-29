# Task 12 report — Explicit Runtime Composition and Preview Integration

- RED: configuration tests failed for absent runtime parsing/composition and
  Preview discovery tests failed for missing protected Provider inputs.
- GREEN: focused configuration/Preview suite passed (2 files, 39 tests).
- Provider Adapter SDK passed (5 files, 30 tests).
- Runtime/Preview/Agent/Chat regressions passed (6 files, 63 tests).
- Provider SDK and Gateway typechecks passed; Gateway build passed.
- Static/public repository checks and `git diff --check` passed.
- Preview was not started or restarted; port 8790 was not touched.
- Real paths remain inside server runtime configuration and the mode-0600
  ignored `gateway.env`; public serialization and fixed errors exclude them.
- Docker runtime adds only `admin-public`; it does not copy Provider homes,
  credentials or host executables.

## Review fix round 1

- P1 fixed: authoritative real reconciliation now atomically disables
  unconfigured bindings, safely ends and hides stale Fake assignments, clears
  stale defaults, preserves history and replaces the legacy family manager with
  the configured Jarvis runtime.
- Existing Preview-style databases and fresh real-mode onboarding both verify
  that every visible mount/default Provider ref resolves through the Router.
- Members may remain temporarily unmounted; generic Fake automated mode remains
  additive and unchanged.
- P2 fixed: normalized Hermes Profile name `jarvis` is rejected before runtime
  refs or routes are constructed.
- RED: 4 focused failures reproduced the two review findings.
- GREEN: Provider SDK 30 tests; Gateway focused and related regressions 77
  tests; SDK/Gateway typechecks, Gateway build, static checks and diff check
  passed.
- Preview was not started or restarted.

## Review fix round 2

- P1 fixed: the Admin member projection selects at most one active assignment
  per Person, preferring the default and using stable fallback ordering.
- A Person with Jarvis and Codex mounts remains one Admin member card; the
  multi-mount API remains unchanged. An unmounted Person remains one row with a
  null `personalAssistant`.
- RED reproduced two rows for one Person; GREEN passed 22 related tests plus
  Gateway typecheck, build and diff check.
- Preview was not started.
