# Plan 038: Gate the per-read state prune sweeps behind a short interval

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- apps/server/src/index.ts apps/server/src/state.ts packages/conflict-engine/src/index.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

`getState()` runs two full-array prune passes (`pruneExpiredLocks` +
`pruneStaleSessions`) on **every** invocation — and `getState` is called inside
`withRepo` on every inbound WS message (the daemon heartbeats twice a minute
*per session*, plus every `edit.intent` / `contract.delta`), every webhook,
every `/state` GET, and every new connection. Each pass linearly rebuilds an
array and calls `Date.parse` per element even when nothing has expired. On the
single serialized `withRepo` apply path this is pure allocation churn that
head-of-lines every other repo operation. Gating the sweep behind a small
"last swept at" interval removes the per-message cost, but only after the
conflict engine stops treating expired locks in `state.editLocks` as active.

## Current state

- `apps/server/src/index.ts:615-628` — `getState` prunes on every call:

```ts
async function getState(repoId: string): Promise<TeamState> {
  const state = await getCachedState(repoId, {
    states,
    dirtyRepos,
    loadsInFlight,
    load: (id) => store.load(id),
    createEmpty: createEmptyTeamState,
    onLoaded: (id, fresh) => log.debug("state.loaded", { repoId: id, sessions: fresh.sessions.length })
  });

  pruneExpiredLocks(state, store);
  pruneStaleSessions(state, store);
  return state;
}
```

- `apps/server/src/state.ts:167-179` — `pruneExpiredLocks(state, store)` rebuilds
  `state.editLocks`, `Date.parse` per lock.
- `apps/server/src/state.ts:218-244` — `pruneStaleSessions(state, store, now?)`
  rebuilds `state.sessions`, marks stale sessions ended, drops their locks.

**Safety refresh from the first execute attempt:** `peerLocksForIntent`
(`state.ts:187-203`) already re-filters by `acquiredAt + ttlSec`, but
`packages/conflict-engine/src/index.ts` currently iterates
`context.state.editLocks` directly when raising `same_symbol_active`. That means
an expired-but-not-yet-swept lock could produce a false conflict after this gate.
Fix that first by filtering edit locks at conflict-evaluation time; then the
only remaining observable effect of gating is that a stale session or expired
lock may linger in the broadcast snapshot for up to the interval longer.

### Repo conventions to match

- Env-var tunables are read once at module scope with a `Number(process.env.X ?? default)`
  pattern and a comment — see `apps/server/src/index.ts:264-265`
  (`WS_RATE_LIMIT_PER_MIN`) and `apps/server/src/state.ts:27-28`
  (`SESSION_STALE_MS`). Match that style.
- Small pure helpers are exported from the module that owns the data and
  unit-tested in the sibling `*.test.ts` — see `pruneExpiredLocks` exported from
  `state.ts` and tested in `apps/server/src/state.test.ts`.
- The conflict engine is pure and unit-tested in
  `packages/conflict-engine/src/index.test.ts`; keep TTL filtering there pure
  and do not import server code into the package.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Build     | `npm run build`                           | exit 0              |
| Typecheck | `npm run typecheck`                        | exit 0, no errors   |
| Conflict-engine unit tests | `npm test --workspace @synapse/conflict-engine` | all pass |
| Server unit tests | `npm test --workspace @synapse/server` | all pass         |
| Persistence verify | `npm run verify:persistence`         | exit 0, `PASS`      |

## Scope

**In scope** (the only files you should modify):
- `packages/conflict-engine/src/index.ts` — ignore expired edit locks during
  conflict evaluation.
- `packages/conflict-engine/src/index.test.ts` — add a regression test proving
  expired locks do not raise `same_symbol_active`.
- `apps/server/src/index.ts` — add the gate in `getState`.
- `apps/server/src/state.ts` — add and export a tiny `dueForSweep` helper.
- `apps/server/src/state.test.ts` — add a unit test for `dueForSweep`.

**Out of scope** (do NOT touch):
- The bodies of `pruneExpiredLocks` / `pruneStaleSessions` — their logic is
  correct and other call sites depend on it.
- `peerLocksForIntent` — already TTL-filters the server-authoritative
  edit-intent ack path.
- The persisted/broadcast `TeamState` shape — do NOT add a field to it (it goes
  over the wire and through the store). Keep the sweep bookkeeping in a
  module-local `Map`.

## Git workflow

- Branch: `advisor/038-gate-state-prune-sweeps`
- Commit message style: conventional commits, e.g.
  `perf(server): gate state prune sweeps behind a short interval`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make conflict evaluation ignore expired edit locks

In `packages/conflict-engine/src/index.ts`, add a small exported helper near the
other pure helpers:

```ts
export function editLockIsActive(lock: EditLock, now = Date.now()): boolean {
  const acquiredAt = Date.parse(lock.acquiredAt);
  return Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000;
}
```

Then change the edit-lock loop in `evaluateConflicts` from:

```ts
    for (const lock of context.state.editLocks) {
```

to:

```ts
    for (const lock of context.state.editLocks.filter((lock) => editLockIsActive(lock))) {
```

Keep this as a conflict-engine helper; do not import `pruneExpiredLocks` or
server code.

**Verify**: `npm run build` -> exit 0.

### Step 2: Unit-test expired lock filtering in the conflict engine

In `packages/conflict-engine/src/index.test.ts`, add a test with one expired
lock for another session on the target symbol:

- `acquiredAt: "2026-06-14T00:00:00.000Z"`
- `ttlSec: 1`
- run `evaluateConflicts` after enough real wall-clock time has passed (the
  fixed date is safely in the past relative to the repo's 2026 tests)
- assert no `same_symbol_active` conflict is produced.

Also assert `editLockIsActive` directly for a live and expired lock if that keeps
the test simple.

**Verify**: `npm test --workspace @synapse/conflict-engine` -> all pass.

### Step 3: Add and export the `dueForSweep` helper in `state.ts`

In `apps/server/src/state.ts`, near the other exported prune functions, add:

```ts
/**
 * True when a repo's prune sweep is due: the previous sweep was at least
 * `intervalMs` ago. Gating the per-read sweeps (plan 038) behind this removes
 * the full-array rebuild from the hot per-message path; TTL correctness is
 * unaffected because lock/session expiry is re-checked at the point of use
 * (peerLocksForIntent, conflict evaluation), never trusted from the pruned
 * array.
 */
export function dueForSweep(lastSweptAt: number, now: number, intervalMs: number): boolean {
  return now - lastSweptAt >= intervalMs;
}
```

**Verify**: `npm run build` -> exit 0.

### Step 4: Gate the sweep in `getState`

In `apps/server/src/index.ts`, add a module-scope tunable and bookkeeping map
near the other tunables (e.g. just after `WS_RATE_LIMIT_PER_MIN`/`WEBHOOK_RATE_LIMIT_PER_MIN`
at `index.ts:264-265`):

```ts
// Prune-sweep throttle (plan 038): getState() is called on every inbound
// message; sweeping the lock/session arrays every time is wasted work. Sweep at
// most once per interval per repo. Expiry is still re-checked at use time, so
// the only effect is a briefly-stale broadcast snapshot. Set 0 to sweep always.
const SWEEP_INTERVAL_MS = Number(process.env.SYNAPSE_SWEEP_INTERVAL_MS ?? 1000);
const lastSweptAt = new Map<string, number>();
```

Then change `getState` (`index.ts:615-628`) so the prune block is gated, and
import `dueForSweep` from `./state.js` (add it to the existing import from that
module):

```ts
async function getState(repoId: string): Promise<TeamState> {
  const state = await getCachedState(repoId, {
    states,
    dirtyRepos,
    loadsInFlight,
    load: (id) => store.load(id),
    createEmpty: createEmptyTeamState,
    onLoaded: (id, fresh) => log.debug("state.loaded", { repoId: id, sessions: fresh.sessions.length })
  });

  const now = Date.now();
  if (dueForSweep(lastSweptAt.get(repoId) ?? 0, now, SWEEP_INTERVAL_MS)) {
    pruneExpiredLocks(state, store);
    pruneStaleSessions(state, store);
    lastSweptAt.set(repoId, now);
  }
  return state;
}
```

Confirm `pruneExpiredLocks` and `pruneStaleSessions` are already imported in
`index.ts` (they are — the current code calls them); add `dueForSweep` to that
same import statement.

**Verify**: `npm run build && npm run typecheck` -> exit 0, no errors.

### Step 5: Unit-test `dueForSweep`

In `apps/server/src/state.test.ts`, following the existing `node:test`
structure (`import { test } from "node:test"; import assert from "node:assert/strict";`),
add a test:

- `dueForSweep(0, 1000, 1000)` → `true` (first sweep always due).
- `dueForSweep(1000, 1500, 1000)` → `false` (within interval).
- `dueForSweep(1000, 2000, 1000)` → `true` (interval elapsed).
- `dueForSweep(1000, 1500, 0)` → `true` (interval 0 = always sweep).

**Verify**: `npm test --workspace @synapse/server` -> all pass, including the new test.

### Step 6: Confirm no behavioral regression in persistence

**Verify**: `npm run verify:persistence` -> exit 0, ends with `PASS`.

## Test plan

- New unit test: `dueForSweep` truth table in `apps/server/src/state.test.ts`
  (cases listed in Step 5). Model after the existing prune tests in that file.
- New unit test: expired edit locks do not raise `same_symbol_active` in
  `packages/conflict-engine/src/index.test.ts`.
- Regression: the existing `state.test.ts` prune tests must still pass
  unchanged (prune bodies are untouched).
- Integration: `verify:persistence` proves state still survives a restart with
  the gated sweep.

## Done criteria

ALL must hold:

- [ ] `npm run build` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/conflict-engine` exits 0; expired edit locks do not conflict
- [ ] `npm test --workspace @synapse/server` exits 0; the new `dueForSweep` test exists and passes
- [ ] `npm run verify:persistence` exits 0
- [ ] `grep -n "dueForSweep" apps/server/src/index.ts` shows the gate in use
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `getState` or the prune functions no longer match the "Current state"
  excerpts (the file drifted).
- `evaluateConflicts` no longer has a single edit-lock loop that can be filtered
  locally, or filtering there would require changing conflict verdicts/severity.
- Any existing `state.test.ts` prune test starts failing.

## Maintenance notes

- If a future change makes the broadcast snapshot authoritative for lock
  expiry (i.e. consumers stop re-checking TTL), this gating becomes unsafe —
  revisit then.
- The default 1s interval is a balance; `SYNAPSE_SWEEP_INTERVAL_MS=0` restores
  the always-sweep behavior for diagnostics.
- A reviewer should confirm the `lastSweptAt` map can't grow unbounded across
  many repos in a long-lived multi-tenant server — it has one entry per repoId
  ever seen. If that matters later, evict alongside the existing repo-state
  eviction (none today; acceptable for current single-/few-repo deployments).
