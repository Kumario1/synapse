# Plan 054: Dashboard — list claimed Projects and render the selected one's live Room

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report — do
> not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 26d2873..HEAD -- apps/server/src/index.ts apps/server/src/auth/routes.ts apps/server/src/auth/project-store.ts apps/web/src/Dashboard.tsx apps/web/src/feed.ts apps/web/src/auth.ts apps/web/src/App.tsx`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (adds a cookie-authed, ownership-scoped read path — must reject unowned reads)
- **Depends on**: plans/052-claim-repo-via-app-install.md (DONE — ownership store + `GET /auth/projects`) and plans/053 (DONE — `apps/web` onboarding patterns). 
- **Category**: direction (feature) / security
- **Planned at**: commit `26d2873`, 2026-06-17
- **Issue**: https://github.com/Kumario1/synapse/issues/106

## Why this matters

An Owner can claim Projects (#104) and onboard a daemon (#105), but has no dashboard
over their Projects. This adds it: list all Projects the logged-in Owner has
claimed, select one, and render that Project's live Room (agent Sessions, edit
locks, contested symbols, ship trail) reusing the existing `apps/web/src/Dashboard.tsx`
panels. The critical new piece is the **read path's authorization**: unlike the
onboarding connected-indicator (#105, which used the daemon `project-key` via
`/state?token=`), this dashboard read is **authenticated by the Owner cookie
session and authorized by ownership** — an Owner can only read Rooms for repos
they own; unauthorized (no session) and unowned reads are rejected. This is the
authz spine for the owner-facing product.

## Current state

- `apps/server/src/auth/routes.ts` — the auth router (extended in #104). Current shape:
  ```ts
  export interface AuthContext {
    creds; sessionKey: Buffer; userStore; redirectUri;
    exchangeCodeForToken; fetchGitHubUser; isSecure;
    appSlug: string | null; masterSecret: string; projectStore: ProjectStore;
    listInstallationReposForUser: (installationId, userToken) => Promise<ClaimedRepo[]>;
  }
  export async function resolveAuthRoute(method, pathname, query: URLSearchParams, cookies, ctx): Promise<RouteResult | null>;
  ```
  It has a `requireOwner(cookies, ctx)` helper (`verifySession(cookies[SESSION_COOKIE], ctx.sessionKey)` → `{ userId } | null`) and these routes: `/auth/github`, `/auth/github/callback`, `/auth/me`, `/auth/logout`, `/auth/projects/add`, `/auth/github/setup`, `/auth/projects`, then `404`. **You extend this with one new route + one new injected `AuthContext` field.**
- `apps/server/src/auth/project-store.ts` — `ProjectStore` has
  `getProject(ownerId, repoId): Promise<Project | null>` and
  `listProjectsForOwner(ownerId): Promise<Project[]>`. Use `getProject` for the
  ownership check.
- `apps/server/src/index.ts`:
  - The `authContext` object is built in the `githubApp.status === "configured"`
    branch (it already passes `projectStore`, `masterSecret`, etc.). **Add one
    field** `readRoomState`.
  - The room state is read via `await withRepo(repoId, () => getState(repoId))`
    — `withRepo` (the per-repo async mutex) and `getState` are module-scope
    functions in `index.ts`. `getState(repoId): Promise<TeamState>` returns the
    in-memory/loaded `TeamState` for a repo. Use exactly this to implement
    `readRoomState`.
  - The auth hook `if (authContext && url.pathname.startsWith("/auth/")) { ... }`
    is already before the `404`. The new route is served through the same
    `resolveAuthRoute` — no change to the hook.
  - Do NOT touch `authorized()`, the WS handshake, `handleGitHubWebhook`, or the
    machine `/state` route.
- `apps/web/src/Dashboard.tsx` — renders a single Room from a `FeedSnapshot`:
  `export default function Dashboard({ snapshot }: { snapshot: FeedSnapshot })`.
  It reads `snapshot.state` (a `TeamState`), `snapshot.status`, `snapshot.mode`,
  `snapshot.seq`, `snapshot.message`. **Reuse this component unchanged** — feed it
  a `FeedSnapshot` built from the owner-scoped polled state.
- `apps/web/src/feed.ts` — defines the shapes you construct:
  ```ts
  export type FeedMode = "demo" | "live";
  export type FeedStatus = "connecting" | "open" | "reconnecting" | "closed" | "error";
  export interface FeedSnapshot { mode: FeedMode; status: FeedStatus; state: TeamState; seq: number; message: string; }
  ```
  `TeamState` is `import type { TeamState } from "@synapse/protocol"`. The protocol
  package also exports the value `createEmptyTeamState(repoId)` (used in the
  server) — import it in the web for the pre-first-poll placeholder state.
- `apps/web/src/auth.ts` — `fetchProjects(): Promise<Project[]>` and
  `Project { repoId; projectKey }` (from #104). Reuse `fetchProjects` for the list.
- `apps/web/src/App.tsx` — renders `<Landing/>`, the demo/Dashboard, `<Onboarding/>`,
  `<footer/>`. You will add `<ProjectsDashboard/>` (self-fetches; renders null when
  the Owner has no projects, so the public landing is unchanged).

### Conventions to match

- Server tests: `node:test` + `node:assert/strict`, `apps/server/src/auth/*.test.ts`,
  run by `npm test --workspace @synapse/server` (`tsc -b` then `node --test dist`).
  Model the new route test on the existing cases in `apps/server/src/auth/routes.test.ts`.
- Web tests: `node:test`, `apps/web/src/*.test.ts`, `npm test --workspace @synapse/web`.
  Model on `apps/web/src/auth.test.ts` / `apps/web/src/onboarding.test.ts`.
- TS strict, ESM. Server local imports use `.js` specifiers; web imports do NOT.
- React 18, Vite, shadcn. Reuse `Button`, `Card*`, `Badge` already used in
  `Onboarding.tsx`/`Dashboard.tsx`. No new dependency.

## Commands you will need (run from repo root /private/tmp/synapse-issue-106)

| Purpose | Command | Expected |
|---|---|---|
| Install (FIRST, fresh worktree) | `npm install` | exit 0 |
| Build server | `npm run build --workspace @synapse/server` | exit 0 |
| Test server | `npm test --workspace @synapse/server` | all pass |
| Typecheck web | `npm run typecheck --workspace @synapse/web` | exit 0 |
| Test web | `npm test --workspace @synapse/web` | all pass |
| Build web | `npm run build --workspace @synapse/web` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Format check | `npm run format:check` | exit 0 |

## Scope

**In scope** (create unless noted):
- `apps/server/src/auth/routes.ts` (modify — add `GET /auth/projects/state` route + `readRoomState` field on `AuthContext`)
- `apps/server/src/auth/routes.test.ts` (modify — add owner-allowed / non-owner-denied / 401 / 400 cases)
- `apps/server/src/index.ts` (modify — pass `readRoomState: (repoId) => withRepo(repoId, () => getState(repoId))` into `authContext`)
- `apps/web/src/projects.ts` (create — `fetchOwnedRoomState(repoId)` + a pure `ownedRoomStateUrl(repoId)` + `toSnapshot(state, seq, status)` helper)
- `apps/web/src/projects.test.ts` (create — pure helper assertions)
- `apps/web/src/components/ProjectsDashboard.tsx` (create — project list + selected Room via `<Dashboard/>`)
- `apps/web/src/App.tsx` (modify — render `<ProjectsDashboard/>`)
- `README.md` (modify — document the owner dashboard + the cookie-authed ownership-scoped read route)

**Out of scope** (do NOT touch):
- `apps/server/src/index.ts` `authorized()`, the WS handshake/`verifyClient`, `handleGitHubWebhook`, and the machine `GET /state` route — the owner read path is a NEW route, not a change to these.
- `apps/server/src/auth/project-store.ts` (consume `getProject`; don't change it).
- `apps/web/src/Dashboard.tsx` and the panels — reuse unchanged.
- WebSocket cookie auth — do NOT make the WS handshake accept the cookie session.
  Live updates here are delivered by polling the cookie-authed snapshot route
  (see Step 4); the existing project-key WS path is untouched.
- The onboarding panel (#105) — leave `Onboarding.tsx` as-is.

## Git workflow

- Already on branch `feat/dashboard-projects` in this worktree. Do NOT create a new branch.
- Conventional commits (e.g. `feat(web): owner dashboard over claimed projects (#106)`).
- Do NOT push or open a PR — the reviewer/operator handles that.

## Steps

### Step 1: Server — ownership-scoped read route in `apps/server/src/auth/routes.ts`

Add to `AuthContext` (keep all existing fields):
```ts
// Reads the live Room TeamState for a repo (injected from index.ts, closes over
// the per-repo mutex + getState). Returns the protocol TeamState.
readRoomState: (repoId: string) => Promise<unknown>;
```
(Type the return as `unknown` to avoid importing the heavy `TeamState` type into
routes.ts if it causes a cycle; the route passes it straight through to the JSON
body. If `import type { TeamState } from "@synapse/protocol"` is clean, prefer
that type instead of `unknown`.)

Add this route inside `resolveAuthRoute`, BEFORE the final `404`:
```ts
// Owner dashboard read: cookie-authed, authorized by ownership. An Owner may read
// the live Room only for a repo they have claimed. This is distinct from the
// machine GET /state (project-key) path — the boundary stays separate.
if (method === "GET" && pathname === "/auth/projects/state") {
  const owner = requireOwner(cookies, ctx);
  if (!owner) {
    return { status: 401, body: { error: "unauthenticated" } };
  }
  const repoId = query.get("repoId");
  if (!repoId) {
    return { status: 400, body: { error: "missing_repo" } };
  }
  const project = await ctx.projectStore.getProject(owner.userId, repoId);
  if (!project) {
    return { status: 403, body: { error: "not_owner" } };
  }
  const state = await ctx.readRoomState(repoId);
  return { status: 200, body: state };
}
```

**Verify**: `npm run build --workspace @synapse/server` → exit 0 (after Step 2 wiring too).

### Step 2: Server — wire `readRoomState` in `apps/server/src/index.ts`

In the `authContext` object (the `configured` branch), add the field:
```ts
readRoomState: (repoId: string) => withRepo(repoId, () => getState(repoId)),
```
`withRepo` and `getState` are already in module scope in `index.ts`. No other
change. Do NOT touch `authorized()`, WS, `handleGitHubWebhook`, or `/state`.

**Verify**: `npm run build --workspace @synapse/server` → exit 0.

### Step 3: Server tests — `apps/server/src/auth/routes.test.ts`

Extend the existing project-claim test setup (it already builds an `AuthContext`
with a `:memory:` projectStore and a seeded owner session). Add a
`readRoomState` to the test context, e.g. `readRoomState: async (repoId) => ({ repoId, sessions: [{ id: "s1" }], editLocks: [], unpushedDeltas: [], recentPushes: [], recentRepoEvents: [] })`.
Cases:
- **owner allowed**: claim `o/r1` for owner `"42"`, then `GET /auth/projects/state?repoId=o/r1`
  with owner `"42"`'s session cookie → `status === 200`, and `body.repoId === "o/r1"`
  (the injected state is returned).
- **non-owner denied**: a valid session for an owner who has NOT claimed `o/r1`
  (or a different repoId) → `status === 403`, `body.error === "not_owner"`.
- **unauthenticated**: no session cookie → `status === 401`.
- **missing repoId**: owner session, no `repoId` query → `status === 400`,
  `body.error === "missing_repo"`.

**Verify**: `npm test --workspace @synapse/server` → all pass including the new cases.

### Step 4: Web — `apps/web/src/projects.ts`

```ts
import type { TeamState } from "@synapse/protocol";
import type { FeedSnapshot, FeedStatus } from "./feed";

export function ownedRoomStateUrl(repoId: string): string {
  return `/auth/projects/state?repoId=${encodeURIComponent(repoId)}`;
}

/** Cookie-authed, ownership-scoped Room read (returns null on any non-2xx). */
export async function fetchOwnedRoomState(repoId: string): Promise<TeamState | null> {
  try {
    const response = await fetch(ownedRoomStateUrl(repoId), { credentials: "include" });
    if (!response.ok) return null;
    return (await response.json()) as TeamState;
  } catch {
    return null;
  }
}

/** Wrap a polled TeamState as a FeedSnapshot for the existing Dashboard. */
export function toSnapshot(state: TeamState, seq: number, status: FeedStatus = "open"): FeedSnapshot {
  return { mode: "live", status, state, seq, message: "Owner dashboard" };
}
```

### Step 5: Web — `apps/web/src/projects.test.ts`

Model on `apps/web/src/onboarding.test.ts`. Assert (pure helpers only):
- `ownedRoomStateUrl("o/r")` === `"/auth/projects/state?repoId=o%2Fr"`.
- `toSnapshot(someState, 3)` returns `{ mode: "live", status: "open", state: someState, seq: 3, message: "Owner dashboard" }`
  (build `someState` as a minimal object cast to the type, or import
  `createEmptyTeamState("o/r")` from `@synapse/protocol`).

**Verify**: `npm test --workspace @synapse/web` → all pass.

### Step 6: Web — `apps/web/src/components/ProjectsDashboard.tsx`

A client component:
- `fetchProjects()` on mount → `projects`. If empty → `return null;`.
- `const [selected, setSelected] = useState<string | null>(null);` default to the
  first project's `repoId` once projects load.
- Poll `fetchOwnedRoomState(selected)` every ~2s while `selected` is set; keep a
  `seq` counter incrementing per successful poll; on `null` result set status
  `"reconnecting"`. Use `createEmptyTeamState(selected)` from `@synapse/protocol`
  as the placeholder state before the first successful poll.
- Render: a heading ("Your Projects"), a row of project selector buttons (one per
  `repoId`, the selected one highlighted — use `Button` `variant` to indicate
  selection), and below it `<Dashboard snapshot={toSnapshot(state, seq, status)} />`
  for the selected project. Reuse `Dashboard` unchanged.
- Clean up the interval on unmount and when `selected` changes (return a cleanup
  from the `useEffect`, guarded by an `active` flag like
  `Onboarding.tsx`'s `ConnectionStatus`).

Keep it presentational; the testable logic lives in `projects.ts`.

**Verify**: `npm run typecheck --workspace @synapse/web` → 0; `npm run build --workspace @synapse/web` → 0.

### Step 7: Web — wire into `apps/web/src/App.tsx`

Add `import ProjectsDashboard from "./components/ProjectsDashboard";` and render
`<ProjectsDashboard />` inside the root `<div>` (e.g. directly after `<Onboarding />`).
It renders `null` for signed-out / no-project visitors, so the public landing is
unchanged. That is the only App.tsx change.

**Verify**: `npm run build --workspace @synapse/web` → exit 0.

### Step 8: Documentation — `README.md`

Under the owner/auth section, add an "Owner dashboard" note: a signed-in Owner
sees their claimed Projects, selects one, and watches its live Room (sessions,
locks, contested symbols, ship trail). Document the new route
`GET /auth/projects/state?repoId=<id>` — **cookie-authed and authorized by
ownership** (401 without a session, 403 for a repo the Owner has not claimed),
distinct from the machine `GET /state` (project-key) path. Note that live updates
are delivered by polling this route (the WS project-key path is unchanged). No new
ADR, no manual CHANGELOG.

**Verify**: `npm run format:check` and `npm run lint` → exit 0.

## Done criteria (ALL must hold)

- [ ] `npm run build --workspace @synapse/server` exits 0
- [ ] `npm test --workspace @synapse/server` exits 0, including the new route
      tests: owner allowed (200), non-owner denied (403), unauthenticated (401),
      missing repoId (400)
- [ ] `npm run typecheck --workspace @synapse/web` exits 0
- [ ] `npm test --workspace @synapse/web` exits 0 (new `projects.test.ts` passes)
- [ ] `npm run build --workspace @synapse/web` exits 0
- [ ] `npm run lint` exits 0 and `npm run format:check` exits 0
- [ ] `git grep -n "verifyClient\|/auth/projects/state" apps/server/src/index.ts` shows
      `verifyClient` unchanged and NO `/auth/projects/state` handling added in index.ts
      (the route lives in routes.ts; index.ts only adds the `readRoomState` field)
- [ ] `apps/server/src/index.ts` `authorized()`/WS/`handleGitHubWebhook`/machine-`/state` unchanged
      (diff shows only the one `readRoomState` line added to `authContext`)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 054 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows the listed files changed since `26d2873` and the excerpts
  no longer match (especially the `AuthContext` shape, `requireOwner`,
  `getProject`, or the `FeedSnapshot` shape).
- You conclude live streaming requires WebSocket cookie auth — it does NOT for
  this plan; poll the cookie-authed route. If you believe WS cookie auth is
  required, STOP and report rather than modifying `verifyClient`.
- `getState`/`withRepo` are not module-scope in `index.ts` as described, or
  `getState` does not return a `TeamState`.
- A step's verification fails twice after a reasonable fix attempt.
- You find you must modify `authorized()`, the WS handshake, `handleGitHubWebhook`,
  the machine `/state` route, or `Dashboard.tsx`.

## Maintenance notes

- **Two read boundaries now exist for Room state**: the machine `GET /state`
  (project-key, used by the daemon and the #105 onboarding indicator) and the new
  `GET /auth/projects/state` (Owner cookie + ownership, used by this dashboard).
  They must stay distinct — the cookie route authorizes by `projectStore.getProject`,
  never by a token; the machine route authorizes by `deriveProjectKey`. A reviewer
  should confirm the cookie route can ONLY return repos the session owner claimed.
- **Polling vs WS**: this dashboard polls every ~2s for simplicity and to avoid
  cookie-authing the WS handshake. If real-time latency becomes a requirement, a
  follow-up can add a cookie-authed WS subscription — out of scope here, and a
  bigger security surface (note it, don't build it).
- **#107** (kick an agent session) builds on this ownership-authorized owner
  surface — it will add a cookie-authed, ownership-checked mutation route.
- Dev parity: same-origin only (no vite proxy), like the rest of the auth surface.
