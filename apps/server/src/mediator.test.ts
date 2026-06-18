import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmptyTeamState, type ContractDelta, type TeamState } from "@synapse/protocol";
import { applyResolutionAck, proposeOnContest } from "./mediator.js";

const symbol = { raw: "ts:src/auth/token.ts#getUser" };
const dependent = { raw: "ts:src/routes/me.ts#handleMe" };

function stateWithKeepDelta(): TeamState {
  const state = createEmptyTeamState("local");
  state.sessions = [
    session("alice"),
    session("bob"),
    session("mallory")
  ];
  state.unpushedDeltas = [
    {
      id: "delta-1",
      repoId: "local",
      sessionId: "alice",
      symbolId: symbol,
      changeKind: "signature_changed",
      before: { params: [], returns: "User", raw: "() => User" },
      after: { params: [], returns: "User | null", raw: "() => User | null" },
      summary: "getUser can return null",
      filePath: "src/auth/token.ts",
      baseSha: "abc123",
      dependents: [dependent],
      createdAt: "2026-06-17T00:00:00.000Z",
      pushedAt: null
    } satisfies ContractDelta
  ];
  return state;
}

test("proposeOnContest stores one mechanical keep/adapt proposal", () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(
    state,
    symbol.raw,
    "bob",
    () => "2026-06-17T01:00:00.000Z"
  );

  assert.ok(proposal);
  assert.equal(state.resolutionProposals?.length, 1);
  assert.equal(proposal.status, "resolving");
  assert.equal(proposal.repoId, "local");
  assert.equal(proposal.symbol.raw, symbol.raw);
  assert.deepEqual(proposal.before, state.unpushedDeltas[0].before);
  assert.deepEqual(proposal.after, state.unpushedDeltas[0].after);
  assert.deepEqual(
    proposal.directions.map((direction) => ({
      sessionId: direction.sessionId,
      role: direction.role,
      affectedSites: direction.affectedSites
    })),
    [
      { sessionId: "alice", role: "keep", affectedSites: [] },
      {
        sessionId: "bob",
        role: "adapt",
        affectedSites: [{ symbolId: dependent, filePath: "src/routes/me.ts" }]
      }
    ]
  );
});

test("proposeOnContest is idempotent for the same pair", () => {
  const state = stateWithKeepDelta();
  assert.ok(proposeOnContest(state, symbol.raw, "bob"));

  assert.equal(proposeOnContest(state, symbol.raw, "bob"), null);
  assert.equal(state.resolutionProposals?.length, 1);
});

test("applyResolutionAck resolves only after both proposal parties accept", () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);

  assert.equal(applyResolutionAck(state, proposal.id, "alice"), true);
  assert.deepEqual(proposal.acceptedBy, ["alice"]);
  assert.equal(proposal.status, "resolving");

  assert.equal(applyResolutionAck(state, proposal.id, "bob"), true);
  assert.deepEqual(proposal.acceptedBy, ["alice", "bob"]);
  assert.equal(proposal.status, "resolved");
});

test("applyResolutionAck ignores non-party acks", () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);

  assert.equal(applyResolutionAck(state, proposal.id, "mallory"), false);
  assert.deepEqual(proposal.acceptedBy, []);
  assert.equal(proposal.status, "resolving");
});

function session(id: string): TeamState["sessions"][number] {
  return {
    id,
    repoId: "local",
    memberId: id,
    memberLogin: id,
    agentType: "other",
    filesOpen: [],
    filesEditing: [],
    lastTask: null,
    startedAt: "2026-06-17T00:00:00.000Z",
    lastSeen: "2026-06-17T00:00:00.000Z",
    status: "active"
  };
}
