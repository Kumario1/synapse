import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediatorResolutionProvider } from "@synapse/conflict-engine";
import { createEmptyTeamState, type ContractDelta, type TeamState } from "@synapse/protocol";
import {
  applyResolutionAck,
  applyResolutionReject,
  applyWinnerChoice,
  enrichResolutionProse,
  proposeOnContest,
  type ResolutionEnrichIO,
  voidOnTimeout
} from "./mediator.js";
import {
  createOpenRouterMediatorProvider,
  parseMediatorResolutionProse
} from "./mediator-openrouter.js";

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
    proposal.directions,
    [
      {
        sessionId: "alice",
        role: "keep",
        summary: "Keep your change to ts:src/auth/token.ts#getUser.",
        affectedSites: []
      },
      {
        sessionId: "bob",
        role: "adapt",
        summary:
          "Update 1 call-site(s) to match ts:src/auth/token.ts#getUser's new signature.",
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

test("enrichResolutionProse with null provider does not mutate a mechanical proposal", async () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);
  const before = structuredClone(proposal);

  assert.equal(await enrichResolutionProse(proposal.id, null, directIO(state)), false);
  assert.deepEqual(proposal, before);
});

test("enrichResolutionProse changes only the adapt summary", async () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);
  const stableFields = proposalStateFields(proposal);
  const keepDirection = structuredClone(proposal.directions[0]);
  let called = false;
  const provider: MediatorResolutionProvider = {
    proposeResolution: async (request) => {
      called = true;
      assert.equal(request.proposalId, proposal.id);
      assert.equal(request.keep.sessionId, "alice");
      assert.equal(request.adapt.sessionId, "bob");
      return { adaptSummary: validAdaptSummary() };
    }
  };

  let appliedState: TeamState | null = null;
  const io: ResolutionEnrichIO = {
    withState: async (fn) => fn(state),
    onApplied: (applied) => {
      appliedState = applied;
    }
  };
  assert.equal(await enrichResolutionProse(proposal.id, provider, io), true);

  assert.equal(called, true);
  assert.equal(appliedState, state);
  assert.deepEqual(proposalStateFields(proposal), stableFields);
  assert.deepEqual(proposal.directions[0], keepDirection);
  assert.equal(proposal.directions[1]?.summary, validAdaptSummary());
});

test("enrichResolutionProse ignores semantic proposals before owner choice", async () => {
  const state = stateWithDivergentDeltas();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);
  let called = false;
  const provider: MediatorResolutionProvider = {
    proposeResolution: async () => {
      called = true;
      return { adaptSummary: validAdaptSummary() };
    }
  };

  assert.equal(await enrichResolutionProse(proposal.id, provider, directIO(state)), false);
  assert.equal(called, false);
  assert.equal(proposal.status, "awaiting_owner");
  assert.deepEqual(proposal.directions, []);
});

test("enrichResolutionProse can enrich a semantic proposal after owner choice", async () => {
  const state = stateWithDivergentDeltas();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);
  assert.equal(applyWinnerChoice(state, proposal.id, "alice"), true);

  assert.equal(
    await enrichResolutionProse(
      proposal.id,
      {
        proposeResolution: async (request) => {
          assert.equal(request.conflictClass, "semantic");
          assert.equal(request.keep.sessionId, "alice");
          assert.equal(request.adapt.sessionId, "bob");
          return { adaptSummary: validAdaptSummary() };
        }
      },
      directIO(state)
    ),
    true
  );

  assert.equal(proposal.status, "resolving");
  assert.equal(proposal.directions[1]?.summary, validAdaptSummary());
});

test("enrichResolutionProse swallows provider exceptions and preserves summaries", async () => {
  const state = stateWithKeepDelta();
  const proposal = proposeOnContest(state, symbol.raw, "bob");
  assert.ok(proposal);
  const before = structuredClone(proposal.directions);

  assert.equal(
    await enrichResolutionProse(
      proposal.id,
      {
        proposeResolution: async () => {
          throw new Error("provider failed");
        }
      },
      directIO(state)
    ),
    false
  );

  assert.deepEqual(proposal.directions, before);
});

test("parseMediatorResolutionProse accepts strict JSON with adaptSummary", () => {
  assert.deepEqual(parseMediatorResolutionProse('{"adaptSummary":"  Update the caller.  "}'), {
    adaptSummary: "Update the caller."
  });
});

test("parseMediatorResolutionProse rejects malformed or empty provider output", () => {
  assert.equal(parseMediatorResolutionProse(undefined), null);
  assert.equal(parseMediatorResolutionProse("not json"), null);
  assert.equal(parseMediatorResolutionProse('{"adaptSummary":""}'), null);
  assert.equal(parseMediatorResolutionProse('{"summary":"wrong field"}'), null);
});

test("createOpenRouterMediatorProvider is disabled without a key or with resolve disabled", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalResolve = process.env.SYNAPSE_LLM_RESOLVE;
  try {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYNAPSE_LLM_RESOLVE;
    assert.equal(createOpenRouterMediatorProvider(), null);

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.SYNAPSE_LLM_RESOLVE = "0";
    assert.equal(createOpenRouterMediatorProvider(), null);
  } finally {
    restoreEnv("OPENROUTER_API_KEY", originalKey);
    restoreEnv("SYNAPSE_LLM_RESOLVE", originalResolve);
  }
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

function validAdaptSummary(): string {
  return "Update ts:src/auth/token.ts#getUser callers in src/routes/me.ts to handle () => User | null.";
}

/** Runs build/apply directly against an in-memory state, mirroring the prod lock seam. */
function directIO(state: TeamState): ResolutionEnrichIO {
  return { withState: async (fn) => fn(state), onApplied: () => {} };
}

function proposalStateFields(proposal: NonNullable<TeamState["resolutionProposals"]>[number]): {
  conflictClass: typeof proposal.conflictClass;
  before: typeof proposal.before;
  after: typeof proposal.after;
  status: typeof proposal.status;
  acceptedBy: typeof proposal.acceptedBy;
  candidates: typeof proposal.candidates;
  voidReason: typeof proposal.voidReason;
  voidedBy: typeof proposal.voidedBy;
} {
  return {
    conflictClass: proposal.conflictClass,
    before: proposal.before,
    after: proposal.after,
    status: proposal.status,
    acceptedBy: proposal.acceptedBy,
    candidates: proposal.candidates,
    voidReason: proposal.voidReason,
    voidedBy: proposal.voidedBy
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
