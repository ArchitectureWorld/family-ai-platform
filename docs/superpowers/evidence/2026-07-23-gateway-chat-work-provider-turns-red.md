# Gateway Chat / Work Provider Turns — RED Evidence

- Stage: Migration V5
- Production status: V5 not implemented
- Expected failing assertions:
  - schema migration ledger contains versions 1–4 instead of 1–5;
  - `thread_provider_contexts` does not exist;
  - `thread_provider_turns` does not exist.
- Verification trigger: committed after PR #18 entered review state so the `synchronize` event runs the repository quality gate.

This commit intentionally keeps production code unchanged so the pull-request CI run proves the new test fails for the intended missing behavior.
