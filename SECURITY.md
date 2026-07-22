# Security Policy

## Project status

Family AI Platform is under active development and is not production-ready. The current Gateway, browser acceptance UI, mobile-entry work, and local deployment scripts are intended for controlled development and testing environments.

Do not expose the Gateway directly to the public Internet, do not reuse development credentials in another environment, and do not store live family data in test fixtures or acceptance reports.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's repository security-advisory workflow:

1. Open the repository's **Security** tab.
2. Choose **Advisories**.
3. Choose **Report a vulnerability**.
4. Include affected commit or release, reproduction steps, security impact, and any suggested mitigation.

Do not open a public issue for an unpatched vulnerability, leaked credential, private family record, or exploitable deployment configuration.

## Credential exposure

When a credential may have been exposed:

1. Revoke or rotate it immediately; removing it from a later commit is not sufficient.
2. Identify all environments, devices, sessions, logs, artifacts, comments, screenshots, and Git objects that may contain it.
3. Revoke dependent sessions and device bindings where applicable.
4. Consider a coordinated Git-history rewrite only after rotation and impact analysis.
5. Document the incident without reproducing the live secret.

Never paste live API keys, pairing codes, device credentials, EntrySession tokens, Tailnet-specific private hostnames, signing certificates, provisioning profiles, or real family-member data into an issue, pull-request body, CI log, fixture, screenshot, or committed file.

## Supported scope

Security reports are especially useful for:

- authentication or authorization bypass;
- cross-family or cross-person data access;
- device pairing, session renewal, or revocation flaws;
- credential disclosure through logs, reports, URLs, or browser storage;
- unsafe Gateway network exposure;
- injection, path traversal, or arbitrary code execution;
- dependency or GitHub Actions supply-chain risk;
- persistence of plaintext credentials in SQLite or client storage;
- failures to remove access after device or session revocation.

General feature requests, architecture suggestions, and non-sensitive defects may use public issues.

## Disclosure process

The maintainers will acknowledge a complete private report when reviewed, reproduce and assess the issue, prepare a fix and verification evidence, rotate affected credentials where necessary, and coordinate public disclosure after users can mitigate the risk.

No guaranteed response or remediation deadline is offered while the project remains pre-production, but high-impact reports will be prioritized.