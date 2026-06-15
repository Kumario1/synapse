import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createEmptyTeamState, type EditLock } from "@synapse/protocol";

// Importing the server module starts an HTTP listener as a side effect, so bind
// it to an ephemeral port and tear it down after the suite to keep the test
// runner from hanging on the open handle.
process.env.SYNAPSE_SERVER_PORT = "0";
const { peerLocksForIntent, stopServerForTests } = await import("./index.js");

after(() => {
  stopServerForTests();
});

const symbolRaw = "ts:src/widget.ts#area";
const now = Date.parse("2026-06-14T00:00:00.000Z");

function lock(overrides: Partial<EditLock> = {}): EditLock {
  return {
    sessionId: "alice",
    symbolId: { raw: symbolRaw },
    filePath: "src/widget.ts",
    acquiredAt: "2026-06-14T00:00:00.000Z",
    ttlSec: 90,
    ...overrides
  };
}

test("returns a peer's lock on the same symbol", () => {
  const state = createEmptyTeamState("local");
  state.editLocks = [lock()];
  const result = peerLocksForIntent(state, "bob", symbolRaw, now + 1000);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, "alice");
});

test("excludes the requesting session's own lock", () => {
  const state = createEmptyTeamState("local");
  state.editLocks = [lock({ sessionId: "bob" })];
  const result = peerLocksForIntent(state, "bob", symbolRaw, now + 1000);
  assert.deepEqual(result, []);
});

test("excludes an expired lock", () => {
  const state = createEmptyTeamState("local");
  state.editLocks = [lock({ ttlSec: 90 })];
  // 91s after acquisition: past the 90s lease.
  const result = peerLocksForIntent(state, "bob", symbolRaw, now + 91_000);
  assert.deepEqual(result, []);
});

test("excludes a lock on a different symbol", () => {
  const state = createEmptyTeamState("local");
  state.editLocks = [lock({ symbolId: { raw: "ts:src/widget.ts#perimeter" } })];
  const result = peerLocksForIntent(state, "bob", symbolRaw, now + 1000);
  assert.deepEqual(result, []);
});
