import {
  createEmptyTeamState,
  createLogger,
  type ConflictFeedback,
  type ContractDelta,
  type ContractResolution,
  type EditLock,
  type RecentPush,
  type RecentRepoEvent,
  type Session,
  type SessionSummary,
  type TeamState
} from "@synapse/protocol";
import type { Pool } from "pg";
import { withPgAdvisoryLock } from "./pg-advisory-lock.js";
import { ENTITY_TABLES, type EntityTable, type StateStore } from "./store.js";

const log = createLogger("synapse-store-pg");

/**
 * Postgres-backed {@link StateStore} (plan M8, selected by
 * `SYNAPSE_DATABASE_URL`). Same logical per-entity schema as SQLite with a
 * `seq BIGSERIAL` order column standing in for SQLite's rowid.
 *
 * The driver is async while the mutation ops are fire-and-forget, so every op
 * is chained onto one internal promise queue: ops apply in exactly the order
 * they were issued (the order the in-memory mutations ran), `flush()` awaits
 * the tail, and a failed op logs and never breaks the chain — the in-memory
 * state stays authoritative and the next op still runs.
 */
export class PostgresStateStore implements StateStore {
  private pool!: Pool;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly databaseUrl: string) {}

  /** Connect and create tables. Must resolve before any other call. */
  async init(): Promise<void> {
    // Lazy import keeps `pg` out of the SQLite path entirely (see store.ts).
    const { default: pg } = await import("pg");
    this.pool = new pg.Pool({ connectionString: this.databaseUrl });
    // Serialize DDL across instances booting concurrently: CREATE TABLE IF NOT
    // EXISTS still races in Postgres (duplicate pg_class entries) when two
    // sessions both see "not exists". The advisory lock makes one instance
    // create while the others wait, then find the tables present.
    const client = await this.pool.connect();
    try {
      await withPgAdvisoryLock(
        client,
        727269783,
        async () => {
          for (const [table, spec] of Object.entries(ENTITY_TABLES)) {
            const keyColumns = spec.keys.map((key) => `${key} TEXT NOT NULL`).join(", ");
            await client.query(
              `CREATE TABLE IF NOT EXISTS synapse_${table} (
                 repo_id TEXT NOT NULL,
                 ${keyColumns},
                 payload JSONB NOT NULL,
                 seq BIGSERIAL,
                 PRIMARY KEY (repo_id, ${spec.keys.join(", ")})
               )`
            );
          }
        },
        log
      );
    } finally {
      client.release();
    }
  }

  upsertSession(repoId: string, session: Session): void {
    this.upsertRow("sessions", repoId, [session.id], session);
  }

  upsertEditLock(repoId: string, lock: EditLock): void {
    this.upsertRow("edit_locks", repoId, [lock.sessionId, lock.symbolId.raw], lock);
  }

  deleteEditLock(repoId: string, sessionId: string, symbolRaw: string): void {
    this.enqueue(
      "DELETE FROM synapse_edit_locks WHERE repo_id = $1 AND session_id = $2 AND symbol_raw = $3",
      [repoId, sessionId, symbolRaw]
    );
  }

  deleteEditLocksForSession(repoId: string, sessionId: string): void {
    this.enqueue("DELETE FROM synapse_edit_locks WHERE repo_id = $1 AND session_id = $2", [
      repoId,
      sessionId
    ]);
  }

  upsertDelta(repoId: string, delta: ContractDelta): void {
    this.upsertRow("deltas", repoId, [delta.id], delta);
  }

  deleteDelta(repoId: string, deltaId: string): void {
    this.enqueue("DELETE FROM synapse_deltas WHERE repo_id = $1 AND id = $2", [repoId, deltaId]);
  }

  deleteSession(repoId: string, sessionId: string): void {
    this.enqueue("DELETE FROM synapse_sessions WHERE repo_id = $1 AND id = $2", [repoId, sessionId]);
  }

  appendPush(repoId: string, push: RecentPush, cap: number): void {
    this.appendRow("pushes", repoId, [push.id], push, cap);
  }

  appendRepoEvent(repoId: string, event: RecentRepoEvent, cap: number): void {
    this.appendRow("repo_events", repoId, [event.id], event, cap);
  }

  upsertResolution(repoId: string, resolution: ContractResolution): void {
    this.upsertRow("resolutions", repoId, [resolution.symbol.raw], resolution);
  }

  deleteResolution(repoId: string, symbolRaw: string, inputsHash: string): void {
    // The hash guards against deleting a newer resolution that already
    // replaced the invalidated one under the same symbol key.
    this.enqueue(
      "DELETE FROM synapse_resolutions WHERE repo_id = $1 AND symbol_raw = $2 AND payload ->> 'inputsHash' = $3",
      [repoId, symbolRaw, inputsHash]
    );
  }

  appendSummary(repoId: string, summary: SessionSummary, cap: number): void {
    this.appendRow("summaries", repoId, [summary.sessionId], summary, cap);
  }

  appendFeedback(repoId: string, feedback: ConflictFeedback, cap: number): void {
    this.appendRow("feedback", repoId, [feedback.id], feedback, cap);
  }

  async load(repoId: string): Promise<TeamState | null> {
    await this.flush();
    const state = createEmptyTeamState(repoId);
    let any = false;

    for (const [table, spec] of Object.entries(ENTITY_TABLES)) {
      const result = await this.pool.query(
        `SELECT payload FROM synapse_${table} WHERE repo_id = $1 ORDER BY seq ${spec.newestFirst ? "DESC" : "ASC"}`,
        [repoId]
      );
      if (result.rows.length > 0) {
        any = true;
        (state as unknown as Record<string, unknown>)[spec.field] = result.rows.map(
          (row: { payload: unknown }) => row.payload
        );
      }
    }

    return any ? state : null;
  }

  async listRepoIds(): Promise<string[]> {
    await this.flush();
    const ids = new Set<string>();
    for (const table of Object.keys(ENTITY_TABLES)) {
      const result = await this.pool.query(`SELECT DISTINCT repo_id FROM synapse_${table}`);
      for (const row of result.rows as { repo_id: string }[]) {
        ids.add(row.repo_id);
      }
    }
    return [...ids];
  }

  flush(): Promise<void> {
    return this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }

  private upsertRow(table: EntityTable, repoId: string, keys: string[], payload: unknown): void {
    const spec = ENTITY_TABLES[table];
    const params = [repoId, ...keys, JSON.stringify(payload)];
    const placeholders = params.map((_, index) => `$${index + 1}`).join(", ");
    // ON CONFLICT UPDATE preserves seq, mirroring replace-in-place order.
    this.enqueue(
      `INSERT INTO synapse_${table} (repo_id, ${spec.keys.join(", ")}, payload)
       VALUES (${placeholders})
       ON CONFLICT (repo_id, ${spec.keys.join(", ")}) DO UPDATE SET payload = excluded.payload`,
      params
    );
  }

  private appendRow(
    table: EntityTable,
    repoId: string,
    keys: string[],
    payload: unknown,
    cap: number
  ): void {
    const spec = ENTITY_TABLES[table];
    const keyPredicate = spec.keys.map((key, index) => `${key} = $${index + 2}`).join(" AND ");
    // Delete + insert (not upsert) so a re-sent key takes a fresh seq and
    // moves to the front, exactly like the in-memory unshift-after-filter.
    this.enqueue(`DELETE FROM synapse_${table} WHERE repo_id = $1 AND ${keyPredicate}`, [
      repoId,
      ...keys
    ]);
    const insertParams = [repoId, ...keys, JSON.stringify(payload)];
    this.enqueue(
      `INSERT INTO synapse_${table} (repo_id, ${spec.keys.join(", ")}, payload)
       VALUES (${insertParams.map((_, index) => `$${index + 1}`).join(", ")})`,
      insertParams
    );
    this.enqueue(
      `DELETE FROM synapse_${table} WHERE repo_id = $1 AND seq NOT IN (
         SELECT seq FROM synapse_${table} WHERE repo_id = $1 ORDER BY seq DESC LIMIT $2
       )`,
      [repoId, cap]
    );
  }

  private enqueue(sql: string, params: unknown[]): void {
    this.queue = this.queue.then(async () => {
      try {
        await this.pool.query(sql, params);
      } catch (error) {
        // Never break the chain: in-memory state is authoritative; log and
        // keep applying subsequent ops.
        log.error("store.op_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }
}
