import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  createEmptyTeamState,
  type ConflictFeedback,
  type ContractDelta,
  type ContractResolution,
  type EditLock,
  type Reservation,
  type RecentPush,
  type RecentRepoEvent,
  type Session,
  type SessionSummary,
  type StateOp,
  type TeamState
} from "@synapse/protocol";

/**
 * Durable home for per-repo {@link TeamState}, persisted **per entity** (plan
 * M8 / decision D2): every in-memory mutation in `state.ts` emits the matching
 * row operation here, so two server instances on a shared database no longer
 * clobber each other's snapshots and a write costs O(row), not O(state).
 *
 * In-memory `TeamState` remains the source of truth on the hot path;
 * `load(repoId)` rebuilds it from rows for boot hydration. Mutation ops are
 * synchronous fire-and-forget from the caller's perspective — the SQLite
 * backend applies them inline, the Postgres backend serializes them on an
 * internal queue (`flush()` awaits it). A crash can persist a partially
 * applied message; that is acceptable for advisory coordination state (TTLs
 * and caps self-heal) and is the same window a lost process always had.
 */
export interface StateStoreOps {
  upsertSession(repoId: string, session: Session): void;
  upsertEditLock(repoId: string, lock: EditLock): void;
  deleteEditLock(repoId: string, sessionId: string, symbolRaw: string): void;
  deleteEditLocksForSession(repoId: string, sessionId: string): void;
  upsertReservation(repoId: string, reservation: Reservation): void;
  deleteReservation(repoId: string, sessionId: string): void;
  upsertDelta(repoId: string, delta: ContractDelta): void;
  deleteDelta(repoId: string, deltaId: string): void;
  deleteSession(repoId: string, sessionId: string): void;
  appendPush(repoId: string, push: RecentPush, cap: number): void;
  appendRepoEvent(repoId: string, event: RecentRepoEvent, cap: number): void;
  /** Replaces any prior resolution for the symbol (at most one per symbol). */
  upsertResolution(repoId: string, resolution: ContractResolution): void;
  deleteResolution(repoId: string, symbolRaw: string, inputsHash: string): void;
  /** Replaces any prior summary for the session, trimmed to `cap` newest. */
  appendSummary(repoId: string, summary: SessionSummary, cap: number): void;
  /** Replaces any prior feedback with the same id, trimmed to `cap` newest. */
  appendFeedback(repoId: string, feedback: ConflictFeedback, cap: number): void;
}

export interface StateStore extends StateStoreOps {
  /** The persisted state for a repo rebuilt from rows, or `null` if none. */
  load(repoId: string): Promise<TeamState | null>;
  /** Every repo id with persisted rows — used to hydrate on boot. */
  listRepoIds(): Promise<string[]>;
  /** Resolves when every mutation op issued so far has been applied. */
  flush(): Promise<void>;
  /** Flush and release the underlying handle. */
  close(): Promise<void>;
}

/**
 * Persist one canonical {@link StateOp} by dispatching to the matching
 * per-entity {@link StateStoreOps} method. This is the single persistence entry
 * point (plan M8 / review #2): `state.ts` emits the ops that drive both the
 * `state.delta` broadcast and this store write, so the in-memory mutation lives
 * only in `applyStateOp` and the row mapping lives only here — no third hand-
 * mirrored copy. The per-entity SQL still lives in the store methods below.
 */
export function applyStateOpToStore(store: StateStoreOps, repoId: string, op: StateOp): void {
  switch (op.op) {
    case "upsertSession":
      store.upsertSession(repoId, op.session);
      return;
    case "deleteSession":
      store.deleteSession(repoId, op.sessionId);
      return;
    case "upsertEditLock":
      store.upsertEditLock(repoId, op.lock);
      return;
    case "deleteEditLock":
      store.deleteEditLock(repoId, op.sessionId, op.symbolRaw);
      return;
    case "deleteEditLocksForSession":
      store.deleteEditLocksForSession(repoId, op.sessionId);
      return;
    case "upsertReservation":
      store.upsertReservation(repoId, op.reservation);
      return;
    case "deleteReservation":
      store.deleteReservation(repoId, op.sessionId);
      return;
    case "upsertDelta":
      store.upsertDelta(repoId, op.delta);
      return;
    case "deleteDelta":
      store.deleteDelta(repoId, op.deltaId);
      return;
    case "appendPush":
      store.appendPush(repoId, op.push, op.cap);
      return;
    case "appendRepoEvent":
      store.appendRepoEvent(repoId, op.event, op.cap);
      return;
    case "upsertResolution":
      store.upsertResolution(repoId, op.resolution);
      return;
    case "deleteResolution":
      store.deleteResolution(repoId, op.symbolRaw, op.inputsHash);
      return;
    case "appendSummary":
      store.appendSummary(repoId, op.summary, op.cap);
      return;
    case "appendFeedback":
      store.appendFeedback(repoId, op.feedback, op.cap);
      return;
    default:
      assertNeverOp(op);
  }
}

function assertNeverOp(op: never): never {
  throw new Error(`Unhandled state op for store: ${JSON.stringify(op)}`);
}

/** Default for callers that mutate state without persistence (tests, CLI). */
export const noopStateStore: StateStoreOps = {
  upsertSession: () => {},
  upsertEditLock: () => {},
  deleteEditLock: () => {},
  deleteEditLocksForSession: () => {},
  upsertReservation: () => {},
  deleteReservation: () => {},
  upsertDelta: () => {},
  deleteDelta: () => {},
  deleteSession: () => {},
  appendPush: () => {},
  appendRepoEvent: () => {},
  upsertResolution: () => {},
  deleteResolution: () => {},
  appendSummary: () => {},
  appendFeedback: () => {}
};

/**
 * The shared logical schema, used verbatim by both backends. One row per
 * entity, JSON payload, and a monotonically increasing order column (`seq` —
 * SQLite's implicit rowid / a Postgres BIGSERIAL) so `load()` can rebuild the
 * arrays in their in-memory order: append-ordered for sessions, locks, deltas,
 * and resolutions; newest-first for pushes, repo events, summaries, feedback.
 * Upserts preserve `seq` (in-memory replace-in-place); the `append*` ops
 * delete + insert so a re-sent id moves to the front, exactly like the
 * in-memory `unshift` path.
 */
export const ENTITY_TABLES = {
  sessions: { keys: ["id"], newestFirst: false, field: "sessions" },
  edit_locks: { keys: ["session_id", "symbol_raw"], newestFirst: false, field: "editLocks" },
  reservations: { keys: ["session_id"], newestFirst: false, field: "reservations" },
  deltas: { keys: ["id"], newestFirst: false, field: "unpushedDeltas" },
  pushes: { keys: ["id"], newestFirst: true, field: "recentPushes" },
  repo_events: { keys: ["id"], newestFirst: true, field: "recentRepoEvents" },
  resolutions: { keys: ["symbol_raw"], newestFirst: false, field: "resolutions" },
  summaries: { keys: ["session_id"], newestFirst: true, field: "sessionSummaries" },
  feedback: { keys: ["id"], newestFirst: true, field: "conflictFeedback" }
} as const;

export type EntityTable = keyof typeof ENTITY_TABLES;

/**
 * SQLite-backed {@link StateStore} on per-entity tables. Synchronous under the
 * hood (better-sqlite3), so ops are applied before the call returns and
 * `flush()` is a no-op. Remains the default backend; `SYNAPSE_DATABASE_URL`
 * selects Postgres instead (see `store-pg.ts`).
 */
export class SqliteStateStore implements StateStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    for (const [table, spec] of Object.entries(ENTITY_TABLES)) {
      const keyColumns = spec.keys.map((key) => `${key} TEXT NOT NULL`).join(", ");
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (
           repo_id TEXT NOT NULL,
           ${keyColumns},
           payload TEXT NOT NULL,
           PRIMARY KEY (repo_id, ${spec.keys.join(", ")})
         )`
      );
    }

    this.migrateLegacySnapshots();
  }

  upsertSession(repoId: string, session: Session): void {
    this.upsertRow("sessions", repoId, [session.id], session);
  }

  upsertEditLock(repoId: string, lock: EditLock): void {
    this.upsertRow("edit_locks", repoId, [lock.sessionId, lock.symbolId.raw], lock);
  }

  deleteEditLock(repoId: string, sessionId: string, symbolRaw: string): void {
    this.db
      .prepare("DELETE FROM edit_locks WHERE repo_id = ? AND session_id = ? AND symbol_raw = ?")
      .run(repoId, sessionId, symbolRaw);
  }

  deleteEditLocksForSession(repoId: string, sessionId: string): void {
    this.db
      .prepare("DELETE FROM edit_locks WHERE repo_id = ? AND session_id = ?")
      .run(repoId, sessionId);
  }

  upsertReservation(repoId: string, reservation: Reservation): void {
    this.upsertRow("reservations", repoId, [reservation.sessionId], reservation);
  }

  deleteReservation(repoId: string, sessionId: string): void {
    this.db
      .prepare("DELETE FROM reservations WHERE repo_id = ? AND session_id = ?")
      .run(repoId, sessionId);
  }

  upsertDelta(repoId: string, delta: ContractDelta): void {
    this.upsertRow("deltas", repoId, [delta.id], delta);
  }

  deleteDelta(repoId: string, deltaId: string): void {
    this.db.prepare("DELETE FROM deltas WHERE repo_id = ? AND id = ?").run(repoId, deltaId);
  }

  deleteSession(repoId: string, sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE repo_id = ? AND id = ?").run(repoId, sessionId);
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
    this.db
      .prepare(
        "DELETE FROM resolutions WHERE repo_id = ? AND symbol_raw = ? AND payload ->> '$.inputsHash' = ?"
      )
      .run(repoId, symbolRaw, inputsHash);
  }

  appendSummary(repoId: string, summary: SessionSummary, cap: number): void {
    this.appendRow("summaries", repoId, [summary.sessionId], summary, cap);
  }

  appendFeedback(repoId: string, feedback: ConflictFeedback, cap: number): void {
    this.appendRow("feedback", repoId, [feedback.id], feedback, cap);
  }

  load(repoId: string): Promise<TeamState | null> {
    const state = createEmptyTeamState(repoId);
    let any = false;

    for (const [table, spec] of Object.entries(ENTITY_TABLES)) {
      const rows = this.db
        .prepare(
          `SELECT payload FROM ${table} WHERE repo_id = ? ORDER BY rowid ${spec.newestFirst ? "DESC" : "ASC"}`
        )
        .all(repoId) as { payload: string }[];
      const parsed = rows.flatMap((row) => {
        try {
          return [JSON.parse(row.payload)];
        } catch {
          return []; // a corrupt row should not crash the server
        }
      });
      if (parsed.length > 0) {
        any = true;
        (state as unknown as Record<string, unknown>)[spec.field] = parsed;
      }
    }

    return Promise.resolve(any ? state : null);
  }

  listRepoIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const table of Object.keys(ENTITY_TABLES)) {
      const rows = this.db.prepare(`SELECT DISTINCT repo_id FROM ${table}`).all() as {
        repo_id: string;
      }[];
      for (const row of rows) {
        ids.add(row.repo_id);
      }
    }
    return Promise.resolve([...ids]);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }

  private upsertRow(table: EntityTable, repoId: string, keys: string[], payload: unknown): void {
    const spec = ENTITY_TABLES[table];
    const placeholders = ["?", ...spec.keys.map(() => "?"), "?"].join(", ");
    // ON CONFLICT UPDATE preserves rowid, mirroring replace-in-place order.
    this.db
      .prepare(
        `INSERT INTO ${table} (repo_id, ${spec.keys.join(", ")}, payload)
         VALUES (${placeholders})
         ON CONFLICT(repo_id, ${spec.keys.join(", ")}) DO UPDATE SET payload = excluded.payload`
      )
      .run(repoId, ...keys, JSON.stringify(payload));
  }

  private appendRow(
    table: EntityTable,
    repoId: string,
    keys: string[],
    payload: unknown,
    cap: number
  ): void {
    const spec = ENTITY_TABLES[table];
    const keyPredicate = spec.keys.map((key) => `${key} = ?`).join(" AND ");
    // Delete + insert (not upsert) so a re-sent key takes a fresh rowid and
    // moves to the front, exactly like the in-memory unshift-after-filter.
    this.db
      .prepare(`DELETE FROM ${table} WHERE repo_id = ? AND ${keyPredicate}`)
      .run(repoId, ...keys);
    this.db
      .prepare(
        `INSERT INTO ${table} (repo_id, ${spec.keys.join(", ")}, payload)
         VALUES (?, ${spec.keys.map(() => "?").join(", ")}, ?)`
      )
      .run(repoId, ...keys, JSON.stringify(payload));
    this.db
      .prepare(
        `DELETE FROM ${table} WHERE repo_id = ? AND rowid NOT IN (
           SELECT rowid FROM ${table} WHERE repo_id = ? ORDER BY rowid DESC LIMIT ?
         )`
      )
      .run(repoId, repoId, cap);
  }

  /**
   * One-time upgrade from the pre-M8 layout (one JSON snapshot per repo in
   * `team_state`): explode every snapshot into per-entity rows, then drop the
   * legacy table so the migration never reruns. Self-hosts upgrading in place
   * keep their live sessions, deltas, pushes, and resolutions.
   */
  private migrateLegacySnapshots(): void {
    const legacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_state'")
      .get();
    if (!legacy) {
      return;
    }

    const rows = this.db.prepare("SELECT repo_id, state FROM team_state").all() as {
      repo_id: string;
      state: string;
    }[];

    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        let snapshot: Partial<TeamState>;
        try {
          snapshot = JSON.parse(row.state) as Partial<TeamState>;
        } catch {
          continue; // a corrupt legacy row is dropped, as load() always treated it
        }

        for (const session of snapshot.sessions ?? []) {
          this.upsertSession(row.repo_id, session);
        }
        for (const lock of snapshot.editLocks ?? []) {
          this.upsertEditLock(row.repo_id, lock);
        }
        for (const reservation of snapshot.reservations ?? []) {
          this.upsertReservation(row.repo_id, reservation);
        }
        for (const delta of snapshot.unpushedDeltas ?? []) {
          this.upsertDelta(row.repo_id, delta);
        }
        // Newest-first arrays insert oldest-first so seq order reproduces them.
        for (const push of [...(snapshot.recentPushes ?? [])].reverse()) {
          this.appendPush(row.repo_id, push, 50);
        }
        for (const event of [...(snapshot.recentRepoEvents ?? [])].reverse()) {
          this.appendRepoEvent(row.repo_id, event, 50);
        }
        for (const resolution of snapshot.resolutions ?? []) {
          this.upsertResolution(row.repo_id, resolution);
        }
        for (const summary of [...(snapshot.sessionSummaries ?? [])].reverse()) {
          this.appendSummary(row.repo_id, summary, 50);
        }
        for (const feedback of [...(snapshot.conflictFeedback ?? [])].reverse()) {
          this.appendFeedback(row.repo_id, feedback, 100);
        }
      }
      this.db.exec("DROP TABLE team_state");
    });
    migrate();
  }
}

/**
 * Build the configured store. `SYNAPSE_DATABASE_URL` selects Postgres (the
 * multi-instance backend, plan M8/M9); else `SYNAPSE_DB_PATH` selects a durable
 * SQLite file; unset means in-memory SQLite, so tests and ephemeral runs stay
 * hermetic. The `pg` driver is imported lazily so installs without it (the
 * bundled CLI tarball) never pay for — or crash on — a backend they don't use.
 */
export async function createStateStore(
  options: { databaseUrl?: string; path?: string } = {}
): Promise<StateStore> {
  const databaseUrl = options.databaseUrl ?? process.env.SYNAPSE_DATABASE_URL;
  if (databaseUrl) {
    const { PostgresStateStore } = await import("./store-pg.js");
    const store = new PostgresStateStore(databaseUrl);
    await store.init();
    return store;
  }

  const path = options.path ?? process.env.SYNAPSE_DB_PATH;
  return new SqliteStateStore(path && path.length > 0 ? path : ":memory:");
}
