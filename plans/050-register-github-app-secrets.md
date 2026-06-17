# Plan 050: Wire Synapse GitHub App secrets into the server

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat d5b9263..HEAD -- apps/server/src/index.ts apps/server/src/github.ts apps/server/src/github.test.ts scripts/verify-github-webhook.mjs .env.example README.md docs/adr/0001-hosted-saas-with-github-only-ownership.md docs/system-evolution-study-guide.md apps/server/Dockerfile package.json
> ```
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security | docs
- **Planned at**: commit `d5b9263`, 2026-06-17
- **Issue**: https://github.com/Kumario1/synapse/issues/102

## Why this matters

Issue #102 is the first hosted-SaaS unblocker: the Synapse GitHub App must exist
in GitHub, and the server must know how to read its credentials before user auth
and installation callbacks can land. The code change should be intentionally
small: load and validate the env surface, keep local/open mode working when the
App is absent, keep the existing webhook secret behavior, and document the exact
GitHub console settings. Do not build OAuth routes or installation storage in
this plan; those are separate issues.

## Current state

- `apps/server/src/index.ts` is the server entrypoint. It reads daemon/server auth
  env vars at startup and currently reads `SYNAPSE_GITHUB_WEBHOOK_SECRET`
  directly inside the webhook handler.

```ts
// apps/server/src/index.ts:36-56
const port = Number(process.env.SYNAPSE_SERVER_PORT ?? 4010);
const host = process.env.SYNAPSE_SERVER_HOST ?? "127.0.0.1";
// Reported on /health so `synapse doctor` can compare client/server versions.
const SERVER_VERSION =
  (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "0.0.0";
// Auth mode for the daemon<->server channel, resolved once at startup:
//   - SYNAPSE_MASTER_SECRET set -> "project-key": each request is validated
//     against deriveProjectKey(secret, repoId), so a key grants access to its
//     own project only (real tenancy). The presented credential still arrives
//     via the existing `?token=` / `Authorization: Bearer` path.
//   - else SYNAPSE_AUTH_TOKEN set -> "shared-token": today's all-or-nothing
//     behavior - any valid token reads/writes any repo.
//   - else -> "open": no auth (local/dev and hermetic tests).
// GitHub OAuth / DB-backed keys are the intended multi-tenant upgrade - see the README.
const masterSecret = process.env.SYNAPSE_MASTER_SECRET ?? "";
const authToken = process.env.SYNAPSE_AUTH_TOKEN ?? "";
const authMode: "project-key" | "shared-token" | "open" = masterSecret
  ? "project-key"
  : authToken
    ? "shared-token"
    : "open";
```

```ts
// apps/server/src/index.ts:494-505
const secret = process.env.SYNAPSE_GITHUB_WEBHOOK_SECRET;
// G4: a server running with auth (shared token or project keys) is a
// production posture - an unsigned, internet-reachable webhook that mutates
// team state is not acceptable there. Open mode (local/dev) stays unchanged.
if (authMode !== "open" && !secret) {
  metrics.count("synapse_webhook_rejections_total", { reason: "secret_required" });
  log.warn("webhook.secret_required", { authMode });
  writeJson(response, 403, {
    ok: false,
    error: "webhook_secret_required",
    detail:
      "This server runs with auth enabled; set SYNAPSE_GITHUB_WEBHOOK_SECRET (and configure the same secret on the GitHub webhook) to accept webhooks."
  });
```

- `.env.example` documents only the standalone webhook secret today.

```dotenv
# .env.example:27-29
# Optional server-side GitHub webhook HMAC secret. When set, POST
# /webhooks/github requires a valid X-Hub-Signature-256 header.
# SYNAPSE_GITHUB_WEBHOOK_SECRET=
```

- `README.md` has server auth and operations docs but no GitHub App setup
  runbook.

```md
<!-- README.md:242-252 -->
## Server auth modes

Resolved at server startup. `/health` and the GitHub webhook (its own HMAC) stay open; credentials are sent via `?token=` / `Authorization: Bearer` and compared in constant time - never written to disk.

| Mode | Trigger | Behavior |
| --- | --- | --- |
| **open** | neither var set | No auth - keeps local/dev and verify scripts hermetic |
| **shared-token** | `SYNAPSE_AUTH_TOKEN` | Any valid token reads/writes any project |
| **project-key** | `SYNAPSE_MASTER_SECRET` | Real tenancy: key = `base64url(HMAC-SHA256(secret, repoId))`, authorizes only its project (checked at handshake + per-message) |
```

- ADR-0001 already decided GitHub App ownership, but it does not name env vars.

```md
<!-- docs/adr/0001-hosted-saas-with-github-only-ownership.md:27-35 -->
- **Integration is a GitHub App, not a plain OAuth App.** Onboarding requires the
  ship trail to be live from first run, so the GitHub webhook is in the critical
  path. A GitHub App makes that one click: *installing the App on a repo IS the
  webhook* (GitHub auto-delivers that repo's push/PR/review events to the App's
  endpoint), and the installation also yields the per-repo push-access truth used
  for ownership. A plain OAuth App was rejected: it would force hand-built
  per-repo webhook creation (`admin:repo_hook` + repo-admin user), the exact
  friction onboarding is avoiding. Cost: app manifest + private key +
  installation callback to register and handle.
```

- `apps/server/Dockerfile` lists pass-through server env vars.

```dockerfile
# apps/server/Dockerfile:40-46
# Pass-through configuration (see .env.example):
#   SYNAPSE_SERVER_PORT            listen port (default 4010)
#   SYNAPSE_SERVER_HOST            listen host (default 127.0.0.1; use 0.0.0.0 in containers)
#   SYNAPSE_MASTER_SECRET          enables project-key auth + tenancy
#   SYNAPSE_AUTH_TOKEN             legacy shared-token auth (alternative)
#   SYNAPSE_DB_PATH                durable SQLite state (mount a volume)
#   SYNAPSE_GITHUB_WEBHOOK_SECRET  optional webhook HMAC
```

Repo conventions to match:

- TypeScript ESM imports include `.js` for local runtime imports from TS files
  (`import { createEmbeddingProvider } from "./embeddings.js";`).
- Unit tests use `node:test` and `node:assert/strict`; see
  `apps/server/src/github.test.ts`.
- Verifier scripts are plain `.mjs` files using `assert`, local `startProcess`
  helpers, and env objects; see `scripts/verify-github-webhook.mjs`.
- Do not commit real credentials. All examples must be empty placeholders or
  obvious fake test values.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Build server | `npm run build --workspace @synapse/server` | exit 0 |
| Server tests | `npm test --workspace @synapse/server` | exit 0; includes the new GitHub App config tests |
| GitHub webhook verifier | `npm run verify:github-webhook` | exit 0; prints "GitHub webhook verification passed" |
| Typecheck | `npm run typecheck` | exit 0, no TypeScript errors |
| Lint | `npm run lint` | exit 0, no ESLint errors |
| Full unit suite | `npm test` | exit 0 |

## Scope

**In scope**:

- `apps/server/src/github-app-config.ts` (new)
- `apps/server/src/github-app-config.test.ts` (new)
- `apps/server/src/index.ts`
- `scripts/verify-github-webhook.mjs`
- `.env.example`
- `README.md`
- `docs/adr/0001-hosted-saas-with-github-only-ownership.md`
- `docs/system-evolution-study-guide.md`
- `apps/server/Dockerfile`
- `plans/README.md`

**Out of scope**:

- Do not create `/auth/github`, callback, installation, setup, owner, session,
  cookie, or database tables in this issue.
- Do not add GitHub API client dependencies. Reading env and preserving the
  existing webhook HMAC behavior is enough.
- Do not rotate, print, or commit any real GitHub App credentials.
- Do not change daemon auth semantics (`SYNAPSE_MASTER_SECRET`,
  `SYNAPSE_AUTH_TOKEN`, `SYNAPSE_PROJECT_KEY`).

## Git workflow

- Branch: `feat/github-app-secrets`
- Commit message: `feat(server): wire github app secrets`
- Open a PR to `main` and link issue #102.

## Steps

### Step 1: Add the GitHub App config loader

Create `apps/server/src/github-app-config.ts`.

Target shape:

- Export a `GitHubAppConfig` interface with:
  - `appId`
  - `clientId`
  - `clientSecret`
  - `privateKey`
  - `webhookSecret`
- Export a discriminated union result:
  - `{ status: "disabled"; webhookSecret?: string }`
  - `{ status: "configured"; config: GitHubAppConfig; webhookSecret: string }`
  - `{ status: "incomplete"; missing: string[]; webhookSecret?: string }`
- Export `loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env)`.
- Required env vars for `configured`:
  - `SYNAPSE_GITHUB_APP_ID`
  - `SYNAPSE_GITHUB_APP_CLIENT_ID`
  - `SYNAPSE_GITHUB_APP_CLIENT_SECRET`
  - `SYNAPSE_GITHUB_APP_PRIVATE_KEY`
  - `SYNAPSE_GITHUB_WEBHOOK_SECRET`
- Treat all blank/whitespace-only values as missing.
- Normalize `SYNAPSE_GITHUB_APP_PRIVATE_KEY` by replacing literal `\\n` with
  newline characters. Do not parse the PEM cryptographically here; future GitHub
  API code can do that when it uses the key.
- Important compatibility rule: if no `SYNAPSE_GITHUB_APP_*` value is present,
  return `disabled` even when `SYNAPSE_GITHUB_WEBHOOK_SECRET` is present. That
  keeps the existing standalone signed-webhook setup from looking incomplete.
- If any `SYNAPSE_GITHUB_APP_*` value is present, require the whole set above and
  return `incomplete` with only env var names in `missing` when anything is
  absent.

Keep this file dependency-free.

**Verify**:

```bash
npm run build --workspace @synapse/server
```

Expected: exit 0.

### Step 2: Add focused config tests

Create `apps/server/src/github-app-config.test.ts` using `node:test` and
`node:assert/strict`.

Cover these cases:

- Empty env returns `{ status: "disabled" }`.
- Only `SYNAPSE_GITHUB_WEBHOOK_SECRET` returns disabled with
  `webhookSecret: <value>` and does not report missing App vars.
- Complete env returns `configured`, preserves IDs/secrets, exposes
  `webhookSecret`, and converts `-----BEGIN\\nKEY\\n-----END` into real newlines.
- Partial App env returns `incomplete` and lists missing variable names, not
  secret values.
- Blank strings are treated as missing.

**Verify**:

```bash
npm run build --workspace @synapse/server && npm test --workspace @synapse/server
```

Expected: exit 0 and the new tests pass.

### Step 3: Wire the loader into server startup

In `apps/server/src/index.ts`:

- Import `loadGitHubAppConfig` from `./github-app-config.js`.
- Load it once near the existing startup env reads, after `authMode` is computed
  and before handlers are created:

```ts
const githubApp = loadGitHubAppConfig();
const githubWebhookSecret = githubApp.webhookSecret;
```

- If `githubApp.status === "incomplete"`, log one warning with the missing env
  var names only:

```ts
log.warn("github_app.incomplete", { missing: githubApp.missing });
```

- Add a non-secret `githubApp: githubApp.status` field to the `/health` JSON
  response. This proves the server read the env without exposing credentials.
- In `handleGitHubWebhook`, replace the direct
  `process.env.SYNAPSE_GITHUB_WEBHOOK_SECRET` read with the startup constant:

```ts
const secret = githubWebhookSecret;
```

Do not throw on `disabled` or `incomplete`; local/open mode must still boot.
Existing auth-mode webhook behavior must remain: auth-enabled servers still
return `403 webhook_secret_required` when no webhook secret is available.

**Verify**:

```bash
npm run build --workspace @synapse/server && npm test --workspace @synapse/server
```

Expected: exit 0.

### Step 4: Make the verifier cover boot with App env present

Update `scripts/verify-github-webhook.mjs` so at least one started server process
receives fake-but-complete GitHub App env vars in addition to its existing
`SYNAPSE_GITHUB_WEBHOOK_SECRET`.

Use obvious fake values only, for example:

```js
SYNAPSE_GITHUB_APP_ID: "12345",
SYNAPSE_GITHUB_APP_CLIENT_ID: "Iv1.fakeclient",
SYNAPSE_GITHUB_APP_CLIENT_SECRET: "fake-client-secret",
SYNAPSE_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
SYNAPSE_GITHUB_WEBHOOK_SECRET: webhookSecret
```

After `waitForHttp(.../health)`, fetch `/health` for that server and assert:

```js
assert.equal(health.githubApp, "configured");
```

Leave the rest of the verifier behavior unchanged.

**Verify**:

```bash
npm run verify:github-webhook
```

Expected: exit 0 and output includes `GitHub webhook verification passed`.

### Step 5: Document registration and env

Update `.env.example`:

- Add a "Synapse GitHub App" block near the existing webhook secret comments.
- Document the required console-derived values:
  - `SYNAPSE_GITHUB_APP_ID`
  - `SYNAPSE_GITHUB_APP_CLIENT_ID`
  - `SYNAPSE_GITHUB_APP_CLIENT_SECRET`
  - `SYNAPSE_GITHUB_APP_PRIVATE_KEY`
  - `SYNAPSE_GITHUB_WEBHOOK_SECRET`
- Explain that `SYNAPSE_GITHUB_WEBHOOK_SECRET` is still the HMAC secret for
  `POST /webhooks/github`, and that setting only this var remains valid for
  signed webhook ingestion without the full App auth flow.

Update `README.md`:

- Add a compact "GitHub App setup" subsection near "Server auth modes".
- Include the console settings operators must configure:
  - User authorization callback URL: hosted server `/auth/github/callback`
  - Setup/installation callback URL: hosted server `/auth/github/setup`
  - Webhook URL: hosted server `/webhooks/github`
  - Webhook secret: same value as `SYNAPSE_GITHUB_WEBHOOK_SECRET`
  - Repository permissions: Contents read-only, Metadata read-only, Pull requests
    read-only
  - Subscribe to: Push, Pull request, Pull request review, Issue comment
- State that OAuth/setup routes are intentionally a follow-up; this issue only
  registers the App and wires the secret surface.

Update `docs/adr/0001-hosted-saas-with-github-only-ownership.md`:

- Add one sentence to the GitHub App bullet naming the env boundary and saying
  missing App env disables human auth/onboarding but does not crash local/open
  server mode.

Update `docs/system-evolution-study-guide.md`:

- In the current architecture diagram/description, rename the GitHub node from
  plain "GitHub webhooks" to "GitHub App + webhooks" and mention the App env
  loader in the current-system prose.

Update `apps/server/Dockerfile`:

- Add the GitHub App env vars to the pass-through configuration comment.

**Verify**:

```bash
npm run lint
```

Expected: exit 0. Documentation files are not linted, but this catches source
format/style issues.

### Step 6: Run final local checks

Run:

```bash
npm run typecheck
npm test
npm run lint
```

Expected: all exit 0.

If `npm test` fails only because optional local services/tools are unavailable,
run the narrower commands from this plan plus the relevant failing workspace
test, then report the exact skipped/failing condition in the PR. Do not mark
failed tests as passing.

## Test plan

- New unit file `apps/server/src/github-app-config.test.ts` covers disabled,
  webhook-only, configured, partial, and blank env states.
- Existing server tests still run through `npm test --workspace @synapse/server`.
- Existing webhook verifier proves a server with full App env boots and still
  processes signed GitHub webhooks.

## Done criteria

All must hold:

- [ ] `apps/server/src/github-app-config.ts` exists and has no runtime
      dependencies beyond Node/process types.
- [ ] `npm test --workspace @synapse/server` exits 0 and includes the new config
      tests.
- [ ] `npm run verify:github-webhook` exits 0 with a full fake GitHub App env.
- [ ] `/health` includes only non-secret GitHub App status, never secret values.
- [ ] Existing standalone `SYNAPSE_GITHUB_WEBHOOK_SECRET` behavior still works.
- [ ] `.env.example`, `README.md`, ADR-0001, the system evolution guide, and the
      server Dockerfile document the new env/registration surface.
- [ ] `npm run typecheck`, `npm test`, and `npm run lint` exit 0, or any local
      infrastructure limitation is reported plainly.

## STOP conditions

Stop and report back if:

- The issue owner expects the actual GitHub.com console registration to be
  completed by the executor. That requires owner access and cannot be verified
  by CI.
- Implementing this appears to require OAuth routes, installation callback
  routing, owner tables, cookie sessions, or GitHub API clients.
- The existing webhook-only mode would break or become incomplete when only
  `SYNAPSE_GITHUB_WEBHOOK_SECRET` is set.
- Any real credential value appears in the worktree, logs, tests, docs, commit
  message, or PR body.
- The current code around `apps/server/src/index.ts` no longer matches the
  excerpts above.

## Maintenance notes

- Future GitHub auth/onboarding work should consume `loadGitHubAppConfig()`
  instead of re-reading env directly.
- The loader deliberately does not validate the PEM with crypto APIs; the first
  GitHub API caller should validate when it signs a JWT and should return a
  clean auth/setup error.
- The console registration itself is an owner task. The PR should include a
  checkbox or follow-up note confirming whether the App was registered outside
  the repo.
