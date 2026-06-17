import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Pool } from "pg";

/**
 * The human Owner identity established by the GitHub sign-in flow (plan 051).
 * This is the FIRST human trust boundary on the product and is strictly
 * distinct from the daemon<->server machine credential: an OwnerUser never
 * authorizes a WS room or `/state`. The store holds identity only — repo
 * claiming and the user access token are issues #104+ and are NOT persisted
 * here.
 */
export interface OwnerUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface UserStore {
  /** Idempotent on `id`: re-login refreshes login/name/avatar, never duplicates. */
  upsertUser(user: OwnerUser): Promise<OwnerUser>;
  getUserById(id: string): Promise<OwnerUser | null>;
  close(): Promise<void>;
}

interface UserRow {
  id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

function rowToUser(row: UserRow): OwnerUser {
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}

/**
 * SQLite-backed {@link UserStore}, mirroring {@link SqliteStateStore}'s path
 * logic (`:memory:` when no path). Opens its own handle to the same file as the
 * TeamState store; WAL makes a second single-instance handle safe.
 * ponytail: same-file second handle, fine single-instance; shared PG is the
 * multi-instance upgrade.
 */
class SqliteUserStore implements UserStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS users (
         id TEXT PRIMARY KEY,
         login TEXT NOT NULL,
         name TEXT,
         avatar_url TEXT
       )`
    );
  }

  upsertUser(user: OwnerUser): Promise<OwnerUser> {
    this.db
      .prepare(
        `INSERT INTO users (id, login, name, avatar_url)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           login = excluded.login,
           name = excluded.name,
           avatar_url = excluded.avatar_url`
      )
      .run(user.id, user.login, user.name, user.avatarUrl);
    return Promise.resolve(user);
  }

  getUserById(id: string): Promise<OwnerUser | null> {
    const row = this.db
      .prepare("SELECT id, login, name, avatar_url FROM users WHERE id = ?")
      .get(id) as UserRow | undefined;
    return Promise.resolve(row ? rowToUser(row) : null);
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

/**
 * Postgres-backed {@link UserStore} for the multi-instance posture. The `pg`
 * driver is imported lazily so installs without it never pay for a backend they
 * don't use, exactly like {@link createStateStore}.
 */
class PostgresUserStore implements UserStore {
  private pool: Pool | null = null;

  constructor(private readonly databaseUrl: string) {}

  async init(): Promise<void> {
    const { default: pg } = await import("pg");
    this.pool = new pg.Pool({ connectionString: this.databaseUrl });
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS users (
         id TEXT PRIMARY KEY,
         login TEXT NOT NULL,
         name TEXT,
         avatar_url TEXT
       )`
    );
  }

  async upsertUser(user: OwnerUser): Promise<OwnerUser> {
    await this.pool!.query(
      `INSERT INTO users (id, login, name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         login = excluded.login,
         name = excluded.name,
         avatar_url = excluded.avatar_url`,
      [user.id, user.login, user.name, user.avatarUrl]
    );
    return user;
  }

  async getUserById(id: string): Promise<OwnerUser | null> {
    const result = await this.pool!.query<UserRow>(
      "SELECT id, login, name, avatar_url FROM users WHERE id = $1",
      [id]
    );
    const row = result.rows[0];
    return row ? rowToUser(row) : null;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

/**
 * Build the configured user store. Mirrors {@link createStateStore}'s backend
 * selection: `SYNAPSE_DATABASE_URL` → Postgres; else `SYNAPSE_DB_PATH` → a
 * durable SQLite file; unset → in-memory SQLite, so tests stay hermetic.
 */
export async function createUserStore(
  options: { databaseUrl?: string; path?: string } = {}
): Promise<UserStore> {
  const databaseUrl = options.databaseUrl ?? process.env.SYNAPSE_DATABASE_URL;
  if (databaseUrl) {
    const store = new PostgresUserStore(databaseUrl);
    await store.init();
    return store;
  }

  const path = options.path ?? process.env.SYNAPSE_DB_PATH;
  return new SqliteUserStore(path && path.length > 0 ? path : ":memory:");
}
