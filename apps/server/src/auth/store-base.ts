import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Pool } from "pg";

/**
 * Shared backend plumbing for the identity stores ({@link createUserStore},
 * {@link createProjectStore}). The user store and the project store are the
 * same SQLite-or-Postgres pair differing only in their table and columns, so
 * the file-path/pragma setup, the lazy `pg` pool, and the env-based backend
 * selection live here once. The concrete stores keep only their SQL.
 *
 * Backend selection mirrors {@link createStateStore} in `store.ts`:
 * `SYNAPSE_DATABASE_URL` → Postgres; else `SYNAPSE_DB_PATH` → a durable SQLite
 * file; unset → in-memory SQLite, so tests stay hermetic.
 */

/**
 * Open the shared single-instance SQLite handle: ensure the parent directory
 * exists for a real file (`:memory:` needs none) and apply the WAL + busy
 * timeout pragmas that make a second same-file handle safe. The concrete store
 * then creates its own table on the returned handle.
 */
export function openSqliteDb(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * Build a Postgres pool, importing the `pg` driver lazily so installs without
 * it (the bundled CLI tarball) never pay for — or crash on — a backend they
 * don't use, exactly like {@link createStateStore}.
 */
export async function createPgPool(databaseUrl: string): Promise<Pool> {
  const { default: pg } = await import("pg");
  return new pg.Pool({ connectionString: databaseUrl });
}

/**
 * Resolve the configured backend and build the matching store. `databaseUrl`
 * (explicit or `SYNAPSE_DATABASE_URL`) selects Postgres; otherwise `path`
 * (explicit or `SYNAPSE_DB_PATH`, defaulting to `:memory:`) selects SQLite.
 */
export function selectBackend<T>(
  options: { databaseUrl?: string; path?: string },
  builders: {
    postgres: (databaseUrl: string) => Promise<T>;
    sqlite: (path: string) => T;
  }
): Promise<T> {
  const databaseUrl = options.databaseUrl ?? process.env.SYNAPSE_DATABASE_URL;
  if (databaseUrl) {
    return builders.postgres(databaseUrl);
  }
  const path = options.path ?? process.env.SYNAPSE_DB_PATH;
  return Promise.resolve(builders.sqlite(path && path.length > 0 ? path : ":memory:"));
}
