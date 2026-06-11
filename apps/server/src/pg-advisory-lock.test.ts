import assert from "node:assert/strict";
import test from "node:test";
import { withPgAdvisoryLock, type PgAdvisoryLockClient } from "./pg-advisory-lock.js";

test("withPgAdvisoryLock runs work between lock and unlock", async () => {
  const calls: string[] = [];
  const client = fakeClient(calls);

  const result = await withPgAdvisoryLock(client, 42, async () => {
    calls.push("work");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(calls, ["SELECT pg_advisory_lock($1):42", "work", "SELECT pg_advisory_unlock($1):42"]);
});

test("withPgAdvisoryLock unlocks and preserves the original work error", async () => {
  const calls: string[] = [];
  const client = fakeClient(calls);
  const original = new Error("ddl failed");

  await assert.rejects(
    withPgAdvisoryLock(client, 42, async () => {
      calls.push("work");
      throw original;
    }),
    original
  );

  assert.deepEqual(calls, ["SELECT pg_advisory_lock($1):42", "work", "SELECT pg_advisory_unlock($1):42"]);
});

test("withPgAdvisoryLock does not unlock when lock acquisition fails", async () => {
  const calls: string[] = [];
  const lockError = new Error("lock failed");
  const client = fakeClient(calls, { failLock: lockError });

  await assert.rejects(
    withPgAdvisoryLock(client, 42, async () => {
      calls.push("work");
    }),
    lockError
  );

  assert.deepEqual(calls, ["SELECT pg_advisory_lock($1):42"]);
});

test("withPgAdvisoryLock logs unlock failure without masking work failure", async () => {
  const calls: string[] = [];
  const warnings: unknown[] = [];
  const original = new Error("ddl failed");
  const unlockError = new Error("unlock failed");
  const client = fakeClient(calls, { failUnlock: unlockError });

  await assert.rejects(
    withPgAdvisoryLock(
      client,
      42,
      async () => {
        calls.push("work");
        throw original;
      },
      {
        warn: (event, fields) => warnings.push({ event, fields })
      }
    ),
    original
  );

  assert.deepEqual(calls, ["SELECT pg_advisory_lock($1):42", "work", "SELECT pg_advisory_unlock($1):42"]);
  assert.deepEqual(warnings, [
    {
      event: "pg_advisory_unlock_failed",
      fields: { lockId: 42, error: "unlock failed" }
    }
  ]);
});

function fakeClient(
  calls: string[],
  failures: { failLock?: Error; failUnlock?: Error } = {}
): PgAdvisoryLockClient {
  return {
    query: async (sql, params = []) => {
      calls.push(`${sql}:${params.join(",")}`);
      if (sql.includes("pg_advisory_lock") && failures.failLock) {
        throw failures.failLock;
      }
      if (sql.includes("pg_advisory_unlock") && failures.failUnlock) {
        throw failures.failUnlock;
      }
    }
  };
}
