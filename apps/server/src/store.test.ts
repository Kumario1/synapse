import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Session,
  type TeamState,
  type WireEnvelope
} from "@synapse/protocol";
import { applyMessage } from "./state.js";
import {
  applyStateOpToStore,
  createStateStore,
  SqliteStateStore,
  type StateStore
} from "./store.js";

/**
 * Apply a message in-memory and persist the emitted ops to the store, the way
 * the server wires `applyMessage` -> `applyStateOpToStore`. Returns the mutated
 * state so the suite can compare it against a fresh `load()`.
 */
function applyAndPersist(
  state: TeamState,
  repoId: string,
  msg: ClientMessage,
  store: StateStore
): void {
  for (const op of applyMessage(state, repoId, msg)) {
    applyStateOpToStore(store, repoId, op);
  }
}

/**
 * Both backends run the same suite (plan M8): SQLite always; Postgres when a
 * database URL is provided (CI service), skipped offline. Each test uses a
 * unique repo id so a shared Postgres database never cross-contaminates runs.
 */
const pgUrl = process.env.SYNAPSE_VERIFY_PG_URL ?? process.env.SYNAPSE_DATABASE_URL;

interface BackendHandle {
  store: StateStore;
  /** A fresh handle on the same underlying database = a process restart. */
  reopen(): Promise<StateStore>;
  cleanup(): Promise<void>;
}

interface Backend {
  name: string;
  open(): Promise<BackendHandle>;
}

const backends: Backend[] = [
  {
    name: "sqlite",
    open: async () => {
      const dir = mkdtempSync(join(tmpdir(), "synapse-store-"));
      const dbPath = join(dir, "state.db");
      const store = new SqliteStateStore(dbPath);
      return {
        store,
        reopen: async () => new SqliteStateStore(dbPath),
        cleanup: async () => rmSync(dir, { recursive: true, force: true })
      };
    }
  }
];

if (pgUrl) {
  backends.push({
    name: "postgres",
    open: async () => {
      const store = await createStateStore({ databaseUrl: pgUrl });
      return {
        store,
        reopen: () => createStateStore({ databaseUrl: pgUrl }),
        cleanup: async () => {}
      };
    }
  });
}

for (const backend of backends) {
  test(`[${backend.name}] per-entity ops round-trip through load`, async () => {
    const repoId = `repo-${randomUUID()}`;
    const handle = await backend.open();
    const state = createEmptyTeamState(repoId);

    // A realistic sequence: session joins, takes a lock, reports a delta,
    // a push lands (clearing live state), a summary and feedback arrive.
    applyAndPersist(state, repoId, sessionStart(repoId, "alice"), handle.store);
    applyAndPersist(
      state,
      repoId,
      editIntent(repoId, "alice", "ts:src/a.ts#f", "src/a.ts"),
      handle.store
    );
    applyAndPersist(
      state,
      repoId,
      contractDelta(repoId, "alice", "d1", "ts:src/a.ts#f", "src/a.ts"),
      handle.store
    );
    applyAndPersist(state, repoId, pushNotify(repoId, "bob", ["src/other.ts"]), handle.store);
    applyAndPersist(state, repoId, summaryMessage(repoId, "alice"), handle.store);
    applyAndPersist(state, repoId, feedbackMessage(repoId, "f1"), handle.store);

    await handle.store.flush();
    const loaded = await handle.store.load(repoId);

    assert.ok(loaded);
    assert.deepEqual(loaded, state, "load() rebuilds exactly the in-memory state");
    await handle.store.close();
    await handle.cleanup();
  });

  test(`[${backend.name}] load returns null for an unknown repo`, async () => {
    const handle = await backend.open();
    assert.equal(await handle.store.load(`never-seen-${randomUUID()}`), null);
    await handle.store.close();
    await handle.cleanup();
  });

  test(`[${backend.name}] state survives reopening (restart durability)`, async () => {
    const repoA = `repo-${randomUUID()}`;
    const repoB = `repo-${randomUUID()}`;
    const handle = await backend.open();

    const stateA = createEmptyTeamState(repoA);
    applyAndPersist(stateA, repoA, sessionStart(repoA, "alice"), handle.store);
    const stateB = createEmptyTeamState(repoB);
    applyAndPersist(stateB, repoB, sessionStart(repoB, "bob"), handle.store);
    await handle.store.close();

    const second = await handle.reopen();
    const reloaded = await second.load(repoA);
    assert.ok(reloaded);
    assert.equal(reloaded.sessions[0].id, "alice");
    const ids = await second.listRepoIds();
    assert.ok(ids.includes(repoA) && ids.includes(repoB), "both repos listed for hydration");
    await second.close();
    await handle.cleanup();
  });

  test(`[${backend.name}] append ops cap and replace like the in-memory arrays`, async () => {
    const repoId = `repo-${randomUUID()}`;
    const handle = await backend.open();
    const state = createEmptyTeamState(repoId);

    // 60 pushes: memory and store both keep the 50 newest, newest first.
    for (let i = 0; i < 60; i += 1) {
      applyAndPersist(state, repoId, pushNotify(repoId, `m${i}`, [`f${i}.ts`]), handle.store);
    }
    // Re-sent feedback id replaces the prior entry and moves to the front.
    applyAndPersist(state, repoId, feedbackMessage(repoId, "f-retry", "acted"), handle.store);
    applyAndPersist(state, repoId, feedbackMessage(repoId, "f-other", "acted"), handle.store);
    applyAndPersist(state, repoId, feedbackMessage(repoId, "f-retry", "dismissed"), handle.store);

    await handle.store.flush();
    const loaded = await handle.store.load(repoId);

    assert.ok(loaded);
    assert.equal(loaded.recentPushes.length, 50);
    assert.deepEqual(loaded.recentPushes, state.recentPushes, "cap kept the same 50, same order");
    assert.deepEqual(
      loaded.conflictFeedback,
      state.conflictFeedback,
      "retry replaced and moved front"
    );
    await handle.store.close();
    await handle.cleanup();
  });

  test(`[${backend.name}] cleared deltas and expired resolutions are deleted`, async () => {
    const repoId = `repo-${randomUUID()}`;
    const handle = await backend.open();
    const state = createEmptyTeamState(repoId);

    applyAndPersist(state, repoId, sessionStart(repoId, "alice"), handle.store);
    applyAndPersist(
      state,
      repoId,
      contractDelta(repoId, "alice", "d1", "ts:src/a.ts#f", "src/a.ts"),
      handle.store
    );
    // The push touches the delta's file → memory clears it; store must too.
    applyAndPersist(state, repoId, pushNotify(repoId, "alice", ["src/a.ts"]), handle.store);

    await handle.store.flush();
    const loaded = await handle.store.load(repoId);
    assert.ok(loaded);
    assert.equal(loaded.unpushedDeltas.length, 0, "pushed delta removed from the store");
    assert.equal(loaded.reservations.length, 0, "pushed reservation removed from the store");
    assert.deepEqual(loaded, state);
    await handle.store.close();
    await handle.cleanup();
  });
}

test("a legacy snapshot database migrates to per-entity rows once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-store-migrate-"));
  const dbPath = join(dir, "state.db");

  try {
    // Write the pre-M8 layout directly: one JSON snapshot per repo.
    const legacy = new Database(dbPath);
    legacy.exec(
      "CREATE TABLE team_state (repo_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    const snapshot = createEmptyTeamState("legacy-repo");
    snapshot.sessions.push(session("legacy-repo", "alice"));
    snapshot.recentPushes.unshift({
      id: "p1",
      repoId: "legacy-repo",
      memberId: "alice",
      summary: "old push",
      filesAffected: ["a.ts"],
      sha: "abc",
      pushedAt: new Date().toISOString()
    });
    legacy
      .prepare("INSERT INTO team_state (repo_id, state, updated_at) VALUES (?, ?, ?)")
      .run("legacy-repo", JSON.stringify(snapshot), new Date().toISOString());
    legacy.close();

    const store = new SqliteStateStore(dbPath);
    const loaded = await store.load("legacy-repo");
    assert.ok(loaded, "legacy snapshot still loads after the upgrade");
    assert.equal(loaded.sessions[0].id, "alice");
    assert.equal(loaded.recentPushes[0].sha, "abc");
    await store.close();

    const reopened = new Database(dbPath);
    const table = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_state'")
      .get();
    reopened.close();
    assert.equal(table, undefined, "legacy table dropped so the migration never reruns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sessionStart(repoId: string, sessionId: string): ClientMessage {
  return message("session.start", { session: session(repoId, sessionId) });
}

function editIntent(
  repoId: string,
  sessionId: string,
  symbolRaw: string,
  filePath: string
): ClientMessage {
  return message("edit.intent", {
    repoId,
    sessionId,
    symbolId: { raw: symbolRaw },
    filePath
  });
}

function contractDelta(
  repoId: string,
  sessionId: string,
  id: string,
  symbolRaw: string,
  filePath: string
): ClientMessage {
  return message("contract.delta", {
    delta: {
      id,
      repoId,
      sessionId,
      symbolId: { raw: symbolRaw },
      changeKind: "signature_changed",
      before: null,
      after: null,
      summary: `${symbolRaw} changed`,
      filePath,
      baseSha: "base",
      dependents: [],
      createdAt: new Date().toISOString(),
      pushedAt: null
    }
  });
}

function pushNotify(repoId: string, memberId: string, files: string[]): ClientMessage {
  return message("push.notify", {
    repoId,
    memberId,
    sha: `sha-${memberId}-${files[0]}`,
    summary: `pushed ${files.join(", ")}`,
    files
  });
}

function summaryMessage(repoId: string, sessionId: string): ClientMessage {
  return message("session.summary", {
    repoId,
    summary: {
      sessionId,
      repoId,
      memberLogin: sessionId,
      task: null,
      summary: `${sessionId}'s session`,
      symbols: [],
      deltaCount: 0,
      source: "deterministic",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    }
  });
}

function feedbackMessage(
  repoId: string,
  id: string,
  outcome: "acted" | "dismissed" = "acted"
): ClientMessage {
  return message("conflict.feedback", {
    repoId,
    feedback: {
      id,
      repoId,
      conflictId: "c1",
      sessionId: "alice",
      memberId: "alice",
      outcome,
      createdAt: new Date().toISOString()
    }
  });
}

function message<TType extends ClientMessage["type"]>(
  type: TType,
  payload: Extract<ClientMessage, WireEnvelope<TType>>["payload"]
): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    payload
  } as ClientMessage;
}

function session(repoId: string, sessionId: string): Session {
  return {
    id: sessionId,
    repoId,
    memberId: sessionId,
    agentType: "claude-code",
    filesOpen: [],
    filesEditing: [],
    lastTask: null,
    startedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    status: "active"
  };
}
