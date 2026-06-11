import type { Logger } from "@synapse/protocol";

export interface PgAdvisoryLockClient {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

export async function withPgAdvisoryLock<T>(
  client: PgAdvisoryLockClient,
  lockId: number,
  run: () => Promise<T>,
  logger?: Pick<Logger, "warn">
): Promise<T> {
  let runFailed = false;

  await client.query("SELECT pg_advisory_lock($1)", [lockId]);

  try {
    return await run();
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    } catch (error) {
      if (!runFailed) {
        throw error;
      }
      try {
        logger?.warn("pg_advisory_unlock_failed", {
          lockId,
          error: error instanceof Error ? error.message : String(error)
        });
      } catch {
        // Preserve the original DDL failure even if logging is unavailable.
      }
    }
  }
}
