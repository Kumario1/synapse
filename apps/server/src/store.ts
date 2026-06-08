import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { createEmptyTeamState, type TeamState } from "@synapse/protocol";

/**
 * Durable home for per-repo {@link TeamState}. The server keeps an in-memory
 * write-through cache for the hot path and persists through this interface so a
 * restart does not lose live sessions, unpushed deltas, recent pushes, or
 * resolutions.
 *
 * The interface is deliberately storage-agnostic — the SQLite implementation
 * below stores one JSON snapshot per repo, but a future Postgres/Redis
 * implementation (for multi-instance fan-out) can satisfy the same contract
 * without touching server logic.
 */
export interface StateStore {
  /** The persisted state for a repo, or `null` if none has been stored yet. */
  load(repoId: string): TeamState | null;
  /** Persist the full current state for a repo (last-writer-wins). */
  save(repoId: string, state: TeamState): void;
  /** Every repo id that has persisted state — used to hydrate on boot. */
  listRepoIds(): string[];
  /** Release the underlying handle. */
  close(): void;
}

/**
 * SQLite-backed {@link StateStore}. One row per repo holds the serialized
 * `TeamState`, so the well-tested pure mutation logic in `state.ts` is reused
 * verbatim and only its result is persisted. WAL mode keeps writes durable and
 * non-blocking for the concurrent read on `/state`.
 */
export class SqliteStateStore implements StateStore {
  private readonly db: Database.Database;
  private readonly selectOne: Database.Statement<[string]>;
  private readonly upsert: Database.Statement<[string, string, string]>;
  private readonly selectIds: Database.Statement<[]>;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS team_state (
         repo_id    TEXT PRIMARY KEY,
         state      TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`
    );

    this.selectOne = this.db.prepare("SELECT state FROM team_state WHERE repo_id = ?");
    this.upsert = this.db.prepare(
      `INSERT INTO team_state (repo_id, state, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
    );
    this.selectIds = this.db.prepare("SELECT repo_id FROM team_state");
  }

  load(repoId: string): TeamState | null {
    const row = this.selectOne.get(repoId) as { state: string } | undefined;
    if (!row) {
      return null;
    }

    try {
      return normalizeTeamState(JSON.parse(row.state), repoId);
    } catch {
      // A corrupt row should not crash the server; treat it as no state.
      return null;
    }
  }

  save(repoId: string, state: TeamState): void {
    this.upsert.run(repoId, JSON.stringify(state), new Date().toISOString());
  }

  listRepoIds(): string[] {
    return (this.selectIds.all() as { repo_id: string }[]).map((row) => row.repo_id);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Build the configured store. `SYNAPSE_DB_PATH` selects a durable file; unset
 * means an in-memory database, so tests and ephemeral runs stay hermetic with
 * the exact pre-persistence behavior.
 */
export function createStateStore(path: string | undefined = process.env.SYNAPSE_DB_PATH): StateStore {
  return new SqliteStateStore(path && path.length > 0 ? path : ":memory:");
}

/**
 * Defend against a snapshot written by an older shape: guarantee every
 * `TeamState` array exists so the server never reads `undefined` for a field a
 * future or past version omitted.
 */
function normalizeTeamState(value: unknown, repoId: string): TeamState {
  const base = createEmptyTeamState(repoId);
  if (!value || typeof value !== "object") {
    return base;
  }

  const partial = value as Partial<TeamState>;
  return {
    repoId,
    sessions: partial.sessions ?? base.sessions,
    editLocks: partial.editLocks ?? base.editLocks,
    unpushedDeltas: partial.unpushedDeltas ?? base.unpushedDeltas,
    recentPushes: partial.recentPushes ?? base.recentPushes,
    resolutions: partial.resolutions ?? base.resolutions
  };
}
