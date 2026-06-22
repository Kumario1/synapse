import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyStateOp,
  createEmptyTeamState,
  symbolId,
  type EditLock,
  type RecentPush,
  type Session
} from "./index.js";

function session(id: string): Session {
  return {
    id,
    repoId: "r",
    memberId: id,
    memberLogin: id,
    agentType: "other",
    filesOpen: [],
    filesEditing: [],
    lastTask: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    status: "active"
  };
}

function lock(sessionId: string, symbol: string): EditLock {
  return {
    sessionId,
    symbolId: symbolId(symbol),
    filePath: `${symbol}.ts`,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    ttlSec: 60
  };
}

function push(id: string): RecentPush {
  return {
    id,
    repoId: "r",
    memberId: "m",
    summary: id,
    filesAffected: [],
    sha: id,
    pushedAt: "2026-01-01T00:00:00.000Z"
  };
}

test("upsertSession inserts a new session, then replaces it by id", () => {
  const s = createEmptyTeamState("r");
  applyStateOp(s, { op: "upsertSession", session: session("alice") });
  applyStateOp(s, { op: "upsertSession", session: session("bob") });
  assert.equal(s.sessions.length, 2);

  applyStateOp(s, {
    op: "upsertSession",
    session: { ...session("alice"), lastTask: "refactor auth" }
  });
  assert.equal(s.sessions.length, 2, "replaced by id, not appended");
  assert.equal(s.sessions.find((x) => x.id === "alice")?.lastTask, "refactor auth");
});

test("editLock ops key on (session, symbol); delete-for-session is bulk", () => {
  const s = createEmptyTeamState("r");
  applyStateOp(s, { op: "upsertEditLock", lock: lock("alice", "a") });
  applyStateOp(s, { op: "upsertEditLock", lock: lock("alice", "b") });
  applyStateOp(s, { op: "upsertEditLock", lock: lock("bob", "a") });
  assert.equal(s.editLocks.length, 3, "same session, different symbol = distinct locks");

  applyStateOp(s, { op: "upsertEditLock", lock: { ...lock("alice", "a"), ttlSec: 999 } });
  assert.equal(s.editLocks.length, 3, "upsert on an existing (session, symbol) replaces");
  assert.equal(
    s.editLocks.find((l) => l.sessionId === "alice" && l.symbolId.raw === "a")?.ttlSec,
    999
  );

  applyStateOp(s, { op: "deleteEditLock", sessionId: "alice", symbolRaw: "a" });
  assert.equal(s.editLocks.length, 2, "deleteEditLock removes only the exact match");
  assert.ok(
    s.editLocks.some((l) => l.sessionId === "bob" && l.symbolId.raw === "a"),
    "another session's lock on the same symbol survives"
  );

  applyStateOp(s, { op: "deleteEditLocksForSession", sessionId: "alice" });
  assert.deepEqual(
    s.editLocks.map((l) => l.sessionId),
    ["bob"]
  );
});

test("appendPush prepends newest-first, dedupes by id, and caps to the oldest-dropped", () => {
  const s = createEmptyTeamState("r");
  applyStateOp(s, { op: "appendPush", push: push("p1"), cap: 2 });
  applyStateOp(s, { op: "appendPush", push: push("p2"), cap: 2 });
  assert.deepEqual(
    s.recentPushes.map((p) => p.id),
    ["p2", "p1"],
    "newest first"
  );

  applyStateOp(s, { op: "appendPush", push: push("p1"), cap: 2 });
  assert.deepEqual(
    s.recentPushes.map((p) => p.id),
    ["p1", "p2"],
    "re-append dedupes and moves to front"
  );

  applyStateOp(s, { op: "appendPush", push: push("p3"), cap: 2 });
  assert.deepEqual(
    s.recentPushes.map((p) => p.id),
    ["p3", "p1"],
    "cap drops the oldest"
  );
});
