import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ContractDelta,
  type ContractResolution,
  type Signature,
  type TeamState
} from "@synapse/protocol";
import { resolutionInputsHash, resolutionSidesForSymbol } from "@synapse/conflict-engine";
import { applyMessage } from "./state.js";

const symbol = "ts:src/auth/token.ts#validate";

test("resolution.propose is first-writer-wins per (symbol, inputsHash)", () => {
  const state = createEmptyTeamState("local");

  applyMessage(state, "local", proposeMessage(resolution("h1", "first")));
  applyMessage(state, "local", proposeMessage(resolution("h1", "second")));

  assert.equal(state.resolutions.length, 1);
  assert.equal(state.resolutions[0].rationale, "first");
});

test("a new propose with a different hash replaces the stale resolution", () => {
  const state = createEmptyTeamState("local");

  applyMessage(state, "local", proposeMessage(resolution("h1", "stale")));
  applyMessage(state, "local", proposeMessage(resolution("h2", "fresh")));

  assert.equal(state.resolutions.length, 1);
  assert.equal(state.resolutions[0].inputsHash, "h2");
});

test("a contract.delta for the symbol invalidates a stale resolution", () => {
  const state = withDivergentDeltas();
  const liveHash = hashOf(state);

  applyMessage(state, "local", proposeMessage(resolution(liveHash, "merged")));
  assert.equal(state.resolutions.length, 1);

  // Bob shifts his contract again: the live pair changes, so the hash no longer
  // matches and the stored resolution must be dropped.
  applyMessage(
    state,
    "local",
    deltaMessage(
      delta({ id: "bob-2", sessionId: "bob", after: sig("validate(input: string): Promise<Token | null>") })
    )
  );

  assert.equal(state.resolutions.length, 0);
});

test("an unrelated re-report that yields the same pair keeps the resolution", () => {
  const state = withDivergentDeltas();
  const liveHash = hashOf(state);
  applyMessage(state, "local", proposeMessage(resolution(liveHash, "merged")));

  // Re-reporting bob's identical delta (new id, same shape) leaves the live
  // pair unchanged, so the resolution survives.
  applyMessage(
    state,
    "local",
    deltaMessage(delta({ id: "bob-repeat", sessionId: "bob", after: sig("validate(input: string): Promise<Token>") }))
  );

  assert.equal(state.resolutions.length, 1);
});

test("a push for the symbol clears its resolution", () => {
  const state = withDivergentDeltas();
  const liveHash = hashOf(state);
  applyMessage(state, "local", proposeMessage(resolution(liveHash, "merged")));

  applyMessage(state, "local", {
    v: PROTOCOL_VERSION,
    type: "push.notify",
    id: "p1",
    ts: now,
    payload: {
      repoId: "local",
      memberId: "alice",
      sha: "abc",
      summary: "pushed",
      files: ["src/auth/token.ts"],
      symbols: [{ raw: symbol }]
    }
  });

  assert.equal(state.unpushedDeltas.length, 0);
  assert.equal(state.resolutions.length, 0);
});

const now = "2026-06-07T00:00:00.000Z";

function withDivergentDeltas(): TeamState {
  const state = createEmptyTeamState("local");
  state.unpushedDeltas.push(
    delta({ id: "alice-1", sessionId: "alice", after: sig("validate(input: string): Result<Token>") }),
    delta({ id: "bob-1", sessionId: "bob", after: sig("validate(input: string): Promise<Token>") })
  );
  return state;
}

function hashOf(state: TeamState): string {
  return resolutionInputsHash(symbol, resolutionSidesForSymbol(state.unpushedDeltas, symbol));
}

function proposeMessage(value: ContractResolution): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "resolution.propose",
    id: `r-${value.inputsHash}`,
    ts: now,
    payload: { repoId: "local", resolution: value }
  };
}

function deltaMessage(value: ContractDelta): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "contract.delta",
    id: `d-${value.id}`,
    ts: now,
    payload: { delta: value }
  };
}

function resolution(inputsHash: string, rationale: string): ContractResolution {
  return {
    reconciled: true,
    proposedContract: "validate(input: string): Promise<Token>",
    rationale,
    recommendation: "warn",
    instruction: "Write exactly this.",
    source: "test",
    repoId: "local",
    symbol: { raw: symbol },
    inputsHash,
    createdAt: now
  };
}

function delta(input: { id: string; sessionId: string; after: Signature }): ContractDelta {
  return {
    id: input.id,
    repoId: "local",
    sessionId: input.sessionId,
    symbolId: { raw: symbol },
    changeKind: "signature_changed",
    before: sig("validate(input: string): boolean"),
    after: input.after,
    summary: "changed validate",
    filePath: "src/auth/token.ts",
    baseSha: "local",
    dependents: [],
    createdAt: now,
    pushedAt: null
  };
}

function sig(raw: string): Signature {
  return { params: [], returns: null, raw };
}
