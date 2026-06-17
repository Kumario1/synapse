# Plan 051: Sign in with GitHub end-to-end (human cookie-session boundary on apps/server)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 9b221f6..HEAD -- apps/server/src/index.ts apps/server/src/github-app-config.ts apps/web/src/Landing.tsx apps/web/src/App.tsx`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (new trust boundary — security-sensitive: cookie signing, CSRF state, secret handling)
- **Depends on**: plans/050-register-github-app-secrets.md (DONE — merged as PR #116; provides `loadGitHubAppConfig` and the `SYNAPSE_GITHUB_APP_*` env boundary)
- **Category**: direction (feature) / security
- **Planned at**: commit `9b221f6`, 2026-06-17
- **Issue**: https://github.com/Kumario1/synapse/issues/103

## Why this matters

This is the first human trust boundary on the product. Today the topbar "Sign up"
button is a dead stub pointing at `/auth/github` (a route that 404s). After this
plan, clicking it runs the GitHub App's user-to-server OAuth flow, creates a user
on first login, and establishes a signed cookie session; the topbar then reflects
the logged-in Owner and offers sign-out. Per `docs/adr/0001-hosted-saas-with-github-only-ownership.md`,
this is hand-rolled (no hosted auth provider) and lives in the existing Node
http+ws server. **The human cookie-session boundary must stay strictly distinct
from the machine daemon↔server credential** (`project-key`/`shared-token`): an
OAuth session is never a daemon credential and never authorizes a WS room or
`/state`. This plan only establishes identity + session; claiming repos is a
separate issue (#104).

## Current state

The server is a single hand-rolled Node `http` + `ws` server. Key facts:

- `apps/server/src/index.ts` — the whole server. HTTP routing is a flat
  if-ladder inside `handleHttp(request, response)` (lines ~145–231), ending in a
  `404 not_found` fallback at line 230. Existing routes: `GET /health`,
  `GET /metrics`, `GET /state`, `POST /recall`, `POST /webhooks/github`.
  Helpers already defined and reusable: `readBody(request)` (line ~823),
  `writeJson(response, status, body)` (line ~890), `headerValue(request, name)`
  (line ~881). The machine-auth function `authorized(...)` (line ~847) is for the
  daemon boundary — **do not reuse it for the human session; keep them separate.**
- `apps/server/src/index.ts:59` already loads the app config:
  `const githubApp = loadGitHubAppConfig();` and `githubApp.status` is one of
  `"disabled" | "configured" | "incomplete"` (reported on `/health`).
- `apps/server/src/github-app-config.ts` — `loadGitHubAppConfig(env?)` returns,
  when `status === "configured"`, `{ status, webhookSecret, config }` where
  `config: { appId, clientId, clientSecret, privateKey, webhookSecret }`. The
  `clientId`/`clientSecret` are the OAuth credentials this plan uses.
- `apps/server/src/store.ts` — durable persistence is **per-repo TeamState only**;
  it is not a user store. `createStateStore()` branches on
  `SYNAPSE_DATABASE_URL` (Postgres via the already-present `pg` dep) else
  `SYNAPSE_DB_PATH`/`:memory:` (SQLite via `better-sqlite3`). Mirror this
  backend-selection shape for the new user store, but in a **separate** module —
  do not entangle users into the TeamState store.
- `apps/web/src/Landing.tsx:81-88` — the topbar. The "Sign up" button is a static
  `<a href="/auth/github">`, with a `ponytail:` comment noting the route lands
  with the auth work. Replace this with an auth-aware control.
- `apps/web/src/App.tsx` — renders `<Landing mode={...} />`. The web is a static
  Vite SPA; it talks to a server only when a `?server=` query param is present
  (see `apps/web/src/feed.ts`). There is **no** vite dev proxy. So the topbar's
  `/auth/me` call is same-origin: it works when the SPA is served from the
  Synapse server's origin (the hosted production model), and in plain `vite dev`
  it simply returns not-logged-in (fetch fails / 404) and the Sign up button
  shows. That is acceptable for this plan.

### Conventions to match

- **Tests**: `node:test` + `node:assert/strict`, files named `*.test.ts` beside
  the source. Pure-unit style — see `apps/server/src/github-app-config.test.ts`
  for the exact shape (`import test from "node:test"`, `assert.deepEqual`, no
  framework). Server `npm test` runs `node --import tsx --test src/**/*.test.ts`
  (see `apps/server/package.json`).
- **TypeScript**: strict, ESM, `.js` import specifiers for local files (e.g.
  `import { loadGitHubAppConfig } from "./github-app-config.js";`). Match this —
  `tsc` will fail otherwise.
- **No new dependencies.** Everything here uses `node:crypto`, `node:http`,
  global `fetch` (Node ≥20), `better-sqlite3` and `pg` (both already deps). If
  you find yourself wanting a cookie/jwt/oauth library, STOP — the design below
  is deliberately library-free.
- **Style/error handling**: small focused functions, explicit return types,
  `unknown`-narrowing helpers (see `github.ts` `isRecord`/`stringAt`). Match it.

## Commands you will need

| Purpose   | Command                                                  | Expected on success |
|-----------|----------------------------------------------------------|---------------------|
| Build server | `npm run build --workspace @synapse/server`           | exit 0              |
| Test server  | `npm test --workspace @synapse/server`                | all pass            |
| Typecheck web | `npm run typecheck --workspace @synapse/web`         | exit 0, no errors   |
| Build web    | `npm run build --workspace @synapse/web`              | exit 0              |
| Lint         | `npm run lint`                                         | exit 0              |
| Format check | `npm run format:check`                                | exit 0              |

(Run from the repo root. Server tests are hermetic — in-memory SQLite, no network.)

## Scope

**In scope** (create unless noted):
- `apps/server/src/auth/user-store.ts` (create)
- `apps/server/src/auth/session.ts` (create)
- `apps/server/src/auth/github-oauth.ts` (create)
- `apps/server/src/auth/routes.ts` (create)
- `apps/server/src/auth/session.test.ts` (create)
- `apps/server/src/auth/github-oauth.test.ts` (create)
- `apps/server/src/auth/routes.test.ts` (create)
- `apps/server/src/index.ts` (modify — wire the auth router into `handleHttp` and build the auth context at startup)
- `apps/server/src/user-store.test.ts` is NOT used — put the user-store test in `apps/server/src/auth/user-store.test.ts` (create)
- `apps/web/src/auth.ts` (create — `fetchMe`, `signOut`, and a pure `authView` helper)
- `apps/web/src/auth.test.ts` (create — pure helper test)
- `apps/web/src/components/TopbarAuth.tsx` (create — the auth-aware topbar control)
- `apps/web/src/Landing.tsx` (modify — swap the static Sign up button for `<TopbarAuth />`)
- `README.md`, `synapse-technical-spec.md` (modify — document the new boundary + env)

**Out of scope** (do NOT touch):
- `apps/server/src/index.ts`'s `authorized(...)` machine-auth function and the
  WS/`/state`/webhook paths — the human session must not grant daemon access.
- `apps/server/src/store.ts` / `store-pg.ts` — do not add users to the TeamState store.
- Repo claiming, installation tokens, listing repos, the dashboard — issues #104–#107.
- Storing the user's GitHub **access token** — not needed for identity; #104 can
  add it. (Leave a `ponytail:` note where you'd add it.)
- Any second OAuth provider (Google etc.) — ADR-0001 rejected it.

## Git workflow

- Work is already on branch `feat/github-signin` in this worktree. Do NOT create
  a new branch.
- Conventional-commits style, matching `git log` (e.g.
  `feat(server): github sign-in with cookie sessions (#103)`).
- Do NOT push or open a PR — the reviewer/operator handles that.

## Design (read fully before writing code)

Stateless signed cookie session (no sessions table — sign-out just clears the
cookie; revocation isn't an acceptance criterion). One small users table for
identity. CSRF-protected via a signed `state` value echoed in a short-lived
cookie. Session HMAC key is **derived** from the OAuth `clientSecret` so no 6th
env var is needed.

### Step 1: User store — `apps/server/src/auth/user-store.ts`

A minimal identity store, backend-selected exactly like `createStateStore`.

```ts
export interface OwnerUser {
  id: string;          // GitHub numeric user id, as string (stable identity key)
  login: string;       // GitHub handle
  name: string | null;
  avatarUrl: string | null;
}

export interface UserStore {
  // Idempotent on `id`: first call inserts, repeats update login/name/avatar.
  upsertUser(user: OwnerUser): Promise<OwnerUser>;
  getUserById(id: string): Promise<OwnerUser | null>;
  close(): Promise<void>;
}
```

- SQLite impl (`better-sqlite3`, default): table
  `users (id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT)`.
  `upsertUser` = `INSERT ... ON CONFLICT(id) DO UPDATE SET login=excluded.login,
  name=excluded.name, avatar_url=excluded.avatar_url`. Construct with the same
  path logic as `SqliteStateStore` (`:memory:` when no path). Reuse the
  `SYNAPSE_DB_PATH` knob? No — keep users in their own table but the same DB file
  is fine; open a second connection to the same path (`better-sqlite3` allows it,
  WAL mode). ponytail: same-file second handle, fine for a single instance; a
  shared PG store is the multi-instance upgrade (below).
- Postgres impl (`pg`, lazy `await import`): table
  `users (id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT)`,
  `INSERT ... ON CONFLICT (id) DO UPDATE`. `CREATE TABLE IF NOT EXISTS` in an
  `init()` called by the factory.
- `export async function createUserStore(options?: { databaseUrl?: string; path?: string }): Promise<UserStore>`
  — branch on `options.databaseUrl ?? process.env.SYNAPSE_DATABASE_URL` (Postgres),
  else `options.path ?? process.env.SYNAPSE_DB_PATH` else `:memory:` (SQLite).
  Mirror `createStateStore` in `store.ts:350-363`.

**Verify**: `npm run build --workspace @synapse/server` → exit 0.

### Step 2: Session cookie — `apps/server/src/auth/session.ts`

Library-free signed cookie. Use `node:crypto` `createHmac` + `timingSafeEqual`.

```ts
// Token = base64url(JSON{uid,iat}) + "." + base64url(HMAC-SHA256(key, payload))
export function signSession(userId: string, key: Buffer, now = Date.now()): string;
export function verifySession(token: string | undefined, key: Buffer, maxAgeMs?: number): { userId: string } | null;

// Derive the session HMAC key from the OAuth client secret — no extra env var.
// ponytail: derived key; add SYNAPSE_SESSION_SECRET only if key rotation is needed.
export function sessionKeyFromClientSecret(clientSecret: string): Buffer; // = createHmac('sha256', clientSecret).update('synapse-session-v1').digest()

// Cookie header helpers (no dependency):
export function parseCookies(header: string | null): Record<string, string>;
export function serializeCookie(name: string, value: string, opts: { maxAgeSec?: number; httpOnly?: boolean; sameSite?: "Lax" | "Strict"; secure?: boolean; path?: string }): string;
```

- `verifySession` returns `null` on: missing token, malformed, bad signature
  (constant-time compare), or expired (`maxAgeMs` default 30 days). Never throw.
- Session cookie name: `synapse_session`. Default attributes when set by routes:
  `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (+ `Secure` when the request
  origin is https). `SameSite=Lax` is required so the cookie is sent on the
  top-level GET redirect back from GitHub.

**Verify**: covered by `session.test.ts` in Step 6.

### Step 3: GitHub OAuth — `apps/server/src/auth/github-oauth.ts`

Pure functions with an **injectable fetch** so tests never hit the network.

```ts
export interface OAuthCreds { clientId: string; clientSecret: string; }
export interface GitHubUser { id: string; login: string; name: string | null; avatarUrl: string | null; }
type FetchFn = typeof fetch;

// https://github.com/login/oauth/authorize?client_id&state&redirect_uri&allow_signup=true
export function buildAuthorizeUrl(creds: OAuthCreds, state: string, redirectUri: string): string;

// POST https://github.com/login/oauth/access_token  (Accept: application/json)
// body: client_id, client_secret, code, redirect_uri  → { access_token }
export async function exchangeCodeForToken(creds: OAuthCreds, code: string, redirectUri: string, fetchFn?: FetchFn): Promise<string>;

// GET https://api.github.com/user  (Authorization: Bearer, User-Agent: synapse-server)
// → map { id, login, name, avatar_url } to GitHubUser (id stringified)
export async function fetchGitHubUser(accessToken: string, fetchFn?: FetchFn): Promise<GitHubUser>;
```

- `fetchFn` defaults to global `fetch`. Throw a clear `Error` on non-2xx or a
  response missing `access_token`/`id` (the route maps these to a 502/400).
- Narrow untyped JSON with `isRecord`-style guards (copy the helper from
  `github.ts` or inline a small one). `id` from GitHub is a number → `String(id)`.

**Verify**: covered by `github-oauth.test.ts` in Step 6.

### Step 4: Route resolver + adapter — `apps/server/src/auth/routes.ts`

Split the **decision** (pure, testable) from the **node http plumbing** (thin).

```ts
export interface AuthContext {
  creds: OAuthCreds;            // from githubApp.config (clientId/clientSecret)
  sessionKey: Buffer;           // sessionKeyFromClientSecret(clientSecret)
  userStore: UserStore;
  redirectUri: string;          // `${publicOrigin}/auth/github/callback`
  // Injected for tests; default to the real github-oauth fns in index.ts wiring.
  exchangeCodeForToken: (code: string) => Promise<string>;
  fetchGitHubUser: (token: string) => Promise<GitHubUser>;
  isSecure: boolean;            // request origin is https → Secure cookies
}

export interface RouteResult {
  status: number;
  body?: unknown;                       // JSON-encoded by the adapter
  redirect?: string;                    // Location header
  setCookies?: string[];                // Set-Cookie header values
}

// Pure-ish core — this is what the tests drive.
export async function resolveAuthRoute(
  method: string, pathname: string,
  query: URLSearchParams, cookies: Record<string, string>,
  ctx: AuthContext
): Promise<RouteResult | null>;          // null = not an /auth/* route → caller 404s

// Thin adapter used by index.ts.
export async function handleAuthRequest(
  request: IncomingMessage, response: ServerResponse, url: URL, ctx: AuthContext
): Promise<boolean>;                      // true = handled (response written)
```

Routes handled by `resolveAuthRoute`:

1. `GET /auth/github` → generate `state` = `signSession`-style signed random
   nonce (or `randomUUID()` signed with `sessionKey`); return
   `{ status: 302, redirect: buildAuthorizeUrl(...), setCookies: [serializeCookie("synapse_oauth_state", state, { httpOnly, sameSite:"Lax", secure:isSecure, maxAgeSec: 600, path:"/" })] }`.
2. `GET /auth/github/callback` →
   - read `code` and `state` from `query`; read `synapse_oauth_state` from
     `cookies`. If `state` missing/!= cookie → `{ status: 400, body:{error:"bad_state"} }`
     (CSRF guard). If `code` missing → `{ status: 400, body:{error:"missing_code"} }`.
   - `token = await ctx.exchangeCodeForToken(code)`; `gh = await ctx.fetchGitHubUser(token)`.
     Wrap in try/catch → on failure `{ status: 502, body:{error:"github_exchange_failed"} }`.
   - `user = await ctx.userStore.upsertUser({ id: gh.id, login: gh.login, name: gh.name, avatarUrl: gh.avatarUrl })`.
   - `session = signSession(user.id, ctx.sessionKey)`.
   - return `{ status: 302, redirect: "/", setCookies: [ sessionCookie(session), clearCookie("synapse_oauth_state") ] }`.
3. `GET /auth/me` → `verifySession(cookies.synapse_session, sessionKey)`; if null
   → `{ status: 401, body:{error:"unauthenticated"} }`; else
   `user = await userStore.getUserById(uid)`; if null → 401; else
   `{ status: 200, body:{ owner: { login, name, avatarUrl } } }`.
4. `POST /auth/logout` (also accept `GET /auth/logout` for a plain link) →
   `{ status: 200, body:{ ok:true }, setCookies:[ clearCookie("synapse_session") ] }`
   where `clearCookie` = `serializeCookie(name, "", { maxAgeSec: 0, path:"/", httpOnly:true })`.
5. Any other `/auth/...` path → `{ status: 404, body:{error:"not_found"} }`.
6. A pathname not starting with `/auth/` → return `null`.

`handleAuthRequest` builds `cookies` via `parseCookies(headerValue(request,"cookie"))`,
calls `resolveAuthRoute`, and if non-null writes the response (status, any
`Set-Cookie` header — note: multiple cookies → pass the array to
`response.setHeader("Set-Cookie", arr)`; `Location` for redirect; JSON body via
the existing `writeJson` shape or `response.end(JSON.stringify(body))`). Returns
`true`. If `resolveAuthRoute` returns `null`, return `false`.

### Step 5: Wire into the server — `apps/server/src/index.ts`

- Near the config load (after line 59–63), build the auth context **only when
  `githubApp.status === "configured"`**:
  ```ts
  import { createUserStore } from "./auth/user-store.js";
  import { handleAuthRequest, type AuthContext } from "./auth/routes.js";
  import { sessionKeyFromClientSecret } from "./auth/session.js";
  import { exchangeCodeForToken, fetchGitHubUser } from "./auth/github-oauth.js";
  // ...
  const publicOrigin = process.env.SYNAPSE_PUBLIC_URL ?? `http://${host}:${port}`;
  const authContext: AuthContext | null =
    githubApp.status === "configured"
      ? await (async () => {
          const userStore = await createUserStore();
          const creds = { clientId: githubApp.config.clientId, clientSecret: githubApp.config.clientSecret };
          return {
            creds,
            sessionKey: sessionKeyFromClientSecret(creds.clientSecret),
            userStore,
            redirectUri: `${publicOrigin}/auth/github/callback`,
            exchangeCodeForToken: (code: string) => exchangeCodeForToken(creds, code, `${publicOrigin}/auth/github/callback`),
            fetchGitHubUser: (token: string) => fetchGitHubUser(token),
            isSecure: publicOrigin.startsWith("https:")
          } satisfies AuthContext;
        })()
      : null;
  ```
- In `handleHttp`, **before** the final `writeJson(response, 404, ...)` (line 230):
  ```ts
  if (authContext && url.pathname.startsWith("/auth/")) {
    if (await handleAuthRequest(request, response, url, authContext)) return;
  }
  ```
- Add `userStore?.close()` to the `shutdown` Promise.allSettled list (line ~388),
  so the handle closes cleanly. (Hoist `authContext?.userStore` into a
  `let userStore` if simpler — your call, keep it minimal.)
- Do NOT change `authorized`, the WS handshake, `/state`, or the webhook path.

**Verify**: `npm run build --workspace @synapse/server` → exit 0.

### Step 6: Server tests (THE acceptance-criteria tests)

`apps/server/src/auth/session.test.ts`:
- sign→verify round-trips and yields the same `userId`.
- a tampered token (flip a char in payload or sig) → `verifySession` returns `null`.
- an expired token (`signSession(uid, key, Date.now() - 40*86400_000)` with default maxAge) → `null`.
- `parseCookies`/`serializeCookie` round-trip a couple values.

`apps/server/src/auth/github-oauth.test.ts`:
- `buildAuthorizeUrl` contains `client_id`, the `state`, and an encoded `redirect_uri`.
- `exchangeCodeForToken` with an injected `fetchFn` returning
  `{ ok:true, json: async () => ({ access_token: "tok" }) }` → resolves `"tok"`;
  a non-ok response → rejects.
- `fetchGitHubUser` with injected fetch returning `{ id: 42, login:"octo", name:"Octo", avatar_url:"u" }`
  → `{ id:"42", login:"octo", name:"Octo", avatarUrl:"u" }`.

`apps/server/src/auth/user-store.test.ts`:
- `:memory:` store: `upsertUser` twice with the same `id` (changed login) →
  `getUserById` returns one row with the updated login (**idempotency**).

`apps/server/src/auth/routes.test.ts` — drive `resolveAuthRoute` directly with a
`:memory:` user store and injected `exchangeCodeForToken`/`fetchGitHubUser`:
- **callback success**: state cookie matches `state` query; injected exchange →
  token, injected user → octocat. Assert `status===302`, `redirect==="/"`, a
  `synapse_session` Set-Cookie present, and `userStore.getUserById("42")` exists.
- **repeat-login idempotency**: run the callback twice (same gh id); assert the
  second also succeeds and the user store still has exactly one row for that id
  (add a tiny count helper in the test or call `getUserById` and assert stable).
- **unauthenticated `/auth/me`**: empty cookies → `status===401`.
- **authenticated `/auth/me`**: cookie `synapse_session = signSession(uid, key)`
  after seeding that user → `status===200`, body `owner.login` correct.
- **logout**: `POST /auth/logout` → 200 and a `synapse_session` Set-Cookie with
  `Max-Age=0`.
- **bad state**: callback with mismatched state cookie → `status===400`.

Model all of these on `apps/server/src/github-app-config.test.ts` for structure.

**Verify**: `npm test --workspace @synapse/server` → all pass, including the new tests.

### Step 7: Web topbar

`apps/web/src/auth.ts`:
```ts
export interface Owner { login: string; name: string | null; avatarUrl: string | null; }
export async function fetchMe(): Promise<Owner | null>;   // GET /auth/me {credentials:"include"} → 200 owner | null
export async function signOut(): Promise<void>;           // POST /auth/logout {credentials:"include"}
export type AuthView = { kind: "anon" } | { kind: "owner"; label: string };
export function authView(owner: Owner | null): AuthView;  // pure: label = owner.login (or name); test this
```

`apps/web/src/components/TopbarAuth.tsx` — a client component:
- `const [owner, setOwner] = useState<Owner | null>(null);`
  `useEffect(() => { fetchMe().then(setOwner).catch(() => setOwner(null)); }, []);`
- When `owner`: render the `@login` (and avatar if present) + a `Sign out`
  `<Button size="sm" variant="outline">` whose onClick does
  `await signOut(); window.location.reload();`.
- When `null`: render the existing Sign up button:
  `<Button asChild size="sm"><a href="/auth/github">Sign up</a></Button>`.
  Use the same shadcn `Button` import path already used in `Landing.tsx`
  (`@/components/ui/button`).

`apps/web/src/Landing.tsx` — replace lines 84–87 (the `ponytail:` comment + the
static Sign up `<Button>`) with `<TopbarAuth />`. Add the import.

`apps/web/src/auth.test.ts`:
- `authView(null)` → `{ kind:"anon" }`.
- `authView({ login:"octo", name:null, avatarUrl:null })` → `{ kind:"owner", label:"octo" }` (or `@octo` — match what you render).

**Verify**:
- `npm run typecheck --workspace @synapse/web` → exit 0.
- `npm test --workspace @synapse/web` → all pass.
- `npm run build --workspace @synapse/web` → exit 0.

### Step 8: Documentation

- `README.md` — add a short "Sign in with GitHub" subsection under the
  server/hosted section: the four routes (`GET /auth/github`,
  `GET /auth/github/callback`, `GET /auth/me`, `POST /auth/logout`), that auth is
  active only when the GitHub App env is `configured`, the new optional
  `SYNAPSE_PUBLIC_URL` env (used to build the OAuth `redirect_uri`; defaults to
  `http://host:port`), and the explicit statement that the OAuth cookie session
  is **not** a daemon credential.
- `synapse-technical-spec.md` — add the human browser↔server trust boundary
  alongside the existing machine boundary description; note the stateless signed
  cookie + derived session key.
- No new ADR — this implements the already-accepted `docs/adr/0001`. No manual
  CHANGELOG (semantic-release generates it from commits).

**Verify**: `npm run format:check` and `npm run lint` → exit 0.

## Done criteria

ALL must hold:

- [ ] `npm run build --workspace @synapse/server` exits 0
- [ ] `npm test --workspace @synapse/server` exits 0, including the new
      `auth/*.test.ts` covering callback success, repeat-login idempotency, and
      unauthenticated `/auth/me`
- [ ] `npm run typecheck --workspace @synapse/web` exits 0
- [ ] `npm test --workspace @synapse/web` exits 0 (new `auth.test.ts` passes)
- [ ] `npm run build --workspace @synapse/web` exits 0
- [ ] `npm run lint` exits 0 and `npm run format:check` exits 0
- [ ] `grep -rn "/auth/github" apps/web/src` shows the link only inside
      `TopbarAuth.tsx` (the static Landing stub is gone)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `apps/server/src/index.ts` `authorized()` / WS / `/state` / webhook code is unchanged
- [ ] `plans/README.md` status row for 051 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `apps/server/src/index.ts`, `github-app-config.ts`,
  `Landing.tsx`, or `App.tsx` changed since `9b221f6` and the "Current state"
  excerpts no longer match.
- `loadGitHubAppConfig`'s `configured` shape (`config.clientId` /
  `config.clientSecret`) differs from what's described.
- Making the tests hermetic appears to require a real network call to GitHub —
  it must not; the design injects `exchangeCodeForToken`/`fetchGitHubUser`.
- A step's verification fails twice after a reasonable fix attempt.
- You find you must modify `store.ts`/`store-pg.ts`, `authorized()`, or any
  daemon/WS path to make this work — that means the boundary separation is being
  violated; stop.

## Maintenance notes

For whoever owns this next:

- **Boundary**: any future change near auth must preserve the rule that an OAuth
  cookie session never authorizes a daemon WS room or `/state`. Reviewer: confirm
  `authorized()` and the WS handshake are untouched.
- **#104 (claim repos)** will need the GitHub user **access token** (to read repo
  push access). This plan deliberately does not persist it — add a column +
  encrypted-at-rest storage then, not here.
- **Session key is derived** from `clientSecret`; rotating the client secret
  invalidates all sessions (acceptable). If independent rotation is ever needed,
  introduce `SYNAPSE_SESSION_SECRET` and prefer it in `sessionKeyFromClientSecret`.
- **User store** opens a second handle to the same SQLite file (or a shared PG).
  For true multi-instance, ensure `SYNAPSE_DATABASE_URL` is set so users live in
  shared Postgres — single-instance SQLite is fine for now.
- **Dev parity**: `vite dev` shows signed-out state because there's no proxy to
  the server. If desired later, add a vite `server.proxy` for `/auth` and
  `/state` — out of scope here.
