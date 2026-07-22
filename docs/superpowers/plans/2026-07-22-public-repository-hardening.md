# Public Repository Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce accidental secret disclosure and supply-chain risk while keeping the repository and all architecture documentation public.

**Architecture:** Narrow GitHub Actions permissions, stop publishing raw CI output, pin action dependencies to immutable commits, expand local and Docker ignore rules, scan current changes and Git history with Gitleaks, and document responsible disclosure. Static repository checks remain dependency-free Bash and include Markdown.

**Tech Stack:** GitHub Actions, Bash, Gitleaks, Docker ignore rules, repository security policy.

## Global Constraints

- Do not remove or privatize architecture, archive, review, or planning documentation.
- Do not rewrite Git history in this PR.
- Do not upload raw CI logs as artifacts or publish them in PR comments.
- Secret scanning must redact findings.
- Third-party and GitHub-authored Actions must be pinned to full commit SHA values.
- The workflow token must use read-only contents permission.

---

### Task 1: Harden repository and Docker exclusions

**Files:** `.gitignore`, `.dockerignore`

- [ ] Ignore package-manager auth files, private keys/certificates, provisioning profiles, local Xcode settings, and runtime credential exports.
- [ ] Exclude `clients/ios`, local editor state, and secret-bearing files from the Gateway Docker build context.
- [ ] Preserve committed example configuration files only where explicitly named.
- [ ] Commit `security: harden ignored credential and build-context files`.

### Task 2: Remove public raw CI diagnostics

**Files:** `.github/workflows/ci.yml`

- [ ] Reduce permissions to `contents: read`.
- [ ] Run `npm ci` and `npm run check` directly without `tee` to a persisted file.
- [ ] Remove CI artifact upload and PR-comment publishing steps.
- [ ] Pin checkout and setup-node to immutable full SHAs with version comments.
- [ ] Commit `security(ci): stop publishing raw build output`.

### Task 3: Add secret scanning

**Files:** `.github/workflows/secret-scan.yml`, `.gitleaks.toml`

- [ ] Add a Gitleaks workflow for pull requests, pushes to main, and manual full-history scans.
- [ ] Pin checkout and Gitleaks Action to full SHAs.
- [ ] Use redaction and no report artifact upload.
- [ ] Keep allowlists limited to explicit synthetic fixture paths or exact non-secret patterns.
- [ ] Commit `security(ci): add redacted Gitleaks scanning`.

### Task 4: Expand dependency-free static checks

**Files:** `scripts/static-check.sh`

- [ ] Include Markdown and repository configuration files in forbidden-reference scanning.
- [ ] Reject tracked `.env`, `.npmrc`, private-key, provisioning-profile, SQLite, runtime-report, and local-Xcode files.
- [ ] Reject workflows that use floating action tags instead of full SHAs.
- [ ] Verify `.dockerignore` contains required credential exclusions.
- [ ] Commit `security: enforce public repository hygiene locally`.

### Task 5: Publish security policy

**Files:** `SECURITY.md`

- [ ] Document supported status, private vulnerability reporting through GitHub Security Advisories, prohibited public disclosure of live credentials, rotation guidance, and scope boundaries.
- [ ] State that the project is development-stage software and not production-ready.
- [ ] Commit `docs(security): add vulnerability reporting policy`.

### Task 6: Verification

- [ ] Run `bash scripts/static-check.sh`.
- [ ] Run `npm run check`.
- [ ] Run Gitleaks against the working tree and all refs with redaction.
- [ ] Confirm no raw CI artifact or PR-comment workflow remains.
- [ ] Open a draft PR and keep it unmerged until CI and secret scan pass.
