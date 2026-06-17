# Plan 032: Expire stale sessions and stop reconnect from wiping task intent

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/server/src/state.ts apps/server/src/state.test.ts apps/server/src/index.ts apps/server/src/store.ts apps/server/src/store-pg.ts apps/cli/src/daemon.ts`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.
>
> **Known concurrent plans (verified 2026-06-13)**: a separate audit at this
> same commit produced plans 017–031, executed in isolated worktrees that are
> NOT merged into HEAD (`e3c46f2` is unchanged — `daemon.ts` still binds all
> interfaces and `getState` is unmodified). Several touch files this plan
> touches: 021 (clear failed state loads → `index.ts` `getState`), 028
> (`state.delta` → `index.ts` broadcast + `daemon.ts` socket handlers), 022
> (`daemon.ts` session handler), 018/019 (`daemon.ts`). If any land before this
> plan, the drift check WILL report them — re-anchor by SYMBOL NAME (`getState`,
> the `pruneExpiredLocks` call, the `socket.on("open")` handler, the
> `/tools/synapse_session` handler), not the cited line numbers, and treat the
> overlap as expected, not a STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `e3c46f2`, 2026-06-13

## Why this matters

A Synapse session is only removed from shared state by an explicit
`session.end`. A daemon that crashes, loses its network, or has its laptop
closed never sends that — so its session stays `status: "active"` **forever**:

- It shows as a live teammate in `synapse whatsup` and `synapse onboard`
  (`buildWhatsupResponse` keeps every session with `status !== "ended"`,
  `apps/cli/src/briefings.ts:72`).
- It keeps generating `same_file_no_overlap` conflicts (the conflict engine's
  `activeOtherSessions` treats `active` and `idle` as live,
  `packages/conflict-engine/src/index.ts:299-305`) — violating the design
  principle "silent on no-conflict."
- `state.sessions` is never bounded or pruned, so it — and the full-state
  snapshot broadcast on every mutation, and the `synapse why` corpus
  (`whySources` maps **every** session, `apps/cli/src/briefings.ts:424`) — grow
  without limit over a room's lifetime. The server only ever prunes locks
  (`pruneExpiredLocks`, `apps/server/src/state.ts:150`), never sessions.

Separately, the daemon **erases its own task intent on every reconnect**. On
socket open it re-sends `session.start` built by `makeSession(config)` with
`lastTask: null` (`apps/cli/src/daemon.ts:190`, `:662`), and the server's
`upsertSession` merge spreads `...session` over the existing row
(`apps/server/src/state.ts:172-177`), overwriting `lastTask` (and resetting
`startedAt`). So any server restart, half-open-socket termination, or network
blip wipes "what this agent is working on" — the field briefings depend on.
(Note: `filesEditing`/`filesOpen` are NOT wiped — they are merged with `unique([...])`,
so an empty array is a no-op there; only `lastTask`/`startedAt` are clobbered.)

This plan makes session state trustworthy: a server-side liveness sweep
(active → ended after a missed-heartbeat window, then prune long-ended
sessions, durably) and a client fix so a reconnect preserves the task.

## Current state

- `apps/server/src/state.ts:150-162` — the only sweep today, the model to follow
  for the new one:

  ```ts
  export function pruneExpiredLocks(state: TeamState, store: StateStoreOps = noopStateStore): void {
    const now = Date.now();
    const surviving: EditLock[] = [];
    for (const lock of state.editLocks) {
      const acquiredAt = Date.parse(lock.acquiredAt);
      if (Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000) {
        surviving.push(lock);
      } else {
        store.deleteEditLock(state.repoId, lock.sessionId, lock.symbolId.raw);
      }
    }
    state.editLocks = surviving;
  }
  ```

- `apps/server/src/state.ts:181-221` — `touchSession` (heartbeat) revives a
  non-ended session to `active`; `endSession` sets `status:"ended"`, clears
  `filesEditing`, and drops the session's locks. The sweep's "mark ended" step
  must do the same teardown as `endSession`.

  ```ts
  function touchSession(state, repoId, store, sessionId, now, branch?) {
    const session = state.sessions.find((c) => c.id === sessionId);
    if (session) {
      session.lastSeen = now;
      if (session.status !== "ended") { session.status = "active"; }
      if (branch) { session.branch = branch; }
      store.upsertSession(repoId, session);
    }
  }
  ```

  Reconnect/revive note: a returning daemon sends `session.start` (not just a
  heartbeat), and `applyMessage`'s `session.start` case sets `status:"active"`
  (`state.ts:40-47`), so a session the sweep marked `ended` is correctly revived
  on reconnect. A still-alive daemon heartbeats every 30s
  (`apps/cli/src/daemon.ts:293-301`), so it never reaches the sweep threshold.

- `apps/server/src/index.ts:572-597` — `getState` is the single choke point that
  already calls `pruneExpiredLocks` before returning; the new sweep is called
  in the same place:

  ```ts
  async function getState(repoId: string): Promise<TeamState> {
    let state = states.get(repoId);
    while (!state || dirtyRepos.has(repoId)) { /* load from store */ }
    pruneExpiredLocks(state, store);
    return state;
  }
  ```

- `apps/server/src/store.ts:31-47` — `StateStoreOps` has `deleteDelta` but **no
  `deleteSession`**; the sweep needs one to prune durably. The SQLite impl to
  mirror (`store.ts:155-157`):

  ```ts
  deleteDelta(repoId: string, deltaId: string): void {
    this.db.prepare("DELETE FROM deltas WHERE repo_id = ? AND id = ?").run(repoId, deltaId);
  }
  ```

  The Postgres impl to mirror (`apps/server/src/store-pg.ts:98-100`):

  ```ts
  deleteDelta(repoId: string, deltaId: string): void {
    this.enqueue("DELETE FROM synapse_deltas WHERE repo_id = $1 AND id = $2", [repoId, deltaId]);
  }
  ```

  The `sessions` entity table is keyed by `id` (`store.ts:87`,
  `ENTITY_TABLES.sessions = { keys: ["id"], … }`), so `deleteSession` deletes
  `WHERE repo_id = ? AND id = ?`. The no-op store
  (`store.ts:61-74`) needs the method too.

- `apps/cli/src/daemon.ts:187-192` (reconnect) and `:662-678` (`makeSession`):

  ```ts
  socket.on("open", () => {
    connectionWarned = false;
    reconnectAttempt = 0;
    sendToServer("session.start", { session: makeSession(config) });  // lastTask: null
    flushOutbox();
  });
  ```
  ```ts
  function makeSession(config: RuntimeConfig, task: string | null = null): Session { … lastTask: task … }
  ```

- `apps/cli/src/daemon.ts:569-593` — the `/tools/synapse_session` handler. The
  `start` action already passes the task: `makeSession(config, body.task)`. This
  is where the daemon learns the current task and should remember it.

Repo conventions to match:
- Pure state mutations live in `apps/server/src/state.ts` and take an optional
  `store: StateStoreOps = noopStateStore`; unit tests call them directly (see
  `apps/server/src/state.test.ts`).
- Opt-out env knobs use `SYNAPSE_*=0`; tunable windows are read as
  `Number(process.env.X ?? <default>)` (see the reconnect knobs at
  `daemon.ts:162-163` and lock `ttlSec`).
- Protocol/state changes are additive and backward-compatible.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Server unit tests | `npm test --workspace @synapse/server` | exit 0 |
| Persistence E2E (SQLite) | `npm run verify:persistence` | exit 0 |
| Whatsup E2E | `npm run verify:whatsup` | exit 0 |
| Reconnect E2E | `npm run verify:reconnect` | exit 0 |

## Scope

**In scope**:
- `apps/server/src/state.ts` (add `pruneStaleSessions`)
- `apps/server/src/state.test.ts` (add tests)
- `apps/server/src/index.ts` (call the sweep in `getState`)
- `apps/server/src/store.ts` (add `deleteSession` to the interface, the SQLite
  impl, and the no-op store)
- `apps/server/src/store-pg.ts` (add the Postgres `deleteSession` impl)
- `apps/cli/src/daemon.ts` (remember the task across reconnect)

**Out of scope** (do NOT touch):
- The conflict engine and its `activeOtherSessions` semantics — do not change
  what counts as "live" for detection. The sweep only moves a session to the
  existing terminal `ended` state; detection already excludes `ended`.
- `RECENT_PUSH_CAP` and the other entity caps — unrelated.
- Adding an `idle` intermediate status — the `idle` status exists in the type
  but introducing a sweep transition into it interacts with detection; this
  plan deliberately goes straight `active → ended` (revivable via reconnect's
  `session.start`). Do not add `idle` transitions here.

## Git workflow

- Branch: `advisor/032-session-liveness`
- Suggested commits (two logical units):
  - `feat(server): sweep stale sessions and prune long-ended ones`
  - `fix(daemon): preserve session task intent across reconnect`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `deleteSession` to the store

In `apps/server/src/store.ts`:
- Add to the `StateStoreOps` interface (beside `deleteDelta`):
  `deleteSession(repoId: string, sessionId: string): void;`
- Add to `noopStateStore`: `deleteSession: () => {},`
- Add the SQLite method on `SqliteStateStore` (beside `upsertSession`/`deleteDelta`):
  ```ts
  deleteSession(repoId: string, sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE repo_id = ? AND id = ?").run(repoId, sessionId);
  }
  ```

In `apps/server/src/store-pg.ts`, add the Postgres method on
`PostgresStateStore` (beside `deleteDelta`):
```ts
deleteSession(repoId: string, sessionId: string): void {
  this.enqueue("DELETE FROM synapse_sessions WHERE repo_id = $1 AND id = $2", [repoId, sessionId]);
}
```

**Verify**: `npm run typecheck` → exit 0 (the interface method now has impls in
both backends and the no-op; a missing one is a compile error).

### Step 2: Write `pruneStaleSessions` in state.ts

Add, modeled on `pruneExpiredLocks`, with two thresholds and an opt-out:

```ts
// A live daemon heartbeats every 30s; a session silent past this is treated as
// gone and moved to the terminal `ended` state (same teardown as session.end),
// so it leaves briefings and stops generating same_file conflicts. A returning
// daemon revives it via session.start. An ended session older than the prune
// window is removed outright so state never grows without bound.
const SESSION_STALE_MS = Number(process.env.SYNAPSE_SESSION_TTL_MS ?? 300_000);      // 5 min
const SESSION_PRUNE_MS = Number(process.env.SYNAPSE_SESSION_PRUNE_MS ?? 86_400_000); // 24 h

export function pruneStaleSessions(
  state: TeamState,
  store: StateStoreOps = noopStateStore,
  now: number = Date.now()
): void {
  if (process.env.SYNAPSE_SESSION_SWEEP === "0") {
    return;
  }

  const surviving: Session[] = [];
  for (const session of state.sessions) {
    const lastSeen = Date.parse(session.lastSeen);
    const age = Number.isNaN(lastSeen) ? 0 : now - lastSeen;

    // Remove sessions that have been ended for longer than the prune window.
    if (session.status === "ended" && age > SESSION_PRUNE_MS) {
      store.deleteSession(state.repoId, session.id);
      continue;
    }

    // Mark a silent (presumed-dead) session ended: same teardown as endSession.
    if (session.status !== "ended" && age > SESSION_STALE_MS) {
      session.status = "ended";
      session.filesEditing = [];
      state.editLocks = state.editLocks.filter((lock) => lock.sessionId !== session.id);
      store.deleteEditLocksForSession(state.repoId, session.id);
      store.upsertSession(state.repoId, session);
    }

    surviving.push(session);
  }
  state.editLocks = state.editLocks; // (no-op; locks already filtered above)
  state.sessions = surviving;
}
```

Notes for correctness:
- `Number.isNaN(lastSeen) ? 0` keeps a session with an unparseable timestamp
  rather than sweeping it (mirrors `pruneExpiredLocks`' NaN handling).
- Removing locks inline mirrors `endSession` (`state.ts:219-220`).
- Do not import anything new; `Session`, `TeamState`, `EditLock`,
  `StateStoreOps`, `noopStateStore` are already imported in this file.

**Verify**: `npm run build` → exit 0.

### Step 3: Call the sweep in `getState`

In `apps/server/src/index.ts`, in `getState` (after the existing
`pruneExpiredLocks(state, store);` at `:595`):

```ts
pruneExpiredLocks(state, store);
pruneStaleSessions(state, store);
return state;
```

Add `pruneStaleSessions` to the existing import from `./state.js`
(`index.ts:22`: `import { applyMessage, pruneExpiredLocks, pruneStaleSessions, repoIdFor } from "./state.js";`).

**Verify**: `npm run build` → exit 0.

### Step 4: Unit-test the sweep

In `apps/server/src/state.test.ts`, add cases (match the file's existing style —
read it first; it constructs a `TeamState`, calls a mutation, and asserts on the
resulting arrays). Pass an explicit `now` to make time deterministic; you can
construct sessions with `lastSeen` set to a fixed ISO string and call
`pruneStaleSessions(state, noopStateStore, <now ms>)`:

1. A session with `status:"active"` and `lastSeen` older than 5 min →
   becomes `status:"ended"`, `filesEditing` emptied, and any of its
   `editLocks` removed.
2. A session with `status:"active"` and a **fresh** `lastSeen` (e.g. `now`) →
   unchanged (still active).
3. A session with `status:"ended"` and `lastSeen` older than 24 h → removed
   from `state.sessions` entirely.
4. With `SYNAPSE_SESSION_SWEEP=0` set, a long-stale active session is left
   untouched (set and delete the env var within the test).
5. Revive: after case 1 marks a session ended, applying a `session.start` for
   the same id (via `applyMessage`) restores `status:"active"` — proving a
   reconnecting daemon recovers. (Use the existing `applyMessage` import.)

**Verify**: `npm test --workspace @synapse/server` → exit 0, new tests included.

### Step 5: Daemon remembers the task across reconnect

In `apps/cli/src/daemon.ts`:
- Near the top of `startDaemon` (beside the other `let` state like `socket`),
  add: `let currentTask: string | null = null;`
- In the `/tools/synapse_session` handler `start` branch (`daemon.ts:582-583`),
  capture it before sending:
  ```ts
  } else if (action === "start") {
    currentTask = body.task ?? currentTask;
    sendToServer("session.start", { session: makeSession(config, currentTask) });
  }
  ```
- In the reconnect `socket.on("open", …)` handler (`daemon.ts:190`), use the
  remembered task instead of the default null:
  ```ts
  sendToServer("session.start", { session: makeSession(config, currentTask) });
  ```

**Verify**: `npm run build` → exit 0, then `npm run verify:reconnect` → exit 0
(proves the reconnect path still delivers state after a server bounce).

### Step 6: Confirm persistence and briefings still pass

**Verify**: `npm run verify:persistence` → exit 0 (the new `deleteSession` op and
the sweep run under the real SQLite store on restart) and `npm run verify:whatsup`
→ exit 0 (briefings still render).

## Test plan

- Unit (`apps/server/src/state.test.ts`): the five `pruneStaleSessions` cases in
  Step 4 (mark-ended, fresh-kept, prune-ended, opt-out, revive).
- E2E regression: `verify:persistence` (store op + sweep under real SQLite),
  `verify:whatsup` (briefings), `verify:reconnect` (task-preserving reconnect).
- Optional but recommended: if `apps/server/src/store.test.ts` has a
  delete-op test pattern, add a `deleteSession` round-trip there too.

## Done criteria

ALL must hold:

- [ ] `grep -n 'deleteSession' apps/server/src/store.ts` → ≥ 3 matches
      (interface, no-op, SQLite impl); `grep -n 'deleteSession' apps/server/src/store-pg.ts` → 1 match
- [ ] `grep -n 'pruneStaleSessions' apps/server/src/index.ts` → ≥ 2 matches
      (import + call)
- [ ] `grep -n 'currentTask' apps/cli/src/daemon.ts` → ≥ 3 matches
- [ ] `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/server` exits 0; the 5 new sweep tests pass
- [ ] `npm run verify:persistence`, `verify:whatsup`, `verify:reconnect` exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 032 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `apps/server/src/store-pg.ts` does not contain a `deleteDelta` method shaped
  like the excerpt (the backend may have been refactored) — do not guess the
  Postgres delete shape.
- Marking a stale session `ended` in `pruneStaleSessions` causes
  `npm test --workspace @synapse/server` to fail an **existing** test about
  active-session counts — report which test; the threshold or an existing
  assumption may need a decision.
- A verification command fails twice after a focused fix attempt.
- You find yourself needing to change `activeOtherSessions` or any conflict-rule
  logic — that is out of scope; report instead.

## Maintenance notes

- This plan pairs with Plan 033 (capture task intent via a UserPromptSubmit
  hook). When 033 lands, it adds `task` to the `session.heartbeat` path; the
  heartbeat branch of the `/tools/synapse_session` handler in `daemon.ts` should
  then **also** update `currentTask` (`currentTask = body.task ?? currentTask;`)
  so a task set via heartbeat survives reconnect too. 033's maintenance note
  cross-references this.
- `startedAt` is still reset on reconnect (cosmetic — affects displayed session
  age, not coordination). If that becomes user-visible noise, remember it the
  same way as `currentTask`.
- A reviewer should confirm the sweep runs inside `withRepo` (it does — it is
  called from `getState`, which every caller wraps in the per-repo mutex), so it
  cannot race a concurrent mutation.
- The thresholds (`SYNAPSE_SESSION_TTL_MS`, `SYNAPSE_SESSION_PRUNE_MS`) and
  opt-out (`SYNAPSE_SESSION_SWEEP=0`) should be documented in the README's
  reliability/operations table alongside the lock TTL.
