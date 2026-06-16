# Plan 021: Clear failed state loads so repos can recover

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/server/src/index.ts apps/server/src/store-pg.ts apps/server/src/state.test.ts apps/server/src/store.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The server caches one in-flight state load promise per repo. If the backing
store load rejects, the rejected promise stays in `loadsInFlight` because the
delete happens only after a successful `store.load()`. Every later read for
that repo awaits the same rejected promise until process restart. A transient
Postgres failure can therefore permanently wedge a repo in one server process.

## Current state

Relevant files:

- `apps/server/src/index.ts` - private `getState()` cache/load logic.
- `apps/server/src/store-pg.ts` - `load()` can reject on pool query failure.
- `apps/server/src/state.test.ts` / `store.test.ts` - existing server test style.

Current code:

```ts
// apps/server/src/index.ts:582
inFlight = (async () => {
  dirtyRepos.delete(repoId);
  const fresh = (await store.load(repoId)) ?? createEmptyTeamState(repoId);
  states.set(repoId, fresh);
  loadsInFlight.delete(repoId);
  log.debug("state.loaded", { repoId, sessions: fresh.sessions.length });
  return fresh;
})();
```

`apps/server/src/store-pg.ts:137` performs real pool queries inside `load()`;
those can reject during a transient DB outage.

Repo conventions:

- The store queue logs persistence failures but does not break the in-memory
  server path.
- Server tests use `node:test` and `node:assert/strict` from compiled `dist`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck --workspace @synapse/server` | exit 0 |
| Server tests | `npm run build && npm test --workspace @synapse/server` | exit 0 |
| Full check | `npm run check` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `apps/server/src/index.ts`
- Optional focused server test/helper file if you extract the cache logic for
  testability.

**Out of scope**:

- Rewriting the state cache.
- Changing store queue semantics.
- Changing Postgres retry policies.

## Git workflow

- Branch: `advisor/021-clear-failed-state-loads`
- Commit style: `fix(server): clear failed state loads for retry`.

## Steps

### Step 1: Make failed loads retryable

In `getState()`, wrap the load body so `loadsInFlight.delete(repoId)` runs in
`finally`.

Also preserve retry intent on failure. Because the code deletes
`dirtyRepos` before loading, a rejected load should either re-add
`dirtyRepos.add(repoId)` in `catch` or otherwise ensure the next call enters
the load loop again.

Target behavior:

```ts
inFlight = (async () => {
  dirtyRepos.delete(repoId);
  try {
    const fresh = (await store.load(repoId)) ?? createEmptyTeamState(repoId);
    states.set(repoId, fresh);
    log.debug("state.loaded", { repoId, sessions: fresh.sessions.length });
    return fresh;
  } catch (error) {
    dirtyRepos.add(repoId);
    throw error;
  } finally {
    loadsInFlight.delete(repoId);
  }
})();
```

Keep exact logging style consistent with the file.

**Verify**: `npm run typecheck --workspace @synapse/server` -> exit 0.

### Step 2: Add the narrowest feasible regression coverage

Preferred: extract the in-flight load behavior into a tiny internal helper that
can be unit-tested with a fake store that fails once then succeeds. If that
extraction grows beyond a small local helper, do not perform a broad refactor;
instead keep the local fix and add a comment explaining why the `finally` and
`dirtyRepos.add()` are paired.

If you add a helper test, assert:

- first read rejects;
- second read retries the store instead of reusing the old rejection;
- concurrent reads during a successful load still share one promise.

**Verify**: `npm run build && npm test --workspace @synapse/server` -> exit 0.

## Test plan

- Focused fake-store test if you extract the helper.
- Existing server state/store tests still pass.
- Full repo check passes.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `loadsInFlight.delete(repoId)` runs in a `finally`.
- [ ] Failed loads do not clear retry intent permanently.
- [ ] No broad state-cache refactor was introduced.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- Fixing this requires changing state persistence interfaces.
- A testable extraction starts moving unrelated WebSocket, fanout, or route
  code.

## Maintenance notes

This is a small reliability guard. Future multi-instance work should keep the
same invariant: cache in-flight successful work, but never cache permanent
failures for repo state loading.
