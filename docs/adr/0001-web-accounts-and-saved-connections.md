# 1. Website accounts with saved connections, no token custody

Date: 2026-06-16
Status: Accepted

## Context

The Synapse website (`apps/web`) is being expanded from a single-page Vite SPA
(a stacked landing + demo dashboard, connected via `?server=&repoId=&token=`) into
a marketing landing page, a login-gated onboarding/install surface, and a live
dashboard tied to a user identity.

Synapse the product is self-hosted: users run the coordination **Server** themselves
via the CLI, and the browser connects **directly** to that Server over WebSocket using
a per-server **Token**. There is no account system today — `apps/server` notes that
"GitHub OAuth / DB-backed keys are the intended multi-tenant upgrade." So adding
website accounts introduces a second, independent auth domain alongside the Server's
token auth, and raises the question of whether the website should custody secrets or
proxy traffic.

## Decision

1. **Accounts exist, identified by GitHub OAuth only.** No email/password, no other
   providers. Devs already have GitHub, and `repoId` already derives from the git remote.

2. **The website never hosts or proxies coordination traffic.** The browser keeps
   connecting **directly** to the user's self-hosted Server. We rejected both a managed
   ("hosted Synapse") model and a dashboard proxy.

3. **An account owns a synced list of Connections — metadata only.** A Connection is
   `{ label, wss:// URL, repoId }`, stored in the website database per account. The
   **Token is never stored server-side**; it lives only in the browser (localStorage)
   and is re-entered once per device.

4. **Stack: migrate `apps/web` from Vite SPA to Next.js + Auth.js + Postgres.** Auth.js
   provides GitHub OAuth + sessions; API routes + Postgres hold connection metadata;
   marketing pages get SSG/SSR for SEO. The dashboard becomes a client component reusing
   the existing WebSocket feed code unchanged.

5. **Gating:** the landing page and seeded demo are public; the install/usage
   instructions **and** the live dashboard require login.

## Consequences

- **Positive:** a website breach exposes no Tokens (no secret custody). Self-hosted
  semantics are preserved — our service is never in the path of live coordination, and a
  Server keeps working if the website is down. One self-contained deploy, no third-party
  auth SaaS. Marketing pages are SEO-friendly.
- **Negative / costs:** a framework migration (Vite → Next.js) and a new persistence +
  auth surface to operate (Postgres, OAuth app, sessions). Connections sync but the Token
  does not, so each new device prompts for the Token once. Gating install docs behind
  login adds funnel friction for an OSS CLI (accepted deliberately to capture identity
  early; the same steps remain public in the README).
- **Revisit if:** we decide to offer hosted Synapse or dashboard sharing-by-link — both
  would require reopening the "never proxy / never custody" decisions above.
