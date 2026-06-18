# Plan 055: Kick an agent Session from a Project's Room (Owner-authorized, HTTP)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md` — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7e528e0..HEAD -- apps/server/src/index.ts apps/server/src/auth/routes.ts apps/server/src/state.ts apps/web/src/Dashboard.tsx apps/web/src/panels.tsx apps/web/src/projects.ts apps/web/src/components/ProjectsDashboard.tsx`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (authorized state mutation + live socket teardown)
- **Depends on**: plans/054-dashboard-list-projects-render-room.md (DONE — the cookie-authed, ownership-scoped owner surface: `requireOwner`, `projectStore.getProject`, the `ProjectsDashboard`, `apps/web/src/projects.ts`).
- **Category**: direction (feature) / security
- **Planned at**: commit `7e528e0`, 2026-06-17
- **Issue**: https://github.com/Kumario1/synapse/issues/107

## Why this matters

An Owner needs to force-end a runaway or stale agent Session in one of their
Projects. A **Kick** control in the dashboard calls a new authenticated HTTP route
that ends the Session, closes its socket, releases its edit locks, and broadcasts
the updated Room state. A reconnecting daemon returns as a *fresh* Session — kick
is an interrupt, not a ban (banning is deferred). **Authorization is the Owner
cookie session + ownership (GitHub push-access proven at claim time)**, and the
kick travels over a new authenticated **HTTP** route — NOT a new browser→server
WebSocket message — keeping the browser off the machine protocol entirely.

## Current state

- `apps/server/src/state.ts` — the state machine already has the exact teardown
  this needs. `applyMessage` handles a `"session.end"` client message
  (`state.ts:69` → `endSession(...)`). `endSession(state, repoId, store, sessionId, now)`
  (`state.ts:307-324`) sets `session.status = "ended"`, clears `filesEditing`,
  removes the session's edit locks from state, and emits `deleteEditLocksForSession`.
  **The kick reuses this — do NOT write a new teardown.** `session.end`'s wire
  payload is `{ repoId, sessionId }` (`packages/protocol/src/wire-schema.ts:231-232`).
- `apps/server/src/index.ts`:
  - `roomClients: Map<string, Set<WebSocket>>` (line ~109) — sockets per repo room.
  - Per-socket WeakMaps already exist: `socketAlive`, `socketProtocol`,
    `socketRates` (lines ~325-345). There is currently **no** socket→sessionId
    map — you add one.
  - `handleMessage(socket, fallbackRepoId, raw)` (line ~451) parses the client
    message into `message`; many payloads carry `message.payload.sessionId`. You
    record the socket↔session association here.
  - The apply+broadcast pattern to copy (from `handleMessage` / the webhook path):
    ```ts
    const ops: StateOp[] = [];
    const state = await withRepo(repoId, async () => {
      const current = await getState(repoId);
      applyMessage(current, repoId, clientEnvelope("session.end", { repoId, sessionId }), teeStateStoreOps(ops));
      return current;
    });
    if (ops.length > 0) { broadcastStateChange(repoId, state, ops); fanout?.publish(repoId); }
    ```
    `withRepo`, `getState`, `applyMessage`, `clientEnvelope`, `teeStateStoreOps`,
    `broadcastStateChange`, `fanout` are all module-scope in `index.ts`.
    `clientEnvelope("session.end", { repoId, sessionId })` builds a valid
    `ClientMessage` (it's used the same way for `push.notify`/`repo.event` in the
    webhook handler).
  - `authContext` is built in the `githubApp.status === "configured"` branch and
    already injects `readRoomState` (#106). You add a `kickSession` field next to it.
  - The auth hook `if (authContext && url.pathname.startsWith("/auth/")) {...}` is
    already before the `404`; the new route goes through `resolveAuthRoute`.
  - Do NOT touch `authorized()`, the WS `verifyClient` handshake, `handleGitHubWebhook`,
    or the machine `/state` route.
- `apps/server/src/auth/routes.ts` — `AuthContext` (extended in #104/#106) has
  `requireOwner(cookies, ctx)` → `{ userId } | null`, `projectStore.getProject(ownerId, repoId)`,
  and the existing routes incl. `GET /auth/projects/state` (#106). `resolveAuthRoute`'s
  signature is `(method, pathname, query: URLSearchParams, cookies, ctx)` — **it
  has no request body**, so the kick route reads `repoId`/`sessionId` from the
  query string (a POST with query params; the existing `/auth/logout` POST shows
  POST routes here). You add an injected `kickSession` field and one route.
- `apps/web/src/panels.tsx` — `export function OnlinePanel({ sessions }: { sessions: Session[] })`
  (line ~23) renders each session (`session.id`, `session.memberLogin ?? session.memberId`).
  Add an optional `onKick` so a Kick button renders only in the owner context.
- `apps/web/src/Dashboard.tsx` — `Dashboard({ snapshot })` renders
  `<OnlinePanel sessions={sessions} />` (line ~52). Add an optional `onKick` prop
  threaded to `OnlinePanel`. Public/demo usages pass nothing (no button).
- `apps/web/src/components/ProjectsDashboard.tsx` (#106) — the owner dashboard;
  it renders `<Dashboard snapshot={...} />` for the selected owned repo. It passes
  the real `onKick`.
- `apps/web/src/projects.ts` (#106) — `ownedRoomStateUrl`, `fetchOwnedRoomState`,
  `toSnapshot`. Add the `kickSession` client call here.
- `apps/web/src/derive.ts` — `activeSessions(state)` = sessions with
  `status !== "ended"`. Kick targets active sessions.

### Conventions to match

- Server tests: `node:test` + `node:assert/strict`, `apps/server/src/**/*.test.ts`,
  `npm test --workspace @synapse/server` (`tsc -b` then `node --test dist`). Model
  the route authz test on `apps/server/src/auth/routes.test.ts`; model the state
  mechanics test on `apps/server/src/state.test.ts` (it already tests `session.end`).
- Web tests: `node:test`, `apps/web/src/*.test.ts`. Model on `projects.test.ts`.
- TS strict, ESM; server local imports use `.js`, web does not. React 18, shadcn
  (`Button`), no new dependency.

## Commands you will need (run from repo root /private/tmp/synapse-issue-107)

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
- `apps/server/src/auth/routes.ts` (modify — add `POST /auth/projects/kick` route + `kickSession` field on `AuthContext`)
- `apps/server/src/auth/routes.test.ts` (modify — add kick authz cases)
- `apps/server/src/index.ts` (modify — add a `socketSession` WeakMap + record it in `handleMessage`; implement `kickSession`; inject it into `authContext`)
- `apps/server/src/state.test.ts` (modify — add a focused kick-mechanics test: `session.end` ends the session + releases its locks; a fresh join with a new id is active)
- `apps/web/src/projects.ts` (modify — add `kickSession(repoId, sessionId)` + a pure `kickUrl(repoId, sessionId)`)
- `apps/web/src/projects.test.ts` (modify — assert `kickUrl`)
- `apps/web/src/panels.tsx` (modify — optional `onKick` on `OnlinePanel`)
- `apps/web/src/Dashboard.tsx` (modify — optional `onKick` prop threaded to `OnlinePanel`)
- `apps/web/src/components/ProjectsDashboard.tsx` (modify — pass a real `onKick`)
- `README.md` (modify — document the kick route + authorization)

**Out of scope** (do NOT touch):
- `apps/server/src/index.ts` `authorized()`, the WS `verifyClient` handshake,
  `handleGitHubWebhook`, the machine `/state` route.
- `apps/server/src/state.ts` `endSession` / the state machine — REUSE `session.end`,
  do not modify the teardown.
- A ban/blocklist of any kind — kick is an interrupt; a reconnect is a fresh session.
- A browser→server **WebSocket** kick message — the kick is HTTP only. Do NOT add a
  client WS message type to the protocol.
- The onboarding panel and the public demo/live Dashboard behavior (no Kick button
  unless `onKick` is passed).

## Git workflow

- Already on branch `feat/kick-session` in this worktree. Do NOT create a new branch.
- Conventional commits (e.g. `feat(server): owner-authorized session kick (#107)`).
- Do NOT push or open a PR — the reviewer/operator handles that.

## Steps

### Step 1: Server — track socket↔session in `apps/server/src/index.ts`

Add a module-scope WeakMap near the other per-socket maps:
```ts
// The sessionId a socket last acted as — used to close the right daemon's socket
// on an owner kick. Populated as soon as the socket sends any session-bearing
// message. ponytail: last-writer-wins; a daemon is one session per socket.
const socketSession = new WeakMap<WebSocket, string>();
```
In `handleMessage`, after the message is validated into `message`, record it:
```ts
const actingSessionId = (message.payload as { sessionId?: unknown }).sessionId;
if (typeof actingSessionId === "string") {
  socketSession.set(socket, actingSessionId);
}
```
(Place this after `const message: ClientMessage = validated.message;` and before
the apply block. It must not change any existing behavior.)

**Verify**: `npm run build --workspace @synapse/server` → exit 0.

### Step 2: Server — implement `kickSession` in `apps/server/src/index.ts`

Add a module-scope async function:
```ts
async function kickSession(repoId: string, sessionId: string): Promise<void> {
  const ops: StateOp[] = [];
  const state = await withRepo(repoId, async () => {
    const current = await getState(repoId);
    applyMessage(
      current,
      repoId,
      clientEnvelope("session.end", { repoId, sessionId }),
      teeStateStoreOps(ops)
    );
    return current;
  });
  if (ops.length > 0) {
    broadcastStateChange(repoId, state, ops);
    fanout?.publish(repoId);
  }
  // Close the kicked daemon's socket(s). A clean close lets the daemon's backoff
  // reconnect as a fresh session (kick is an interrupt, not a ban).
  for (const socket of roomClients.get(repoId) ?? []) {
    if (socketSession.get(socket) === sessionId) {
      socket.close(4001, "kicked");
    }
  }
}
```
Then inject it into the `authContext` object (next to `readRoomState`):
```ts
kickSession: (repoId: string, sessionId: string) => kickSession(repoId, sessionId),
```
Do NOT touch `authorized()`, WS handshake, `handleGitHubWebhook`, or `/state`.

**Verify**: `npm run build --workspace @synapse/server` → exit 0 (after Step 3 adds the field type).

### Step 3: Server — route + AuthContext field in `apps/server/src/auth/routes.ts`

Add to `AuthContext` (keep all existing fields):
```ts
kickSession: (repoId: string, sessionId: string) => Promise<void>;
```
Add this route inside `resolveAuthRoute`, BEFORE the final `404` (and after the
`/auth/projects/state` route):
```ts
// Owner kick: force-end an agent Session in a Project the Owner owns. HTTP only,
// cookie-authed, authorized by ownership — never a browser WS message. repoId and
// sessionId ride the query string (resolveAuthRoute has no request body).
if (method === "POST" && pathname === "/auth/projects/kick") {
  const owner = requireOwner(cookies, ctx);
  if (!owner) {
    return { status: 401, body: { error: "unauthenticated" } };
  }
  const repoId = query.get("repoId");
  const sessionId = query.get("sessionId");
  if (!repoId || !sessionId) {
    return { status: 400, body: { error: "missing_params" } };
  }
  const project = await ctx.projectStore.getProject(owner.userId, repoId);
  if (!project) {
    return { status: 403, body: { error: "not_owner" } };
  }
  await ctx.kickSession(repoId, sessionId);
  return { status: 200, body: { ok: true } };
}
```

**Verify**: `npm run build --workspace @synapse/server` → exit 0.

### Step 4: Server tests

`apps/server/src/auth/routes.test.ts` — extend the existing context with a fake
`kickSession` that records calls, e.g.
`const kicked: Array<[string, string]> = []; kickSession: async (r, s) => { kicked.push([r, s]); }`.
Cases:
- **owner kick allowed**: claim `o/r1` for owner `"42"`, then
  `POST /auth/projects/kick?repoId=o/r1&sessionId=sess-1` with owner `"42"`'s
  session cookie → `status === 200`, `body.ok === true`, and `kicked` contains
  `["o/r1", "sess-1"]`.
- **non-owner denied**: a valid session for an owner who has NOT claimed `o/r1`
  → `status === 403`, `body.error === "not_owner"`, and `kicked` is **empty**
  (the kick was NOT invoked — assert this).
- **unauthenticated**: no session cookie → `status === 401`, `kicked` empty.
- **missing params**: owner session, no `sessionId` → `status === 400`,
  `body.error === "missing_params"`.

`apps/server/src/state.test.ts` — add a kick-mechanics test (model on the existing
`session.end` test around line 459):
- Build a state with an active session that holds an edit lock. Apply
  `session.end` for it. Assert: `session.status === "ended"`, `filesEditing` empty,
  and `state.editLocks` no longer contains any lock for that session (locks released).
- Then apply a `session.join` (or `session.start` — match the helper the file
  already uses, e.g. `sessionStartMessage`) with a **new** sessionId and assert a
  new session with `status === "active"` exists (reconnect = fresh session, no ban).

**Verify**: `npm test --workspace @synapse/server` → all pass including the new tests.

### Step 5: Web — kick client in `apps/web/src/projects.ts`

```ts
export function kickUrl(repoId: string, sessionId: string): string {
  return `/auth/projects/kick?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(sessionId)}`;
}

/** Owner-authorized kick (cookie session). Resolves true on a 2xx. */
export async function kickSession(repoId: string, sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(kickUrl(repoId, sessionId), {
      method: "POST",
      credentials: "include"
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

`apps/web/src/projects.test.ts` — assert
`kickUrl("o/r", "s 1") === "/auth/projects/kick?repoId=o%2Fr&sessionId=s%201"`.

### Step 6: Web — Kick control in `apps/web/src/panels.tsx` + `Dashboard.tsx` + `ProjectsDashboard.tsx`

- `panels.tsx` `OnlinePanel`: change the signature to
  `OnlinePanel({ sessions, onKick }: { sessions: Session[]; onKick?: (session: Session) => void })`.
  For each rendered session, when `onKick` is provided AND `session.status !== "ended"`,
  render a small `Button` (`size="sm" variant="outline"`) labelled "Kick" with
  `onClick={() => onKick(session)}`. When `onKick` is undefined, render exactly as
  today (no button) — so the public/demo Dashboard is unchanged.
- `Dashboard.tsx`: add an optional prop
  `Dashboard({ snapshot, onKick }: { snapshot: FeedSnapshot; onKick?: (session: Session) => void })`
  and pass it through: `<OnlinePanel sessions={sessions} onKick={onKick} />`. Import
  the `Session` type from `@synapse/protocol` (type-only) if not already. No other
  change; existing `<Dashboard snapshot={...} />` callers keep working (prop optional).
- `ProjectsDashboard.tsx`: pass a real handler to the selected project's Dashboard:
  ```tsx
  <Dashboard
    snapshot={toSnapshot(state, seq, status)}
    onKick={(session) => {
      void kickSession(selected, session.id).then(() => { /* trigger an immediate re-poll */ });
    }}
  />
  ```
  Import `kickSession` from `../projects`. Triggering an immediate re-poll is nice
  but optional — the 2s poll will reflect the kick regardless; keep it simple.

**Verify**: `npm run typecheck --workspace @synapse/web` → 0; `npm test --workspace @synapse/web` → pass; `npm run build --workspace @synapse/web` → 0.

### Step 7: Documentation — `README.md`

Under the owner dashboard section, add a "Kick a Session" note: an Owner can
force-end an agent Session in a Project they own via
`POST /auth/projects/kick?repoId=<id>&sessionId=<id>` — **cookie-authed and
authorized by ownership** (401 without a session, 403 for an unowned repo). The
kick ends the Session (`status: ended`), releases its edit locks, closes its
socket, and broadcasts the new Room state; a reconnecting daemon returns as a
fresh Session (interrupt, not ban). Emphasize it is HTTP only — never a browser
WebSocket message on the machine protocol. No new ADR, no manual CHANGELOG.

**Verify**: `npm run format:check` and `npm run lint` → exit 0.

## Done criteria (ALL must hold)

- [ ] `npm run build --workspace @synapse/server` exits 0
- [ ] `npm test --workspace @synapse/server` exits 0, including: kick authz
      (owner 200 / non-owner 403 with kick NOT invoked / 401 / 400) and the
      state mechanics test (session.end ends + releases locks; fresh join is active)
- [ ] `npm run typecheck --workspace @synapse/web` exits 0
- [ ] `npm test --workspace @synapse/web` exits 0 (new `kickUrl` assertion)
- [ ] `npm run build --workspace @synapse/web` exits 0
- [ ] `npm run lint` exits 0 and `npm run format:check` exits 0
- [ ] `git grep -n "session.end\|kick" packages/protocol/src` shows NO new client
      WS message type added for kick (kick is HTTP only; `session.end` already existed)
- [ ] `apps/server/src/index.ts` `authorized()`/WS `verifyClient`/`handleGitHubWebhook`/machine-`/state` unchanged
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 055 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows the listed files changed since `7e528e0` and the excerpts
  no longer match (especially `AuthContext`, `requireOwner`, `endSession`/
  `session.end`, or `OnlinePanel`'s props).
- `applyMessage` does NOT accept a `"session.end"` client message with
  `{ repoId, sessionId }`, or `endSession` does not release edit locks as described.
- Closing the socket appears to require changing the WS `verifyClient` handshake
  or adding a client WS message — it must not; the kick is an HTTP route that calls
  `socket.close()` on the already-open socket.
- A step's verification fails twice after a reasonable fix attempt.
- You find you must modify `authorized()`, `handleGitHubWebhook`, the machine
  `/state` route, or the `endSession` teardown.

## Maintenance notes

- **Authorization**: the kick route authorizes by `projectStore.getProject(ownerId, repoId)`
  exactly like the #106 read route — a reviewer must confirm a non-owner cannot
  kick (the test asserts `kicked` stays empty on 403). The browser never touches
  the machine WS protocol; the kick is a plain authenticated HTTP POST.
- **Interrupt, not ban**: there is deliberately no blocklist. A kicked daemon's
  backoff reconnects as a new Session (new sessionId from the CLI's
  `${member}-${randomUUID()}` default). If banning is ever wanted, that's a separate
  plan with an explicit blocklist + ADR.
- **socket↔session tracking** is last-writer-wins per socket. If a single socket
  ever multiplexed multiple sessions (it does not today — one daemon, one session),
  this would need a set per socket. Noted as the upgrade path.
- The live socket-close path is exercised at runtime; the hermetic tests cover the
  authz boundary and the state teardown (end + lock release + fresh reconnect). A
  full live-socket integration test is deferred (it needs a cookie session, i.e.
  the OAuth flow, to drive the HTTP route end-to-end) — note it, don't build it.
- **#108+** owner actions can follow this same pattern: cookie-authed HTTP route +
  ownership check + an injected server-capability function.
