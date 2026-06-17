# Plan 049: Expand the web surface — marketing landing, login-gated onboarding, account-bound live dashboard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Read first**: `apps/web/CONTEXT.md` (glossary: Account, Connection, Token,
> Server, Dashboard) and `docs/adr/0001-web-accounts-and-saved-connections.md`
> (the architecture decision). This plan implements that ADR. Do not re-litigate
> the decisions recorded there — if you believe one is wrong, STOP and report.
>
> **Versions are pinned on purpose** (the APIs differ across majors): **Next.js
> 15** (App Router) and **Auth.js v5** (`next-auth@^5`, a.k.a. `next-auth` beta /
> `@auth/core`). Do not use `next-auth@4` idioms (`getServerSession`,
> `authOptions`, `pages/api/auth/...`). Node is pinned to 20.19.2 (`.nvmrc`),
> which satisfies both.
>
> **Ship each Phase as its own PR** (see "Git workflow"). The phases are ordered
> so the repo builds and tests green at the end of every phase.
>
> **Drift check (run first)**: `git diff --stat ba1bd00..HEAD -- apps/web turbo.json`
> Expected: `apps/web` is still a Vite SPA — `apps/web/vite.config.ts` exists,
> `apps/web/package.json` `build` is `tsc -b && vite build`, and
> `apps/web/src/App.tsx` renders `<Landing>` + `<Dashboard>`. If `next` is
> already a dependency or a `next.config.*` exists, the migration has started —
> STOP and report.

## Status

- **Priority**: P2
- **Effort**: XL (framework migration + auth + persistence + 3 new pages)
- **Risk**: MED (migrates the only frontend; adds an auth + DB surface). No
  change to `apps/server`, the CLI, analyzers, or the coordination protocol.
- **Depends on**: none in `plans/`. Requires a GitHub OAuth app and a Postgres
  database to be provisioned (owner action — see "Owner prerequisites").
- **Category**: feature (web)
- **Planned at**: commit `ba1bd00`, 2026-06-16.
- **Issue**: [#98](https://github.com/Kumario1/synapse/issues/98)

## Why this matters

The website (`apps/web`) is the product's front door, yet today it is a single
Vite SPA that stacks a minimal `<Landing>` over a `<Dashboard>`, connected by
hand-editing `?server=&repoId=&token=` into the URL. There is no marketing story
beyond four feature cards, no onboarding for the CLI, and no notion of *your*
dashboard — every visit starts from a query string. We want a real marketing
landing page that pitches everything Synapse does, a login-gated onboarding flow
that teaches install + usage, and a dashboard that remembers the servers you
connect to. The ADR fixes the shape: GitHub-OAuth accounts that own **synced
Connection metadata only** (never the Token), with the browser still connecting
**directly** to the user's self-hosted Server.

## Owner prerequisites (not executor steps)

These require credentials and are done by the maintainer, not the AFK agent:

1. Register a **GitHub OAuth app**; set the callback to the deployment's
   `/api/auth/callback/github`. Provide `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`
   and an `AUTH_SECRET` (Auth.js v5 env-var names).
2. Provision a **Postgres** database (Neon via Vercel marketplace). Vercel/Neon
   inject a pooled connection string as **`DATABASE_URL`** — the web app uses
   that name (see Phase 3 for why it intentionally differs from the server's
   `SYNAPSE_DATABASE_URL`).
3. **Vercel project settings** (deploy config — not in this repo): switch the
   `apps/web` project's framework preset from **Vite to Next.js**. This is an
   owner action; the executor does not have dashboard access. Flagged again in
   "Maintenance notes".

The executor codes against these env vars and documents them in
`apps/web/.env.example`; it does **not** need live credentials to build,
typecheck, or run the unit tests (the in-memory `ConnectionStore` covers tests).

## Commands you will need

Run from the repo root. `@synapse/web` is an npm workspace (`workspaces: ["apps/*"]`).

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm install` | exit 0 |
| Web build | `npm run build -w @synapse/web` | exit 0 (`next build`, after Phase 0 rewrites the script) |
| Web typecheck | `npm run typecheck -w @synapse/web` | exit 0, no TS errors (`tsc --noEmit`) |
| Web unit tests | `npm run test -w @synapse/web` | all `node:test` tests pass — **runs directly via `tsx`, not gated on a build** |
| Web dev server | `npm run dev -w @synapse/web` | `next dev` serves on localhost |
| Repo-wide | `npm run build` / `npm test` (turbo) | exit 0 (turbo `test.dependsOn: ["build"]`, so the web build must be green first) |

> Note: until Phase 0 rewrites the four scripts in `apps/web/package.json`,
> `build`/`dev`/`typecheck` still invoke Vite. Verify commands in later phases
> assume Phase 0 has rewritten them.

## Git workflow

- Branch from `main`: `advisor/049-web-accounts-landing-dashboard` (matches the
  repo's `advisor/<slug>` convention seen in `git log`).
- **One PR per Phase** (Phase 0 → PR, Phase 1 → PR, …). Each phase leaves the
  repo green, so each PR is independently reviewable and revertible.
- Conventional-commit messages (repo convention), e.g.
  `feat(web): migrate apps/web from Vite to Next.js`.
- Do **not** push or open a PR unless the operator instructed it.

## Current state (excerpts — confirm these still match before editing)

`apps/web/package.json` scripts (Vite-bound — Phase 0 rewrites all four):

```json
"build": "tsc -b && vite build",
"typecheck": "tsc -b --pretty false",
"test": "node --import tsx --test src/*.test.ts",
"dev": "vite"
```

`apps/web/src/App.tsx` — the entry reads `window.location` to choose demo vs
live. This call **cannot run during SSR** (no `window`); Phase 0 moves it into a
client component:

```tsx
const feed = useMemo(() => createFeedFromLocation(window.location), []);
```

`apps/web/src/feed.ts` — the live-feed factory and the (currently **not
exported**) URL helper. Phase 5 builds on these exact shapes:

```ts
export function createLiveFeed(options: { server: string; repoId: string; token: string | null }): Feed { … }

function buildSocketUrl(options: { server: string; repoId: string; token: string | null }) {
  const url = new URL(options.server);
  url.searchParams.set("repoId", options.repoId);
  if (options.token) url.searchParams.set("token", options.token);
  return url.toString();
}
```

`apps/web/tsconfig.json` is `composite: true`, `jsx: "react-jsx"`,
`types: ["vite/client","node"]`, `references: [protocol]` — a Vite/`tsc -b`
config. Next.js needs a different one (Phase 0).

The persistence pattern to imitate (shape + tests only, **not** the schema):
`apps/server/src/store.ts` (interface + in-memory + SQLite, schema via
`CREATE TABLE IF NOT EXISTS`), `apps/server/src/store-pg.ts` (Postgres via
node-`pg` `Pool`, selected by `process.env.SYNAPSE_DATABASE_URL`), tested by
`apps/server/src/store.test.ts`. Note that store is **repo-scoped**; the new
`ConnectionStore` is **user-scoped** — copy the layering and test style, design
the schema fresh.

---

## Invariants (must hold at every phase — from the ADR)

- The website **never stores a Token**. The Token lives only in the browser
  (localStorage) and is sent only to the user's Server over the direct WS.
- The website **never proxies** coordination traffic. The browser connects
  directly to the `wss://` Server URL.
- A Connection persisted server-side is `{ label, serverUrl, repoId }` plus
  owner + timestamps — no secrets.
- Connection queries are **scoped to the authenticated account**. One account
  can never read or mutate another account's Connections.

## Phase 0 — Migrate `apps/web` from Vite to Next.js (no behavior change)

Goal: same two surfaces (public landing + public seeded demo dashboard) on
Next.js 15 App Router, with the feed/derive/graph **logic** reused verbatim.

**In scope**: `apps/web/package.json`, `apps/web/tsconfig.json`,
`apps/web/next.config.ts` (create), `apps/web/app/**` (create),
`apps/web/.gitignore`, `turbo.json`, and moving existing `src/*` modules.
**Out of scope**: `apps/server`, other packages, the protocol.

1. **Dependencies**: add `next@^15`, keep `react`/`react-dom@^18`. Remove
   `vite`, `@vitejs/plugin-react`. Delete `vite.config.ts` and `index.html`.
2. **Rewrite the four `package.json` scripts** (this is the step the old plan
   omitted):
   ```json
   "build": "next build",
   "dev": "next dev",
   "typecheck": "tsc --noEmit",
   "test": "node --import tsx --test \"src/**/*.test.ts\""
   ```
   The `test` script stays on `node:test`+`tsx` and runs **independently of the
   build** (so `derive.test.ts` is runnable even mid-migration). Broaden the glob
   to `src/**/*.test.ts` so co-located tests are found after files move.
3. **Replace `tsconfig.json`** with a Next-style config: drop `composite`,
   `references`, and `vite/client` types; set `"jsx": "preserve"`,
   `"moduleResolution": "bundler"`, `"noEmit": true`, `"plugins": [{ "name":
   "next" }]`, and add `"exclude": ["node_modules", ".next"]`. Keep the
   `@synapse/protocol` path via the workspace dependency (no project reference).
   Add the generated `next-env.d.ts` to includes.
4. **App Router skeleton**: create `app/layout.tsx` (imports `theme.css`) and
   `app/page.tsx`. Keep `theme.css`.
5. **Port components**: `Landing.tsx`, `Dashboard.tsx`, `FlowGraph.tsx`,
   `panels.tsx` become client components (`"use client"`). Move `feed.ts`,
   `derive.ts`, `fixture.ts` with their **logic unchanged**.
6. **Fix the `window` boundary** (the old plan said "unchanged" — it cannot be):
   `createFeedFromLocation(window.location)` must not run during SSR. Render the
   demo dashboard from a `"use client"` wrapper that, in a `useEffect`/client
   render, builds the feed — for the public landing it calls `createDemoFeed()`
   directly (no `window.location` read needed; the demo path takes no params).
   The `?server=` location-sniffing entry is **not** needed on the landing and
   is rebuilt properly in Phase 5.
7. **Turbo + gitignore**: add `.next/` (and `out/` if used) to
   `apps/web/.gitignore`; in `turbo.json`, ensure the web build's outputs include
   `.next/**` (either add to the shared `build.outputs` or scope per-package) so
   Turbo caches the right directory and never the stale `dist/**`.

**Testing**: `apps/web/src/derive.test.ts` must pass **unchanged** — it imports
pure functions and has no DOM/Vite coupling. This proves the port preserved the
derivation seam.

**Verify**:
- `npm run typecheck -w @synapse/web` → exit 0.
- `npm run build -w @synapse/web` → `next build` succeeds, emits `.next/`.
- `npm run test -w @synapse/web` → `derive.test.ts` green.
- `git status` → `.next/` is untracked/ignored, not staged.
- `npm run dev -w @synapse/web`, load `/`: landing renders (server-rendered) and
  the demo dashboard animates through `demoFrames` with **no console
  `window is not defined`** error and no `?server=` needed.

**STOP** if: the port requires changing the *logic* of `derive.ts`/`feed.ts`
(only call sites and the `window` boundary should move); or `next build` fails
because test files are being compiled (exclude `**/*.test.ts` from the Next
tsconfig `include` rather than deleting tests).

## Phase 1 — Full marketing landing page (public)

**In scope**: `apps/web/app/page.tsx` + new section components under
`apps/web/app/(marketing)/**` or `apps/web/app/components/**`; `theme.css`.

1. Sections, top to bottom: hero (README tagline + primary CTA), the problem
   (agents collide on edits), how it works (check → edit → report), a features
   section derived from the README's 13-row feature table, an **embedded live
   demo** (the seeded-feed dashboard from Phase 0), and a "Get Started" CTA that
   routes to `/login` (since `/get-started` is gated).
2. Marketing sections are **server components** (SSG) for SEO; only the embedded
   demo dashboard is the Phase 0 client component.
3. Footer: MIT license, "Built by Prince Kumar".

**Verify**: `curl -s localhost:3000/ | grep -i "<tagline text>"` finds the hero
copy in the **initial HTML** (proves SSR/SSG, not a JS-only bundle); the demo
dashboard still animates in the browser; `npm run build -w @synapse/web` has no
SSR/prerender errors.

## Phase 2 — GitHub OAuth login with Auth.js v5

**In scope**: `apps/web/auth.ts` (create), `apps/web/app/api/auth/[...nextauth]/route.ts`
(create), `apps/web/app/login/page.tsx` (create), `apps/web/middleware.ts` (create)
or per-page guards; `apps/web/.env.example`.

1. Add `next-auth@^5`. Create `auth.ts` with **only** the GitHub provider and a
   JWT session that carries a stable `userId`:
   ```ts
   import NextAuth from "next-auth";
   import GitHub from "next-auth/providers/github";
   export const { handlers, auth, signIn, signOut } = NextAuth({
     providers: [GitHub],
     callbacks: {
       jwt({ token, profile }) { if (profile?.id) token.userId = String(profile.id); return token; },
       session({ session, token }) { (session.user ??= {} as any).id = token.userId as string; return session; },
     },
   });
   ```
   Route handler: `export const { GET, POST } = handlers;`.
2. `/login` renders a single button calling `signIn("github")`.
3. **Gate** `/get-started` and `/dashboard`: in each gated server component,
   `const session = await auth(); if (!session) redirect("/login");`. (A
   `middleware.ts` matcher is an acceptable alternative — pick one, don't mix.)
   The landing `/` and the demo remain public.
4. Document `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_SECRET` in
   `.env.example` (names only, no values).

**Testing**: do **not** test the OAuth round-trip (third-party). Extract a pure
guard helper, e.g. `requireUser(session): { userId } | redirect`, and test
`authed → userId` and `unauthed → redirect-signal`. Keep it framework-free so
`node:test`+`tsx` runs it.

**Verify**: signed out, requesting `/get-started` or `/dashboard` 307-redirects
to `/login`; `/` and the demo return 200. Signed in (owner OAuth creds in a
local `.env`), both gated routes return 200.

**STOP** if Auth.js requires storing the Token or any Server secret to function
— it must not; auth is website identity only.

## Phase 3 — Connection persistence (metadata only)

**In scope**: `apps/web/lib/connection-store.ts` (+ in-memory + Postgres
backends), `apps/web/app/api/connections/route.ts` and
`apps/web/app/api/connections/[id]/route.ts`, tests; `apps/web/.env.example`.

1. **`ConnectionStore`** mirroring the *layering* of `apps/server/src/store.ts`
   (interface + in-memory backend for tests/dev + Postgres backend), but with a
   **user-scoped** schema:
   `connections(id, user_id, label, server_url, repo_id, created_at, updated_at)`.
   **No token column.**
2. **Postgres on serverless**: the server's `store-pg.ts` holds a long-lived
   node-`pg` `Pool` — correct for the daemon, **wrong for Next.js route handlers**
   (each serverless invocation is short-lived; a per-request `pg.Pool` exhausts
   Neon connections). Use the **`@neondatabase/serverless`** driver (or `pg`
   against Neon's **pooled** connection string) and a module-level singleton
   client. Create the table lazily with `CREATE TABLE IF NOT EXISTS` on first use
   (there is **no boot step** in serverless; the advisory-lock init pattern from
   the server does **not** apply).
3. **Env var**: the web app reads **`DATABASE_URL`** (the name Vercel/Neon
   inject). This intentionally differs from the server's `SYNAPSE_DATABASE_URL`
   because they are separate apps with separate databases — note this in
   `.env.example` so the divergence is not mistaken for a bug.
4. CRUD via Next route handlers under `/api/connections`. Every handler resolves
   `userId` from `auth()` (Phase 2) and **scopes every query to it**.

**Testing** (model after `apps/server/src/store.test.ts`):
- `ConnectionStore` CRUD against the in-memory backend.
- **Scoping**: a Connection created by user A is invisible/unmutable to user B
  (list/get/update/delete all reject or omit cross-account access).
- Handler-level: an unauthenticated request is rejected (401); an authenticated
  request only ever sees its own `userId`'s rows (inject a fake session object;
  do not spin up OAuth or Postgres — use the in-memory backend).

**Verify**: `npm run test -w @synapse/web` green incl. the new store + scoping
tests. With `DATABASE_URL` set to a Neon instance, a manual create→list
round-trips and the row has **no** token column (`\d connections` shows no
token/secret field).

**STOP** if any schema or payload includes a token/secret column, or if a
per-request `pg.Pool` is introduced.

## Phase 4 — `/get-started` onboarding (login-gated)

**In scope**: `apps/web/app/get-started/page.tsx` (+ section components).

1. Content from the README quick-start: install
   (`npm install -g @kumario/synapse`), prerequisites (Node 20.19+, optional
   Python/Go), `synapse up` / `synapse up --serve --tunnel`, and a command
   cheat-sheet (`join`, `connect`, `whatsup`, `why`, `onboard`, `doctor`,
   `demo`). Keep this a server component (static content) behind the Phase 2 guard.
2. End with a "Connect your server" handoff linking to `/dashboard`.

**Verify**: signed in, `/get-started` returns 200 with the install + usage
content in the HTML; signed out it 307-redirects to `/login`.

## Phase 5 — Account-bound live dashboard (login-gated)

**In scope**: `apps/web/app/dashboard/page.tsx` + client components, a new
exported helper in `feed.ts`, tests.

1. `/dashboard` lists the account's saved **Connections** (GET `/api/connections`).
2. "Add connection" form captures `label`, `wss://` server URL, `repoId` →
   persisted via the API (metadata only).
3. **Token handling**: selecting a Connection reads its **Token** from
   `localStorage` keyed by connection id; if absent, prompt for it and store it
   there (never sent to our API).
4. **Open the live feed using the real `feed.ts` API.** `createLiveFeed` takes
   `{ server, repoId, token }` — *not* a `Connection`. Do two small, explicit
   things in `feed.ts`:
   - **Export** the existing `buildSocketUrl` (currently private).
   - Add a pure `resolveLiveFeedConfig({ connection, token })` that returns
     `{ server: connection.serverUrl, repoId: connection.repoId, token }` when a
     token is present, or a `{ needsToken: true }` sentinel when it is null.
   The dashboard passes the resolved config to `createLiveFeed`.
5. Reuse `Dashboard`, `FlowGraph`, `panels`, and the reconnect/backoff logic in
   `createLiveFeed` unchanged.

**Testing**: unit-test `resolveLiveFeedConfig` (the new pure seam) the way
`derive.test.ts` is written: a Connection + token composes the correct
`{ server, repoId, token }`; a Connection + null token yields the `needsToken`
sentinel, **not** a live config. Also test `buildSocketUrl` now that it is
exported (URL + repoId + optional token compose correctly). No real WebSocket in
tests.

**Verify**: signed in, with a saved Connection and a Token entered, the
dashboard opens a live WS to that Server and renders real `state.snapshot` frames
(validate against a local `synapse up --serve` or the `synapse demo` server).
Reload on the same device: the Connection persists (DB) and the Token persists
(localStorage). In a fresh browser profile: the Connection appears but prompts
for the Token.

## Done criteria (all must hold at plan completion)

- [ ] `npm run typecheck -w @synapse/web` exits 0.
- [ ] `npm run build -w @synapse/web` exits 0 (`next build`) and emits `.next/`.
- [ ] `npm run test -w @synapse/web` exits 0, including: the preserved
      `derive.test.ts`, the `requireUser` guard test, the `ConnectionStore` CRUD
      + cross-account scoping tests, and the `resolveLiveFeedConfig`/`buildSocketUrl`
      tests.
- [ ] `npm test` (repo-wide turbo) exits 0.
- [ ] `git grep -n "vite" apps/web` returns nothing meaningful (Vite fully removed).
- [ ] `git grep -nE "token" apps/web/lib apps/web/app/api` shows no token/secret
      persisted server-side (Token only ever read/written to `localStorage` in
      client code).
- [ ] `.next/` is gitignored and not committed (`git status` clean of build output).
- [ ] `plans/README.md` status row for 049 updated.

## Out of scope (do not build here)

- Hosted/managed Synapse, server provisioning, billing, or tenancy.
- Server-side Token storage, encrypted or otherwise.
- Proxying or relaying coordination traffic through the website.
- Dashboard sharing by link, teams/orgs, roles, or invitations.
- Email/password auth, password reset, or any non-GitHub provider.
- Changes to `apps/server`, the CLI, analyzers, or the coordination protocol.

## STOP conditions (global)

- Any phase requires storing a Token/secret server-side → STOP.
- Any phase routes live coordination traffic through the website → STOP.
- The `derive.test.ts` seam cannot be preserved without rewriting derivation
  logic → STOP.
- A GitHub OAuth app or `DATABASE_URL` is needed to make **unit tests** pass
  (they must pass on the in-memory backend with no live creds) → STOP.
- A step's verification fails twice after a reasonable fix attempt → STOP.

## Maintenance notes

- **Deployment is an owner action**: the Vercel project for `apps/web` must be
  switched from the Vite preset to the Next.js preset (framework, build command,
  output). The executor cannot do this; it only makes the code build as a Next
  app. Coordinate the cutover so the deployed site isn't broken between merge and
  settings change.
- **Reviewer focus**: (1) no token/secret ever reaches the DB or `/api`; (2)
  every `/api/connections` query is `userId`-scoped (the cross-account test is
  the guard); (3) no per-request `pg.Pool` (serverless connection exhaustion);
  (4) `.next/` not committed and Turbo caches it correctly.
- **Consider splitting** this XL plan into per-phase plans (049 migration as its
  own plan, then landing/auth/persistence/onboarding/dashboard) if it will be run
  by separate executors — Phase 0 is the hard prerequisite and the riskiest, and
  is independently shippable. Kept as one phased plan here to match the repo's
  house style; each phase is already a separate PR.
- **Next/Auth.js upgrades**: this pins Next 15 + Auth.js v5. A future major bump
  will most affect `auth.ts` (session/jwt callbacks) and the route handler shape.
