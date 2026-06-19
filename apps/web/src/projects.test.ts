import assert from "node:assert/strict";
import test from "node:test";
import { emptyRoomState, kickUrl, ownedRoomStateUrl, resolveWinnerUrl, toSnapshot } from "./projects";

test("ownedRoomStateUrl encodes the repoId in the query", () => {
  assert.equal(ownedRoomStateUrl("o/r"), "/auth/projects/state?repoId=o%2Fr");
});

test("kickUrl encodes the repoId and sessionId in the query", () => {
  assert.equal(
    kickUrl("o/r", "s 1"),
    "/auth/projects/kick?repoId=o%2Fr&sessionId=s%201"
  );
});

test("resolveWinnerUrl encodes the repoId, proposalId, and winner session", () => {
  assert.equal(
    resolveWinnerUrl("o/r", "rp:symbol:a:b", "alice session"),
    "/auth/projects/resolve-winner?repoId=o%2Fr&proposalId=rp%3Asymbol%3Aa%3Ab&winnerSessionId=alice%20session"
  );
});

test("toSnapshot wraps a TeamState in a live Owner-dashboard snapshot", () => {
  const state = emptyRoomState("o/r");
  assert.deepEqual(toSnapshot(state, 3), {
    mode: "live",
    status: "open",
    state,
    seq: 3,
    message: "Owner dashboard"
  });
});
