# Plan 002: Always release Postgres advisory locks during initialization

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3a0b685..HEAD -- apps/server/src/store-pg.ts apps/server/src/memory.ts apps/server/src/store.test.ts apps/server/src apps/server/package.json packages/protocol/src`
> If any in-scope file changed since this plan was written, compare the current-state excerpts below against the live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug, reliability
- **Planned at**: commit `3a0b685`, 2026-06-11

## Why this matters

The server uses Postgres advisory locks to serialize DDL during concurrent instance startup. In both the durable store and vector memory initialization, the unlock query is after the DDL, not in a nested `finally`. If any DDL statement throws, the pooled connection can be released while still holding the session-level lock, causing another instance to block on startup.

## Current state

- `apps/server/src/store-pg.ts` initializes the Postgres state tables.
- `apps/server/src/memory.ts` initializes the pgvector memory table.
- `apps/server/src/store.test.ts` contains server storage tests; `packages/protocol/src/wire-schema.test.ts` is a good example of small Node test style if you add a helper test.

Relevant excerpts:

```ts
// apps/server/src/store-pg.ts:45
const client = await this.pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(727269783)"); // 'synapse'
  for (const [table, spec] of Object.entries(ENTITY_TABLES)) {
    await client.query(`CREATE TABLE IF NOT EXISTS synapse_${table} (...)`);
  }
  await client.query("SELECT pg_advisory_unlock(727269783)");
} finally {
  client.release();
}
```

```ts
// apps/server/src/memory.ts:43
const client = await this.pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(727269784)"); // 'synapse'+1
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  await client.query(`CREATE TABLE IF NOT EXISTS synapse_memory (...)`);
  await client.query("SELECT pg_advisory_unlock(727269784)");
} finally {
  client.release();
}
```

Repo conventions to match:

- Server persistence code logs failures but keeps in-memory state authoritative where possible.
- Tests use `node:test` and `node:assert/strict`.
- Dynamic imports keep optional drivers out of paths that do not need them.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Server tests | `npm test --workspace @synapse/server` | exit 0 |
| SQLite persistence smoke | `npm run verify:persistence` | exit 0 |
| Postgres persistence | `npm run verify:persistence-pg` | exits 0 or prints documented SKIP when no PG URL is configured |
| RAG/pgvector smoke | `npm run verify:why-rag` | exits 0 or prints documented SKIP when pgvector is unavailable |

## Scope

**In scope**:

- `apps/server/src/store-pg.ts`
- `apps/server/src/memory.ts`
- A small helper file such as `apps/server/src/pg-advisory-lock.ts`, if it makes the behavior testable and avoids duplication.
- A matching test file under `apps/server/src/*.test.ts`.

**Out of scope**:

- Changing the Postgres schema.
- Changing Redis fanout behavior.
- Replacing advisory locks with a migration framework.
- Changing auth, webhook, or protocol behavior.

## Git workflow

- Branch: `advisor/002-release-pg-advisory-locks`
- Suggested commit: `fix(server): release advisory locks on init failure`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Introduce a testable lock helper

Create a small helper, for example `apps/server/src/pg-advisory-lock.ts`, that accepts a connected PG client-like object and a lock id:

- Acquire with `SELECT pg_advisory_lock($1)`.
- Run a callback.
- In `finally`, if acquisition succeeded, run `SELECT pg_advisory_unlock($1)`.
- Ensure `client.release()` remains the caller's responsibility.
- Do not let an unlock failure mask the original DDL failure. If both fail, preserve the original error and log the unlock failure only if a logger is available.

Add a unit test with a fake client:

- Success path: lock -> work -> unlock.
- Work throws after lock: unlock still runs, and the original error is thrown.
- Lock acquisition throws: unlock does not run.

**Verify**: `npm test --workspace @synapse/server` -> the new helper tests pass.

### Step 2: Use the helper in state-store initialization

In `apps/server/src/store-pg.ts`, keep the same pool creation and table creation loop, but wrap only the DDL in the helper. The structure should remain close to:

```ts
const client = await this.pool.connect();
try {
  await withPgAdvisoryLock(client, 727269783, async () => {
    for (const [table, spec] of Object.entries(ENTITY_TABLES)) {
      // existing CREATE TABLE IF NOT EXISTS body
    }
  });
} finally {
  client.release();
}
```

Do not change table names, primary keys, JSONB payloads, or ordering columns.

**Verify**: `npm run typecheck` -> exit 0.

### Step 3: Use the helper in vector-memory initialization

In `apps/server/src/memory.ts`, wrap `CREATE EXTENSION IF NOT EXISTS vector` and `CREATE TABLE IF NOT EXISTS synapse_memory` in the same helper using lock id `727269784`.

Keep the current degraded behavior: initialization failure should set `available = false` and log `memory.degraded`, not crash the server.

**Verify**: `npm test --workspace @synapse/server` -> exit 0.

### Step 4: Run persistence and optional PG verification

Run the persistence verifiers. The Postgres and pgvector scripts are allowed to SKIP when their required environment variables or services are missing; do not fake those services.

**Verify**:

- `npm run verify:persistence` -> exit 0.
- `npm run verify:persistence-pg` -> exit 0 or documented SKIP.
- `npm run verify:why-rag` -> exit 0 or documented SKIP.

## Test plan

- Unit test the lock helper using a fake client.
- Existing SQLite persistence script proves the state-store path still works without Postgres.
- Existing Postgres scripts cover real database startup when environment variables are available.

## Done criteria

- [ ] A failed DDL callback cannot release a client before attempting advisory unlock.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test --workspace @synapse/server` exits 0.
- [ ] `npm run verify:persistence` exits 0.
- [ ] `npm run verify:persistence-pg` exits 0 or documented SKIP.
- [ ] `npm run verify:why-rag` exits 0 or documented SKIP.
- [ ] `plans/README.md` status row for Plan 002 is updated.

## STOP conditions

Stop and report if:

- The code has already moved to transaction-level advisory locks or a migration framework.
- Preserving the original DDL error and attempting unlock cannot both be done cleanly.
- The fix requires changing table schemas.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

If future migrations add more Postgres initialization paths, they should use the same helper or transaction-level locks. Reviewers should check that `client.release()` remains outside the lock helper so callers still own connection lifetime.

