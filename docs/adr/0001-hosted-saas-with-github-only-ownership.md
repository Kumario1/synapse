# Synapse-as-a-hosted-product: GitHub-only ownership on the existing server

Status: Accepted (2026-06-17). **Reverses** the earlier, also-numbered ADR 0001
"Website accounts with saved connections, no token custody" (Accepted
2026-06-16), which chose a *self-hosted* model where the website only stored
connection metadata and the browser connected directly to a user-run server.
That direction is withdrawn: we are going hosted/multi-tenant instead, and the
Next.js + Auth.js + saved-Connections implementation it produced is removed.
The reasons for the flip are the decisions below.

To turn the static web app into a real product (sign in, onboard, manage your
projects, watch live agent sessions), we are adding a human-facing layer with
these decisions made together:

- **Hosted, multi-tenant.** One Synapse server hosts all owners; every Project's
  daemon connects with a per-repo scoped credential minted at onboarding. We use
  the `project-key` tenancy mode that already exists (`apps/server/src/index.ts`,
  `deriveProjectKey(masterSecret, repoId)`). We are *not* shipping a self-host
  story yet (rejected: each-owner-self-hosts makes a central sign-up pointless).
- **GitHub-only ownership via a GitHub App.** Sign in with GitHub; an Owner may
  claim/manage exactly the repos GitHub reports they can push to. This is the
  only login that *proves* repo ownership, so authz (including kick) reduces to
  "GitHub says you have push on this repo." Google OAuth was requested but
  dropped — it proves an email, nothing about a repo, and a second provider with
  no benefit is pure complexity. Revisit if non-GitHub users ever become a real
  audience.
- **Integration is a GitHub App, not a plain OAuth App.** Onboarding requires the
  ship trail to be live from first run, so the GitHub webhook is in the critical
  path. A GitHub App makes that one click: *installing the App on a repo IS the
  webhook* (GitHub auto-delivers that repo's push/PR/review events to the App's
  endpoint), and the installation also yields the per-repo push-access truth used
  for ownership. A plain OAuth App was rejected: it would force hand-built
  per-repo webhook creation (`admin:repo_hook` + repo-admin user), the exact
  friction onboarding is avoiding. Cost: app manifest + private key +
  installation callback to register and handle. The server-side env boundary is
  `SYNAPSE_GITHUB_APP_ID`, `SYNAPSE_GITHUB_APP_CLIENT_ID`,
  `SYNAPSE_GITHUB_APP_CLIENT_SECRET`, `SYNAPSE_GITHUB_APP_PRIVATE_KEY`, and
  `SYNAPSE_GITHUB_WEBHOOK_SECRET`; missing App env disables human auth/onboarding
  without crashing local/open server mode.
- **Auth lives in `apps/server`, hand-rolled.** We extend the existing Node
  http+ws server (it already has `pg`, `ws`, and the daemon/web channel) with the
  App's user-to-server OAuth callback, a users/ownership table, and cookie
  sessions — rather than standing up a second BFF service. The flow is
  implemented directly (no hosted auth provider like Clerk/Auth0), fitting an MIT
  OSS project.

Consequence: the server now has *two* trust boundaries — machine (daemon↔server,
project-key/shared-token) and human (browser↔server, OAuth cookie session). They
must stay distinct: an OAuth session authorizes dashboard reads and owner
actions (like kick) for claimed repos; it is never a daemon credential.
