# Security Policy

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately using GitHub's **Private Vulnerability Reporting**: go to the
[**Security** tab → **Report a vulnerability**](https://github.com/Blake-Daniel-Inv/SnowCrew-AI/security/advisories/new).
This keeps the report confidential until a fix is available.

Reports are typically acknowledged within a few days, and you'll be kept updated on
remediation progress.

## Supported Versions

This project is pre-1.0 and developed on a rolling basis. Only the latest `main` receives
security fixes.

| Version          | Supported |
| ---------------- | --------- |
| `main` (latest)  | ✅        |
| older commits    | ❌        |

## Scope & Threat Model

SnowCrew AI is designed for **local / single-tenant deployment**. A few things worth knowing
when assessing a report:

- **Credentials at rest.** Third-party tokens (GitHub OAuth, Snowflake PAT/JWT) are
  envelope-encrypted before storage using the key in `CREDENTIALS_MASTER_KEY`. Protecting that
  key — and your `.env*` files — is the operator's responsibility. Losing the key means losing
  stored credentials; exposing it compromises them.
- **Secrets stay server-side.** Readiness/health endpoints return variable *names*, never
  values.
- **Generally out of scope:** issues that require an already-compromised host, a leaked
  `CREDENTIALS_MASTER_KEY`, or real secrets committed to your own fork.

If you're unsure whether something is in scope, report it privately and we'll triage.
