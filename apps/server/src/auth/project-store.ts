import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Pool } from "pg";

/**
 * Ownership of a claimed repo (issue #104): an Owner (the GitHub sign-in
 * identity) claims a repo by installing the GitHub App, and the setup callback
 * records the (ownerId, repoId) pair plus the per-repo project-key minted via
 * `deriveProjectKey(masterSecret, repoId)`. The project-key IS the daemon
 * credential for that repo; it is returned only to the authenticated Owner who
 * claimed it. The user access token used during install is never persisted.
 */
export interface Project {
  ownerId: string;
  repoId: string;
  projectKey: string;
}

export interface ProjectStore {
  /**
   * Idempotent on `(ownerId, repoId)`: the key is minted ONCE. A repeat claim
   * keeps the existing row and returns the stored project (so the key never
   * changes out from under a running daemon).
   */
  claimProject(ownerId: string, repoId: string, projectKey: string): Promise<Project>;
  listProjectsForOwner(ownerId: string): Promise<Project[]>;
  getProject(ownerId: string, repoId: string): Promise<Project | null>;
  close(): Promise<void>;
}

interface ProjectRow {
  owner_id: string;
  repo_id: string;
  project_key: string;
}

function rowToProject(row: ProjectRow): Project {
  return { ownerId: row.owner_id, repoId: row.repo_id, projectKey: row.project_key };
}

/**
 * SQLite-backed {@link ProjectStore}, mirroring {@link SqliteUserStore}: a
 * `:memory:` default keeps tests hermetic; a same-file second handle is safe
 * single-instance with WAL.
 * ponytail: same-file second handle, fine single-instance; shared PG is the
 * multi-instance upgrade.
 */
class SqliteProjectStore implements ProjectStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS projects (
         owner_id TEXT NOT NULL,
         repo_id TEXT NOT NULL,
         project_key TEXT NOT NULL,
         PRIMARY KEY (owner_id, repo_id)
       )`
    );
  }

  claimProject(ownerId: string, repoId: string, projectKey: string): Promise<Project> {
    this.db
      .prepare(
        `INSERT INTO projects (owner_id, repo_id, project_key)
         VALUES (?, ?, ?)
         ON CONFLICT(owner_id, repo_id) DO NOTHING`
      )
      .run(ownerId, repoId, projectKey);
    const row = this.db
      .prepare(
        "SELECT owner_id, repo_id, project_key FROM projects WHERE owner_id = ? AND repo_id = ?"
      )
      .get(ownerId, repoId) as ProjectRow;
    return Promise.resolve(rowToProject(row));
  }

  listProjectsForOwner(ownerId: string): Promise<Project[]> {
    const rows = this.db
      .prepare(
        "SELECT owner_id, repo_id, project_key FROM projects WHERE owner_id = ? ORDER BY repo_id"
      )
      .all(ownerId) as ProjectRow[];
    return Promise.resolve(rows.map(rowToProject));
  }

  getProject(ownerId: string, repoId: string): Promise<Project | null> {
    const row = this.db
      .prepare(
        "SELECT owner_id, repo_id, project_key FROM projects WHERE owner_id = ? AND repo_id = ?"
      )
      .get(ownerId, repoId) as ProjectRow | undefined;
    return Promise.resolve(row ? rowToProject(row) : null);
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

/**
 * Postgres-backed {@link ProjectStore} for the multi-instance posture, lazily
 * importing `pg` exactly like {@link PostgresUserStore}.
 */
class PostgresProjectStore implements ProjectStore {
  private pool: Pool | null = null;

  constructor(private readonly databaseUrl: string) {}

  async init(): Promise<void> {
    const { default: pg } = await import("pg");
    this.pool = new pg.Pool({ connectionString: this.databaseUrl });
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS projects (
         owner_id TEXT NOT NULL,
         repo_id TEXT NOT NULL,
         project_key TEXT NOT NULL,
         PRIMARY KEY (owner_id, repo_id)
       )`
    );
  }

  async claimProject(ownerId: string, repoId: string, projectKey: string): Promise<Project> {
    await this.pool!.query(
      `INSERT INTO projects (owner_id, repo_id, project_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, repo_id) DO NOTHING`,
      [ownerId, repoId, projectKey]
    );
    const result = await this.pool!.query<ProjectRow>(
      "SELECT owner_id, repo_id, project_key FROM projects WHERE owner_id = $1 AND repo_id = $2",
      [ownerId, repoId]
    );
    return rowToProject(result.rows[0]!);
  }

  async listProjectsForOwner(ownerId: string): Promise<Project[]> {
    const result = await this.pool!.query<ProjectRow>(
      "SELECT owner_id, repo_id, project_key FROM projects WHERE owner_id = $1 ORDER BY repo_id",
      [ownerId]
    );
    return result.rows.map(rowToProject);
  }

  async getProject(ownerId: string, repoId: string): Promise<Project | null> {
    const result = await this.pool!.query<ProjectRow>(
      "SELECT owner_id, repo_id, project_key FROM projects WHERE owner_id = $1 AND repo_id = $2",
      [ownerId, repoId]
    );
    const row = result.rows[0];
    return row ? rowToProject(row) : null;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

/**
 * Build the configured project store. Mirrors {@link createUserStore}'s backend
 * selection: `SYNAPSE_DATABASE_URL` → Postgres; else `SYNAPSE_DB_PATH` → a
 * durable SQLite file; unset → in-memory SQLite, so tests stay hermetic.
 */
export async function createProjectStore(
  options: { databaseUrl?: string; path?: string } = {}
): Promise<ProjectStore> {
  const databaseUrl = options.databaseUrl ?? process.env.SYNAPSE_DATABASE_URL;
  if (databaseUrl) {
    const store = new PostgresProjectStore(databaseUrl);
    await store.init();
    return store;
  }

  const path = options.path ?? process.env.SYNAPSE_DB_PATH;
  return new SqliteProjectStore(path && path.length > 0 ? path : ":memory:");
}
