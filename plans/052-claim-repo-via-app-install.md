# Plan 052: Claim one repo by installing the GitHub App (Owner ↔ Project ownership + project-key)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 179e009..HEAD -- apps/server/src/index.ts apps/server/src/auth/routes.ts apps/server/src/auth/user-store.ts apps/server/src/auth/session.ts apps/server/src/github-app-config.ts apps/web/src/components/TopbarAuth.tsx`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M-L
- **Risk**: MED (authz foundation — ownership and per-repo credential minting; security-sensitive)
- **Depends on**: plans/051-github-signin-end-to-end.md (DONE — merged as PR #117; provides the `apps/server/src/auth/` module: `user-store.ts`, `session.ts`, `github-oauth.ts`, `routes.ts`, and the session cookie) and plans/050 (GitHub App config). 
- **Category**: direction (feature) / security
- **Planned at**: commit `179e009`, 2026-06-17
- **Issue**: https://github.com/Kumario1/synapse/issues/104

## Why this matters

This turns a logged-in Owner into the Owner of a **Project**. "Add project" sends the
Owner through the GitHub App installation flow for a repo they can push to; the
setup callback records ownership (Owner ↔ repoId) and mints that repo's
**project-key** using the existing tenancy primitive
`deriveProjectKey(SYNAPSE_MASTER_SECRET, repoId)`. Installing the App also makes
that repo's webhooks live automatically (GitHub delivers push/PR/review events to
the App's webhook URL = the server's existing `POST /webhooks/github`), so **no
new webhook code is needed** — the ship trail populates through the path already
shipped. Ownership is the authz foundation for everything downstream (#105–#107):
an Owner may manage exactly the repos GitHub reports they can push to.

## Current state

The #103 auth module is on `main` and is the foundation here. Read these:

- `apps/server/src/auth/session.ts` — exports `signSession(userId, key, now?)`,
  `verifySession(token, key, maxAgeMs?)` → `{ userId } | null`, `parseCookies`,
  `serializeCookie(name, value, opts)`, and `SESSION_COOKIE` (the cookie name
  constant). Reuse these for session checks; do NOT re-implement cookie logic.
- `apps/server/src/auth/routes.ts` — the auth router. Key shape (lines ~28–43,
  66–147):
  ```ts
  export interface AuthContext {
    creds: OAuthCreds; sessionKey: Buffer; userStore: UserStore; redirectUri: string;
    exchangeCodeForToken: (code: string) => Promise<string>;
    fetchGitHubUser: (token: string) => Promise<GitHubUser>;
    isSecure: boolean;
  }
  export interface RouteResult { status: number; body?: unknown; redirect?: string; setCookies?: string[]; }
  export async function resolveAuthRoute(method, pathname, query: URLSearchParams, cookies: Record<string,string>, ctx: AuthContext): Promise<RouteResult | null>;
  export async function handleAuthRequest(request, response, url, ctx): Promise<boolean>;
  ```
  It already has a `signState(key)` + `verifyStateSigned(query, cookie, key)`
  pair (lines ~46–50, 149–173) implementing signed-CSRF-state — REUSE this exact
  pattern for the install flow's state, do not invent a second scheme. It already
  routes `/auth/github`, `/auth/github/callback`, `/auth/me`, `/auth/logout`,
  then falls through to `404` for other `/auth/*` and `null` for non-`/auth/`.
- `apps/server/src/auth/user-store.ts` — `OwnerUser { id, login, name, avatarUrl }`,
  `UserStore { upsertUser, getUserById, close }`, `createUserStore({databaseUrl?, path?})`
  branching `SYNAPSE_DATABASE_URL` (Postgres, lazy `import("pg")`) → else
  `SYNAPSE_DB_PATH` → `:memory:` (SQLite). **Model the new project store on this
  file exactly** (same backend split, same lazy-pg pattern, same `:memory:`
  default for hermetic tests).
- `apps/server/src/auth/github-oauth.ts` — `exchangeCodeForToken`,
  `fetchGitHubUser`, both taking an injectable `fetchFn` so tests never hit the
  network. **Mirror this injectable-fetch pattern** for the new GitHub-App calls.
- `apps/server/src/github-app-config.ts` — `loadGitHubAppConfig(env?)` returns,
  when `status === "configured"`, `{ status, webhookSecret, config }` with
  `config: { appId, clientId, clientSecret, privateKey, webhookSecret }`. There is
  NO app-slug field — read `process.env.SYNAPSE_GITHUB_APP_SLUG` directly in
  `index.ts` instead (do not modify this file or its test).
- `apps/server/src/index.ts`:
  - `const masterSecret = process.env.SYNAPSE_MASTER_SECRET ?? "";` (line ~55).
  - `authContext` is built ONLY when `githubApp.status === "configured"` (lines
    ~79–105), passing `userStore`, `creds`, `sessionKey`, `redirectUri`,
    `exchangeCodeForToken`, `fetchGitHubUser`, `isSecure`. **Extend this object**
    with the new fields below.
  - The auth hook is `if (authContext && url.pathname.startsWith("/auth/")) { if (await handleAuthRequest(...)) return; }`
    just before the `404` (lines ~259–266). No change needed there — new routes
    go through the same `resolveAuthRoute`.
  - `shutdown` closes `authContext?.userStore.close()` (line ~430) — add the
    project store's `close()` alongside it.
- `packages/protocol/src/index.ts:70` —
  `export function deriveProjectKey(masterSecret, repoId)` = `createHmac("sha256", masterSecret).update(repoId).digest("base64url")`.
  Deterministic. Import it from `@synapse/protocol`.
- The webhook handler (`apps/server/src/index.ts` `handleGitHubWebhook`, lines
  ~489+) already accepts signed push/PR/review events and, in project-key mode,
  binds them to `repository.full_name`. **Do not touch it.** Once the App is
  installed on a repo, GitHub delivers that repo's events here automatically — the
  ship-trail acceptance criterion is satisfied by this existing path.

### How GitHub App installation provides push-access truth (design note)

The App must have **"Request user authorization (OAuth) during installation"**
enabled. Then after the Owner installs, GitHub redirects to the App's configured
**Setup URL** with `?installation_id=<n>&setup_action=install&code=<oauth-code>&state=<ours>`.
The server: verifies the session + state, exchanges `code` for the **user** access
token (reuses `exchangeCodeForToken`), then lists the repos in that installation
that the user can access via `GET /user/installations/{installation_id}/repositories`
(each repo carries a `permissions.push` boolean). Repos with `push !== true` are
rejected (not claimed). This proves "the installing Owner has push access" using
GitHub as the source of truth, without persisting a long-lived user token.

**All GitHub network calls are injectable** so the acceptance tests are hermetic.

### Conventions to match

- Tests: `node:test` + `node:assert/strict`, `*.test.ts` beside source. Server
  `npm test` compiles (`tsc -b`) then runs `node --test dist` (recursive — picks
  up `dist/auth/*.test.js`). Model new tests on `apps/server/src/auth/routes.test.ts`.
- TypeScript strict, ESM, `.js` import specifiers for local files.
- NO new dependencies. Use `node:crypto`, global `fetch`, `better-sqlite3`, `pg`.
- Small focused functions, explicit return types, `isRecord`/`stringAt`-style
  narrowing (copy from `github-oauth.ts`).

## Commands you will need (run from repo root /private/tmp/synapse-issue-104)

| Purpose | Command | Expected |
|---|---|---|
| Install (FIRST, fresh worktree) | `npm install` | exit 0 |
| Build server | `npm run build --workspace @synapse/server` | exit 0 |
| Test server | `npm test --workspace @synapse/server` | all pass |
| Typecheck web | `npm run typecheck --workspace @synapse/web` | exit 0 |
| Build web | `npm run build --workspace @synapse/web` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Format check | `npm run format:check` | exit 0 |

Server tests are hermetic — in-memory SQLite, injected GitHub calls, no network.

## Scope

**In scope** (create unless noted):
- `apps/server/src/auth/project-store.ts` (create)
- `apps/server/src/auth/github-app.ts` (create)
- `apps/server/src/auth/project-store.test.ts` (create)
- `apps/server/src/auth/github-app.test.ts` (create)
- `apps/server/src/auth/routes.ts` (modify — add the 3 project routes + extend `AuthContext`)
- `apps/server/src/auth/routes.test.ts` (modify — add project-claim test cases)
- `apps/server/src/index.ts` (modify — extend the `authContext` object + close the project store)
- `apps/web/src/auth.ts` (modify — add `fetchProjects()` + `Project` type)
- `apps/web/src/auth.test.ts` (modify — pure helper assertions if you add one)
- `apps/web/src/components/TopbarAuth.tsx` (modify — add an "Add project" link in the logged-in state)
- `README.md`, `synapse-technical-spec.md` (modify — document the claim flow + `SYNAPSE_GITHUB_APP_SLUG` env)

**Out of scope** (do NOT touch):
- `apps/server/src/index.ts` `handleGitHubWebhook`, `authorized()`, WS handshake,
  `/state` — webhooks already work; don't refactor them.
- `apps/server/src/github-app-config.ts` and its test — read the slug from
  `process.env` in `index.ts` instead.
- `apps/server/src/store.ts` / `store-pg.ts` (TeamState store).
- Installation **access-token / App-JWT minting** — not needed (webhooks flow
  automatically; verification uses the user token). Do NOT add `jsonwebtoken` or
  RS256 signing.
- The dashboard rendering of the project list — that is issue #106. Keep the web
  change to the "Add project" affordance + a `fetchProjects` helper only.
- Storing the user access token long-term — exchange it, use it for the one
  push-access check, discard it.

## Git workflow

- Already on branch `feat/claim-project` in this worktree. Do NOT create a new branch.
- Conventional commits (e.g. `feat(server): claim repos via GitHub App install (#104)`).
- Do NOT push or open a PR — the reviewer/operator handles that.

## Steps

### Step 1: Project store — `apps/server/src/auth/project-store.ts`

Model on `user-store.ts` exactly (SQLite default + lazy-pg, `:memory:` default).

```ts
export interface Project { ownerId: string; repoId: string; projectKey: string; }
export interface ProjectStore {
  // Idempotent on (ownerId, repoId): the key is minted ONCE per repo for the owner.
  // On repeat, keep the existing row (do nothing) and return the stored project.
  claimProject(ownerId: string, repoId: string, projectKey: string): Promise<Project>;
  listProjectsForOwner(ownerId: string): Promise<Project[]>;
  getProject(ownerId: string, repoId: string): Promise<Project | null>;
  close(): Promise<void>;
}
export async function createProjectStore(options?: { databaseUrl?: string; path?: string }): Promise<ProjectStore>;
```

- Table: `projects (owner_id TEXT NOT NULL, repo_id TEXT NOT NULL, project_key TEXT NOT NULL, PRIMARY KEY (owner_id, repo_id))`.
- `claimProject`: `INSERT ... ON CONFLICT(owner_id, repo_id) DO NOTHING` then
  `SELECT` and return the row (so a repeat keeps the original key — "minted once").
- `listProjectsForOwner`: `SELECT ... WHERE owner_id = ?` → the owner sees only
  their own projects (the "only that Owner" criterion).
- ponytail: same-file second SQLite handle like `user-store.ts`; shared PG for multi-instance.

**Verify**: `npm run build --workspace @synapse/server` → exit 0.

### Step 2: GitHub App helpers — `apps/server/src/auth/github-app.ts`

Injectable-fetch, mirroring `github-oauth.ts`.

```ts
export interface ClaimedRepo { fullName: string; pushAccess: boolean; }
type FetchFn = typeof fetch;

// https://github.com/apps/<slug>/installations/new?state=<signed>
export function buildInstallUrl(appSlug: string, state: string): string;

// GET https://api.github.com/user/installations/{installationId}/repositories
// (Authorization: Bearer <userToken>, Accept: application/vnd.github+json, User-Agent)
// → { repositories: [{ full_name, permissions: { push } }] } mapped to ClaimedRepo[].
export async function listInstallationReposForUser(
  installationId: string, userToken: string, fetchFn?: FetchFn
): Promise<ClaimedRepo[]>;
```

- `buildInstallUrl`: use `new URL(...)`, `searchParams.set("state", state)`.
- `listInstallationReposForUser`: throw a clear `Error` on non-2xx; narrow JSON
  with `isRecord`; `pushAccess` = `repo.permissions?.push === true` (default false
  when absent). Map `full_name` (string) → `fullName`; skip entries without a
  string `full_name`.

**Verify**: covered by `github-app.test.ts` in Step 5.

### Step 3: Routes — extend `apps/server/src/auth/routes.ts`

Extend `AuthContext` with the new fields (keep all existing ones):
```ts
export interface AuthContext {
  // ...existing...
  appSlug: string | null;            // SYNAPSE_GITHUB_APP_SLUG; null disables claiming
  masterSecret: string;              // SYNAPSE_MASTER_SECRET; "" disables claiming
  projectStore: ProjectStore;
  // Injected GitHub-App seam (tests pass a canned impl):
  listInstallationReposForUser: (installationId: string, userToken: string) => Promise<ClaimedRepo[]>;
}
```

Add a small helper inside the file:
```ts
function requireOwner(cookies, ctx): { userId: string } | null  // verifySession(cookies[SESSION_COOKIE], ctx.sessionKey)
```

Add these routes inside `resolveAuthRoute`, BEFORE the final `404` fallback:

1. `GET /auth/projects/add` — start the install flow.
   - `const owner = requireOwner(cookies, ctx); if (!owner) return { status: 401, body: { error: "unauthenticated" } };`
   - if `!ctx.appSlug || !ctx.masterSecret` → `{ status: 503, body: { error: "claiming_unavailable" } }`.
   - `const state = signState(ctx.sessionKey);` (reuse existing helper)
   - return `{ status: 302, redirect: buildInstallUrl(ctx.appSlug, state), setCookies: [ serializeCookie("synapse_install_state", state, { httpOnly:true, sameSite:"Lax", secure: ctx.isSecure, maxAgeSec: 600, path:"/" }) ] }`.

2. `GET /auth/github/setup` — the App Setup URL callback.
   - `const owner = requireOwner(cookies, ctx); if (!owner) return 401 unauthenticated.`
   - verify state: `if (!verifyStateSigned(query.get("state"), cookies["synapse_install_state"], ctx.sessionKey)) return { status: 400, body: { error: "bad_state" } };`
   - `const installationId = query.get("installation_id"); const code = query.get("code");`
     if either missing → `{ status: 400, body: { error: "missing_installation" } }`.
   - `try { const userToken = await ctx.exchangeCodeForToken(code); const repos = await ctx.listInstallationReposForUser(installationId, userToken); }
     catch { return { status: 502, body: { error: "github_install_failed" } }; }`
   - `const claimable = repos.filter(r => r.pushAccess);`
   - for each `r` of claimable:
     `const key = deriveProjectKey(ctx.masterSecret, r.fullName); await ctx.projectStore.claimProject(owner.userId, r.fullName, key);`
   - return `{ status: 302, redirect: "/", setCookies: [ clearCookie("synapse_install_state") ] }`.
   - Note: repos without push access are simply not claimed (the rejection
     criterion). Do not throw on them.

3. `GET /auth/projects` — list the owner's projects.
   - `const owner = requireOwner(cookies, ctx); if (!owner) return 401.`
   - `const projects = await ctx.projectStore.listProjectsForOwner(owner.userId);`
   - return `{ status: 200, body: { projects: projects.map(p => ({ repoId: p.repoId, projectKey: p.projectKey })) } }`.
   - The project-key IS the Owner's own per-repo daemon credential — returning it
     to the authenticated Owner is intended (they need it to configure their
     daemon at onboarding, #105). It is never returned to anyone else.

Import `deriveProjectKey` from `@synapse/protocol`, `buildInstallUrl` +
`listInstallationReposForUser` + `ClaimedRepo` from `./github-app.js`,
`ProjectStore` from `./project-store.js`.

**Verify**: `npm run build --workspace @synapse/server` → exit 0.

### Step 4: Wire into the server — `apps/server/src/index.ts`

In the `authContext` builder (the `githubApp.status === "configured"` branch),
after creating `userStore`, also:
```ts
const projectStore = await createProjectStore();
// ...inside the returned object:
appSlug: process.env.SYNAPSE_GITHUB_APP_SLUG ?? null,
masterSecret,                       // the module-level const already read at top
projectStore,
listInstallationReposForUser: (installationId, userToken) =>
  listInstallationReposForUser(installationId, userToken),
```
Add imports for `createProjectStore` and `listInstallationReposForUser`. Add
`authContext?.projectStore.close()` to the `shutdown` `Promise.allSettled([...])`.
Do NOT change `handleGitHubWebhook`, `authorized`, the WS handshake, or `/state`.

**Verify**: `npm run build --workspace @synapse/server` → exit 0.

### Step 5: Tests (the acceptance-criteria tests)

`apps/server/src/auth/project-store.test.ts`:
- `:memory:`: `claimProject(o,"a/b",k1)` then `claimProject(o,"a/b",k2)` →
  `getProject` returns the FIRST key (minted once per repo).
- `listProjectsForOwner("o1")` returns o1's repos and NOT o2's (isolation).

`apps/server/src/auth/github-app.test.ts`:
- `buildInstallUrl("my-app", "st")` contains `/apps/my-app/installations/new` and `state=st`.
- `listInstallationReposForUser` with injected fetch returning
  `{ repositories: [{ full_name:"o/r1", permissions:{push:true} }, { full_name:"o/r2", permissions:{push:false} }] }`
  → `[{fullName:"o/r1",pushAccess:true},{fullName:"o/r2",pushAccess:false}]`.
- non-ok response → rejects.

`apps/server/src/auth/routes.test.ts` (extend) — build an `AuthContext` with a
`:memory:` projectStore, a seeded session for owner id `"42"`, `appSlug:"my-app"`,
`masterSecret:"test-master"`, injected `exchangeCodeForToken: async()=>"utok"`, and
an injected `listInstallationReposForUser` returning one push repo + one non-push
repo. Drive `resolveAuthRoute` directly:
- **ownership written on install**: drive `GET /auth/projects/add` to get the
  install-state cookie+value, then `GET /auth/github/setup?installation_id=1&code=c&state=<state>`
  with the matching cookie → status 302, redirect "/", and
  `projectStore.getProject("42","o/r1")` exists with key `deriveProjectKey("test-master","o/r1")`.
- **non-push-access repo rejected**: after the same setup call,
  `projectStore.getProject("42","o/r2")` is `null`.
- **key minted once per repo**: run the setup flow twice (fresh state each time);
  the stored key for `o/r1` is unchanged (idempotent).
- **claim requires a session**: `GET /auth/projects/add` with empty cookies → 401.
- **`/auth/projects` returns only the owner's projects**: after a claim, with the
  owner session cookie → 200 and body `projects` includes `o/r1` with its key;
  with a different owner's session → does not include `o/r1`.
- **bad install state** → 400; **missing installation_id/code** → 400.

Model structure on the existing `routes.test.ts` `makeCtx`/`freshState` helpers —
add a `freshInstallState` analog that drives `/auth/projects/add`.

**Verify**: `npm test --workspace @synapse/server` → all pass, including the new tests.

### Step 6: Web — `apps/web/src/auth.ts` + `TopbarAuth.tsx`

- `apps/web/src/auth.ts`: add
  ```ts
  export interface Project { repoId: string; projectKey: string; }
  export async function fetchProjects(): Promise<Project[]>; // GET /auth/projects {credentials:"include"} → body.projects, [] on non-200
  ```
- `apps/web/src/components/TopbarAuth.tsx`: in the logged-in branch (where the
  handle + Sign out render), add an "Add project" control:
  `<Button asChild size="sm" variant="secondary"><a href="/auth/projects/add">Add project</a></Button>`.
  Keep it minimal — do NOT build a project list UI here (that's #106).
- If you add any pure helper, add one assertion to `apps/web/src/auth.test.ts`.
  Otherwise leave the web tests as-is (the topbar change is presentational glue).

**Verify**: `npm run typecheck --workspace @synapse/web` → 0; `npm test --workspace @synapse/web` → pass; `npm run build --workspace @synapse/web` → 0.

### Step 7: Documentation

- `README.md` — under the sign-in section, add "Claim a Project": "Add project"
  → GitHub App install (requires "Request user authorization during installation"
  enabled on the App) → setup callback verifies push access, records Owner↔repo,
  mints the per-repo project-key via `deriveProjectKey(SYNAPSE_MASTER_SECRET, repoId)`.
  Document the new optional env `SYNAPSE_GITHUB_APP_SLUG` (the App's URL slug,
  used to build the install URL) and that `SYNAPSE_MASTER_SECRET` must be set for
  claiming (project-key tenancy mode). State that installing the App makes the
  repo's webhooks live automatically — no separate webhook setup.
- `synapse-technical-spec.md` — add the ownership model (Owner↔repo, project-key
  minted at claim) to the trust-boundary section.
- No new ADR (implements ADR-0001). No manual CHANGELOG.

**Verify**: `npm run format:check` and `npm run lint` → exit 0.

## Done criteria (ALL must hold)

- [ ] `npm run build --workspace @synapse/server` exits 0
- [ ] `npm test --workspace @synapse/server` exits 0, incl. new tests covering:
      ownership written on install, non-push-access repo rejected, key minted once per repo
- [ ] `npm run typecheck --workspace @synapse/web` exits 0
- [ ] `npm test --workspace @synapse/web` exits 0
- [ ] `npm run build --workspace @synapse/web` exits 0
- [ ] `npm run lint` exits 0 and `npm run format:check` exits 0
- [ ] `git grep -n "jsonwebtoken\|RS256\|createSign" apps/server/src/auth` returns nothing (no App-JWT minting was added)
- [ ] `apps/server/src/index.ts` `handleGitHubWebhook`/`authorized()`/WS/`/state` unchanged (diff shows only the authContext additions + the close() line)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 052 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows the listed files changed since `179e009` and the
  excerpts no longer match (especially the `AuthContext` shape or `signState`/
  `verifyStateSigned` helpers in `routes.ts`).
- `deriveProjectKey`'s signature differs from `(masterSecret, repoId)`.
- Making the tests hermetic appears to require a real network call or real
  RS256 App-JWT minting — it must not; the design injects
  `listInstallationReposForUser` and `exchangeCodeForToken`.
- You find you must modify `handleGitHubWebhook`, `authorized()`, or any
  daemon/WS/`/state` path — that means the boundary is being crossed; stop.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Boundary**: the project-key is the *daemon* credential for that repo; it is
  returned only to the authenticated Owner who claimed the repo (via
  `GET /auth/projects`). The OAuth session still never acts as a daemon
  credential directly — it only lets the Owner read/mint their own keys.
- **App setting dependency**: the setup flow needs "Request user authorization
  during installation" ON so the setup callback carries an OAuth `code`. If that
  is off, `code` will be absent and `/auth/github/setup` returns 400
  `missing_installation` — document this in the runbook (README).
- **#105** (show the connect command) consumes `GET /auth/projects` (repoId +
  projectKey). **#106** (dashboard list) renders `fetchProjects()`. **#107**
  (kick an agent) builds on the ownership record written here.
- **Re-install / repo added later**: GitHub sends `installation_repositories`
  webhooks; this plan claims on the interactive setup callback only. Auto-claiming
  on that webhook is a deferred follow-up (note it, don't build it here).
- Reviewer should scrutinize: that non-push repos are never written; that the
  user token is used once and discarded (never stored); that `masterSecret`/
  `appSlug` absence degrades to 503, not a crash.
