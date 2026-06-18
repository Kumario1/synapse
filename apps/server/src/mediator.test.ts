import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmptyTeamState, type ContractDelta, type TeamState } from "@synapse/protocol";
import {
  applyResolutionAck,
  applyResolutionReject,
  applyWinnerChoice,
  proposeOnContest,
  voidOnTimeout
} from "./mediator.js";

const symbol = { raw: "ts:src/auth/token.ts#getUser" };
const dependent = { raw: "ts:src/routes/me.ts#handleMe" };

function stateWithKeepDelta(): TeamState {
  const state = createEmptyTeamState("local");
  state.sessions = [session("alice"), session("bob"), session("mallory")];
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

function stateWithDivergentDeltas(): TeamState {
  const state = stateWithKeepDelta();
  state.unpushedDeltas = [
    state.unpushedDeltas[0],
    {
      id: "delta-2",
      repoId: "local",
      sessionId: "bob",
      symbolId: symbol,
      changeKind: "signature_changed",
      before: { params: [], returns: "User", raw: "() => User" },
      after: {
        params: [{ name: "strict", type: "boolean", optional: false }],
        returns: "User",
        raw: "(strict: boolean) => User"
      },
      summary: "getUser requires strict mode",
      filePath: "src/auth/token.ts",
      baseSha: "abc123",
      dependents: [],
      createdAt: "2026-06-17T00:01:00.000Z",
      pushedAt: null
    } satisfies ContractDelta
  ];
  return state;
}

test("proposeOnContest stores one mechanical keep/adapt proposal", () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob", () => "2026-06-17T01:00:00.000Z");

  assert.ok(proposal);
  assert.equal(state.resolutionProposals?.length, 1);
  assert.equal(proposal.conflictClass, "mechanical");
  assert.equal(proposal.status, "resolving");
  assert.equal(proposal.candidates, undefined);
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

test("proposeOnContest escalates divergent deltas to an owner decision", () => {
  const state = stateWithDivergentDeltas();
  const proposal = proposeOnContest(state, symbol.raw, "bob", () => "2026-06-17T01:00:00.000Z");

  assert.ok(proposal);
  assert.equal(proposal.conflictClass, "semantic");
  assert.equal(proposal.status, "awaiting_owner");
  assert.deepEqual(proposal.directions, []);
  assert.deepEqual(proposal.candidates, ["alice", "bob"]);
  assert.deepEqual(proposal.before, state.unpushedDeltas[0].before);
  assert.equal(proposal.after, null);
});

test("applyWinnerChoice moves a semantic proposal to resolving with keep/adapt roles", () => {
  const state = stateWithDivergentDeltas();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);
  const aliceDelta = state.unpushedDeltas[0];

  assert.equal(applyWinnerChoice(state, proposal.id, "alice"), true);
  assert.equal(proposal.status, "resolving");
  assert.equal(proposal.candidates, undefined);
  assert.strictEqual(proposal.after, aliceDelta.after);
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
  assert.equal(applyWinnerChoice(state, proposal.id, "alice"), false);
});

test("applyWinnerChoice ignores sessions that are not candidates", () => {
  const state = stateWithDivergentDeltas();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);

  assert.equal(applyWinnerChoice(state, proposal.id, "mallory"), false);
  assert.equal(proposal.status, "awaiting_owner");
  assert.deepEqual(proposal.directions, []);
  assert.deepEqual(proposal.candidates, ["alice", "bob"]);
  assert.equal(proposal.after, null);
});

test("applyResolutionAck does not resolve a semantic proposal before owner choice", () => {
  const state = stateWithDivergentDeltas();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);

  assert.equal(applyResolutionAck(state, proposal.id, "alice"), false);
  assert.deepEqual(proposal.acceptedBy, []);
  assert.equal(proposal.status, "awaiting_owner");
});

test("post-pick acks resolve through the existing resolving phase", () => {
  const state = stateWithDivergentDeltas();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);
  assert.equal(applyWinnerChoice(state, proposal.id, "alice"), true);

  assert.equal(applyResolutionAck(state, proposal.id, "alice"), true);
  assert.equal(proposal.status, "resolving");
  assert.equal(applyResolutionAck(state, proposal.id, "bob"), true);
  assert.equal(proposal.status, "resolved");
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

test("applyResolutionReject voids the pair and emits dismiss feedback", () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);

  assert.equal(applyResolutionAck(state, proposal.id, "alice"), true);
  assert.equal(proposal.status, "resolving");

  const result = applyResolutionReject(state, proposal.id, "bob");
  assert.equal(result.changed, true);
  assert.ok(result.feedback);
  assert.equal(result.feedback.outcome, "dismissed");
  assert.equal(result.feedback.conflictId, proposal.id);
  assert.equal(result.feedback.sessionId, "bob");
  assert.deepEqual(result.feedback.targetSymbol, symbol);
  assert.equal(proposal.status, "voided");
  assert.equal(proposal.voidReason, "rejected");
  assert.equal(proposal.voidedBy, "bob");
});

test("applyResolutionAck after a void is a no-op (never resolves)", () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);

  assert.equal(applyResolutionAck(state, proposal.id, "alice"), true);
  assert.equal(applyResolutionReject(state, proposal.id, "bob").changed, true);
  assert.equal(proposal.status, "voided");

  assert.equal(applyResolutionAck(state, proposal.id, "alice"), false);
  assert.equal(proposal.status, "voided");
});

test("voidOnTimeout voids a resolving proposal, then is idempotent", () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);

  assert.equal(voidOnTimeout(state, proposal.id), true);
  assert.equal(proposal.status, "voided");
  assert.equal(proposal.voidReason, "timeout");

  assert.equal(voidOnTimeout(state, proposal.id), false);
  assert.equal(proposal.status, "voided");
});

test("applyResolutionReject ignores non-party and unknown proposals", () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);

  assert.equal(applyResolutionReject(state, proposal.id, "mallory").changed, false);
  assert.equal(proposal.status, "resolving");
  assert.equal(proposal.voidReason, undefined);

  assert.equal(applyResolutionReject(state, "rp:nope:x:y", "bob").changed, false);
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
