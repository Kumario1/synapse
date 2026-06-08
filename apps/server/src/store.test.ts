import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Session,
  type TeamState
} from "@synapse/protocol";
import { applyMessage } from "./state.js";
import { createStateStore, SqliteStateStore } from "./store.js";

test("save then load round-trips a TeamState", () => {
  const store = createStateStore(":memory:");
  const state = stateWithSession("local", "alice");

  store.save("local", state);
  const loaded = store.load("local");

  assert.ok(loaded);
  assert.equal(loaded.repoId, "local");
  assert.equal(loaded.sessions.length, 1);
  assert.equal(loaded.sessions[0].id, "alice");
  store.close();
});

test("load returns null for an unknown repo", () => {
  const store = createStateStore(":memory:");
  assert.equal(store.load("never-seen"), null);
  store.close();
});

test("a file-backed store survives reopening (restart durability)", () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-store-"));
  const dbPath = join(dir, "state.db");

  try {
    const first = new SqliteStateStore(dbPath);
    first.save("repo-a", stateWithSession("repo-a", "alice"));
    first.save("repo-b", stateWithSession("repo-b", "bob"));
    first.close();

    // A fresh handle on the same file = a process restart.
    const second = new SqliteStateStore(dbPath);
    const reloaded = second.load("repo-a");
    assert.ok(reloaded);
    assert.equal(reloaded.sessions[0].id, "alice");
    assert.deepEqual(second.listRepoIds().sort(), ["repo-a", "repo-b"]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted state carries applied mutations", () => {
  const store = createStateStore(":memory:");
  const state = createEmptyTeamState("local");

  applyMessage(state, "local", sessionStart("alice"));
  store.save("local", state);

  const loaded = store.load("local");
  assert.ok(loaded);
  assert.equal(loaded.sessions[0].status, "active");
  store.close();
});

test("save is last-writer-wins for a repo", () => {
  const store = createStateStore(":memory:");
  store.save("local", stateWithSession("local", "first"));
  store.save("local", stateWithSession("local", "second"));

  const loaded = store.load("local");
  assert.ok(loaded);
  assert.equal(loaded.sessions.length, 1);
  assert.equal(loaded.sessions[0].id, "second");
  store.close();
});

function stateWithSession(repoId: string, sessionId: string): TeamState {
  const state = createEmptyTeamState(repoId);
  state.sessions.push(session(sessionId));
  return state;
}

function sessionStart(sessionId: string): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "session.start",
    id: "m1",
    ts: new Date().toISOString(),
    payload: { session: session(sessionId) }
  };
}

function session(sessionId: string): Session {
  return {
    id: sessionId,
    repoId: "local",
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
