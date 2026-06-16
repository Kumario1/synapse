# Plan 039: Stop refreshing `lastSeen` on ended sessions so they actually prune

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- apps/server/src/state.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

Plan 032 guaranteed `state.sessions` stays bounded: a session ended (explicitly
or by the liveness sweep) for `SESSION_PRUNE_MS` (24h) is removed from state.
That guarantee is defeated for the most common flow. `touchSession` refreshes
`lastSeen` on *every* heartbeat **unconditionally**, including for sessions
already `status:"ended"`. A daemon that ran `synapse session --action end` (or
was swept to `ended` after a transient network blip) but whose **process stays
alive** keeps firing `session.heartbeat` every 30s, so the ended session's
`lastSeen` is perpetually refreshed, its age never crosses `SESSION_PRUNE_MS`,
and it is **never pruned** — lingering forever in the snapshot broadcast and the
`synapse why` / onboard corpus. The fix is one guarded assignment.

## Current state

- `apps/server/src/state.ts:263-291` — `touchSession`:

```ts
function touchSession(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  sessionId: string,
  now: string,
  branch?: string,
  task?: string
): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    session.lastSeen = now;                      // ← unconditional; refreshes ended sessions too
    if (session.status !== "ended") {
      session.status = "active";
    }
    if (branch) {
      session.branch = branch;
    }
    if (task) {
      session.lastTask = task;
    }
    store.upsertSession(repoId, session);
  }
}
```

The `status !== "ended"` guard only protects the *status* field, not `lastSeen`.

- `apps/server/src/state.ts:218-244` — `pruneStaleSessions` removes a session
  only when `session.status === "ended" && age > SESSION_PRUNE_MS`, where
  `age = now - Date.parse(session.lastSeen)`. So while `lastSeen` keeps moving,
  `age` never exceeds the prune threshold.

- `apps/server/src/state.ts:57-67` — `session.heartbeat` routes to `touchSession`;
  the daemon sends heartbeats for its whole lifetime.

**Design note (don't break this):** a returning daemon revives a swept session
by re-sending `session.start` (the `session.start` case sets `status:"active"`).
A bare heartbeat must NOT revive an ended session to active — the current code
already does not (the `status !== "ended"` guard), and this fix preserves that.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Build     | `npm run build`                           | exit 0              |
| Typecheck | `npm run typecheck`                        | exit 0, no errors   |
| Server unit tests | `npm test --workspace @synapse/server` | all pass         |

## Scope

**In scope**:
- `apps/server/src/state.ts` — guard the `lastSeen` assignment in `touchSession`.
- `apps/server/src/state.test.ts` — add a regression test.

**Out of scope**:
- `pruneStaleSessions` / `SESSION_PRUNE_MS` / `SESSION_STALE_MS` — unchanged.
- The daemon heartbeat loop in `apps/cli/src/daemon.ts` — do NOT change the
  client; the server-side fix is version-independent and strictly safer.
- The `session.start` revival path — must keep reviving swept sessions.

## Git workflow

- Branch: `advisor/039-stop-refreshing-ended-session-lastseen`
- Commit style: `fix(server): freeze lastSeen on ended sessions so they prune`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Guard the `lastSeen` refresh

In `apps/server/src/state.ts`, change the unconditional `session.lastSeen = now;`
in `touchSession` so an already-ended session does not get its `lastSeen`
refreshed. Move it inside the existing non-ended branch:

```ts
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    // A heartbeat from a still-alive daemon must not keep an ended session
    // "fresh" — that would block pruning forever (plan 039). Only live sessions
    // refresh lastSeen; an ended session ages out and is pruned by
    // pruneStaleSessions after SESSION_PRUNE_MS.
    if (session.status !== "ended") {
      session.lastSeen = now;
      session.status = "active";
      if (branch) {
        session.branch = branch;
      }
      if (task) {
        session.lastTask = task;
      }
      store.upsertSession(repoId, session);
    }
  }
```

Note: when the session is ended, the whole body is skipped — no `store.upsertSession`,
no branch/task update. That is correct: an ended session takes no heartbeat
updates until it is revived by `session.start`.

**Verify**: `npm run build && npm run typecheck` → exit 0.

### Step 2: Add a regression test

In `apps/server/src/state.test.ts`, add a test that reproduces the leak and
proves the fix. Use the existing helpers/patterns in that file (it already
constructs `TeamState` and calls `applyMessage` / the exported mutators). The
test must:

1. Start a session (`session.start`), then end it (`session.end`) at time `T0`.
2. Send a `session.heartbeat` for that session at a later wall-clock `now`
   (pass an explicit `now` if `applyMessage` accepts one — it does, see
   `state.ts:46`).
3. Assert the ended session's `lastSeen` did **not** advance to the heartbeat
   time (it stays at the end time).
4. Call `pruneStaleSessions(state, store, T0 + SESSION_PRUNE_MS + 1)` and assert
   the session is removed from `state.sessions`.

Without the fix, step 3 fails (lastSeen advanced) and step 4's session survives.

**Verify**: `npm test --workspace @synapse/server` → all pass, including the new test.

## Test plan

- New test in `state.test.ts`: "ended session does not refresh lastSeen on
  heartbeat and is pruned after SESSION_PRUNE_MS" (steps above).
- Regression: existing session/liveness tests in `state.test.ts` still pass —
  in particular any test asserting that a live session's heartbeat *does*
  refresh `lastSeen` and revives `active`.

## Done criteria

ALL must hold:

- [ ] `npm run build` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/server` exits 0; the new ended-session prune test passes
- [ ] A heartbeat on an `ended` session leaves `lastSeen` unchanged (asserted by the new test)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `touchSession` no longer matches the "Current state" excerpt.
- An existing test asserts that an ended session's heartbeat *should* update
  `lastSeen` or revive it (would mean the behavior is intentional somewhere) —
  STOP and report rather than deleting that test.
- `applyMessage` does not accept an explicit `now` parameter (the test design
  depends on it) — STOP and report; an alternative is to inject time another way.

## Maintenance notes

- This interacts with plan 032's liveness sweep: a session swept to `ended`
  while its daemon is still alive (transient network blip) now ages out and
  prunes after 24h instead of lingering forever. If product wants such a session
  to *revive* on the next heartbeat instead of waiting for `session.start`,
  that's a separate behavioral decision — note it, don't implement it here.
- Reviewer should confirm the daemon still re-sends `session.start` on
  reconnect (it does today), so legitimately-returning daemons are unaffected.
