# Plan 044: Cap edit locks per session to bound state growth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- apps/server/src/state.ts`
> If it changed, compare the "Current state" excerpt against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED (eviction could drop a lock a session still holds; bounded by a
  high cap and oldest-first eviction so only pathological clients are affected)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

`edit.intent` registers an edit lock keyed by `(sessionId, symbolId.raw)`, and
`symbolId.raw` is free text validated only as `min(1)` in the wire schema. There
is **no cap** on how many distinct locks one session can hold — `upsertEditLock`
pushes a new lock for every new `symbolId.raw`. An authorized-but-buggy or
hostile client (in open or shared-token mode) can register hundreds of synthetic
locks per minute (up to the WS rate limit of 600/min), growing `state.editLocks`
and the persisted store, and inflating the `state.snapshot` / `state.delta`
broadcast sent to **every** peer in the room. Recent pushes, repo events, and
summaries are all capped (`state.ts:16-19`); edit locks are the one unbounded
per-session collection. This caps them with oldest-first eviction.

## Current state

- `apps/server/src/state.ts` — `upsertEditLock` (no cap):

```ts
function upsertEditLock(state: TeamState, repoId: string, store: StateStoreOps, lock: EditLock): void {
  const index = state.editLocks.findIndex(
    (candidate) =>
      candidate.sessionId === lock.sessionId && candidate.symbolId.raw === lock.symbolId.raw
  );

  if (index === -1) {
    state.editLocks.push(lock);
  } else {
    state.editLocks[index] = lock;
  }
  store.upsertEditLock(repoId, lock);
}
```

- `apps/server/src/state.ts:16-19` — existing caps to mirror:

```ts
const RECENT_PUSH_CAP = 50;
const RECENT_REPO_EVENT_CAP = 50;
const SESSION_SUMMARY_CAP = 50;
const CONFLICT_FEEDBACK_CAP = 100;
```

- `apps/server/src/state.ts:167-178` — `pruneExpiredLocks` already deletes locks
  by TTL (90s) via `store.deleteEditLock(repoId, sessionId, symbolId.raw)` — the
  exact store call to reuse for eviction.
- `EditLock.acquiredAt` is an ISO string (`state.ts:76` sets it to `now`), so
  oldest-first eviction sorts by `Date.parse(acquiredAt)`.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Build     | `npm run build`                           | exit 0              |
| Typecheck | `npm run typecheck`                        | exit 0, no errors   |
| Server unit tests | `npm test --workspace @synapse/server` | all pass         |
| Atomic-intent verify | `npm run verify:atomic-intent`   | exit 0, ends `PASS` |

## Scope

**In scope**:
- `apps/server/src/state.ts` — add a per-session cap with oldest-first eviction
  in `upsertEditLock`.
- `apps/server/src/state.test.ts` — add a cap/eviction test.

**Out of scope**:
- `pruneExpiredLocks`, `peerLocksForIntent`, `pruneStaleSessions` — unchanged.
- The wire schema / `symbolId` validation — do NOT change `symbolId.raw`
  validation here (a separate concern).
- Global (cross-session) lock caps — per-session is the right granularity; a
  global cap could let one session starve another.

## Git workflow

- Branch: `advisor/044-cap-edit-locks-per-session`
- Commit style: `fix(server): cap edit locks per session (oldest-first eviction)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the cap constant

In `apps/server/src/state.ts`, alongside the other caps (`state.ts:16-19`):

```ts
// Per-session edit-lock cap (plan 044): symbolId.raw is free text, so without a
// cap a runaway/hostile client could register unbounded locks, bloating memory,
// the store, and the broadcast snapshot. 200 is far above any real session (a
// session edits a handful of symbols and locks TTL out in 90s). Evict the
// session's oldest lock when over cap. Tunable for tests/abuse response.
const EDIT_LOCK_PER_SESSION_CAP = Number(process.env.SYNAPSE_EDIT_LOCK_CAP ?? 200);
```

**Verify**: `npm run build` → exit 0.

### Step 2: Evict the oldest lock when a session is at cap

Change `upsertEditLock` so a **new** lock (index === -1) for a session already at
cap first evicts that session's oldest lock (by `acquiredAt`) from both memory
and the store. Replacing an existing lock (index !== -1) does not change the
count, so it is exempt.

```ts
function upsertEditLock(state: TeamState, repoId: string, store: StateStoreOps, lock: EditLock): void {
  const index = state.editLocks.findIndex(
    (candidate) =>
      candidate.sessionId === lock.sessionId && candidate.symbolId.raw === lock.symbolId.raw
  );

  if (index === -1) {
    const sessionLocks = state.editLocks.filter((l) => l.sessionId === lock.sessionId);
    if (EDIT_LOCK_PER_SESSION_CAP > 0 && sessionLocks.length >= EDIT_LOCK_PER_SESSION_CAP) {
      let oldest = sessionLocks[0];
      for (const candidate of sessionLocks) {
        if (Date.parse(candidate.acquiredAt) < Date.parse(oldest.acquiredAt)) {
          oldest = candidate;
        }
      }
      state.editLocks = state.editLocks.filter((l) => l !== oldest);
      store.deleteEditLock(repoId, oldest.sessionId, oldest.symbolId.raw);
    }
    state.editLocks.push(lock);
  } else {
    state.editLocks[index] = lock;
  }
  store.upsertEditLock(repoId, lock);
}
```

**Verify**: `npm run build && npm run typecheck` → exit 0.

### Step 3: Add a cap/eviction unit test

In `apps/server/src/state.test.ts`, add a test:

1. Apply `EDIT_LOCK_PER_SESSION_CAP + 1` `edit.intent` messages for one session,
   each with a distinct `symbolId.raw` and a strictly increasing `acquiredAt`
   (pass increasing `now` values to `applyMessage`).
2. Assert `state.editLocks.filter(l => l.sessionId === sid).length === EDIT_LOCK_PER_SESSION_CAP`.
3. Assert the **first** (oldest) symbol is no longer present and the newest is.
4. Apply a lock for a **different** session and assert it is unaffected by the
   first session's count (per-session, not global).

To keep the test fast, set `process.env.SYNAPSE_EDIT_LOCK_CAP = "3"` at the top
of the test and restore it after (or read the cap via a small exported accessor
— prefer the env approach to avoid changing the module surface). Confirm the
constant is read from env at module load; if it is captured at import time and
your test sets the env too late, instead export `EDIT_LOCK_PER_SESSION_CAP` or a
helper and assert against it. (See STOP conditions.)

**Verify**: `npm test --workspace @synapse/server` → all pass, including new test.

### Step 4: Confirm the atomic-intent path still works

The atomic check (plan 036) reads peer locks on the `edit.intent` ack. Confirm
capping didn't break it.

**Verify**: `npm run verify:atomic-intent` → exit 0, ends `PASS`.

## Test plan

- New unit test in `state.test.ts`: per-session cap enforced, oldest evicted,
  sessions independent (steps above).
- Regression: existing lock/intent tests in `state.test.ts` and
  `verify:atomic-intent` pass — eviction only triggers above the cap, far beyond
  what those tests exercise.

## Done criteria

ALL must hold:

- [ ] `npm run build` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/server` exits 0; the cap/eviction test passes
- [ ] `npm run verify:atomic-intent` exits 0
- [ ] A session over cap retains exactly `cap` locks and the oldest was evicted (asserted)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `upsertEditLock` no longer matches the "Current state" excerpt.
- The cap constant is captured at module import in a way the test cannot
  override via env (the test then needs an exported constant/accessor) — report
  which approach you took.
- `verify:atomic-intent` fails after the change — eviction must never drop a lock
  the same `edit.intent` just added; if it does, the cap logic is wrong, STOP.

## Maintenance notes

- The cap is generous (200) so it never bites a real session; it exists purely to
  bound abuse. If a legitimate workflow ever holds more than 200 live locks,
  raise `SYNAPSE_EDIT_LOCK_CAP` rather than removing the cap.
- Eviction is oldest-by-`acquiredAt`. Since locks TTL out at 90s, the oldest is
  also the closest to expiry — evicting it is low-harm.
- Pairs conceptually with the existing `recentPushes`/`summaries` caps; if a new
  unbounded per-session/-repo collection is ever added, give it a cap too.
