# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/Kumario1/synapse/security/advisories/new)**
(Security tab → "Report a vulnerability"). This opens a private advisory visible
only to the maintainer.

Include: a description, affected version/commit, reproduction steps, and impact.
Please give us a reasonable window to fix and release before any public
disclosure.

## Scope

In scope: the Synapse server (`apps/server`), CLI/daemon (`apps/cli`), analyzers
and protocol packages (`packages/*`), and the webhook ingestion path.
Out of scope: issues requiring a compromised developer machine, and findings in
third-party dependencies (report those upstream; we'll bump once a fix ships).

## Secrets

Never include secret values (tokens, keys, `.env` contents) in a report,
issue, or PR. Reference the location and credential type instead. If you believe
a secret was committed, treat it as compromised and tell the maintainer so it
can be rotated.
