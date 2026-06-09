import assert from "node:assert/strict";
import test from "node:test";
import type { Conflict, Signature } from "@synapse/protocol";
import {
  deterministicAnalysis,
  deterministicResolution,
  resolutionInputsHash,
  type ResolutionSide
} from "./index.js";

const symbol = "ts:src/auth/token.ts#validate";

test("resolutionInputsHash is symmetric regardless of which side is self", () => {
  const aliceOrder: ResolutionSide[] = [
    { sessionId: "alice", member: "alice", before: "f(): boolean", after: "f(): Result<Token>" },
    { sessionId: "bob", member: "bob", before: "f(): boolean", after: "f(): Promise<Token>" }
  ];
  const bobOrder: ResolutionSide[] = [...aliceOrder].reverse();

  assert.equal(
    resolutionInputsHash(symbol, aliceOrder),
    resolutionInputsHash(symbol, bobOrder)
  );
});

test("resolutionInputsHash changes when a side's after changes", () => {
  const base: ResolutionSide[] = [
    { sessionId: "alice", member: "alice", before: null, after: "f(): Result<Token>" },
    { sessionId: "bob", member: "bob", before: null, after: "f(): Promise<Token>" }
  ];
  const drifted: ResolutionSide[] = [
    base[0],
    { ...base[1], after: "f(): Promise<Token | null>" }
  ];

  assert.notEqual(resolutionInputsHash(symbol, base), resolutionInputsHash(symbol, drifted));
});

test("deterministicAnalysis escalates a contract_divergent conflict", () => {
  const conflict = divergentConflict();
  const resolution = deterministicAnalysis(conflict).resolution;

  assert.ok(resolution);
  assert.equal(resolution.reconciled, false);
  assert.equal(resolution.recommendation, "block");
  assert.equal(resolution.proposedContract, null);
  // Both sides' afters appear in the instruction, ordered deterministically.
  assert.ok(resolution.instruction.includes("validate(input: string): Result<Token>"));
  assert.ok(resolution.instruction.includes("validate(input: string): Promise<Token>"));
});

test("deterministicResolution side ordering is identical on both machines", () => {
  const fromBob = deterministicResolution(divergentConflict());
  const fromAlice = deterministicResolution(divergentConflict({ flip: true }));

  assert.ok(fromBob && fromAlice);
  assert.equal(fromBob.instruction, fromAlice.instruction);
});

test("deterministicAnalysis adopts the counterpart contract for same_symbol_unpushed", () => {
  const after = sig("validate(input: string): Result<Token>");
  const conflict: Conflict = {
    id: "conflict:test-adopt",
    severity: "warn",
    rule: "same_symbol_unpushed",
    targetSymbol: { raw: symbol },
    counterpart: { memberLogin: "alice", sessionId: "alice", agentType: "other" },
    detail: "alice changed validate",
    suggestion: "Pull or inspect.",
    change: {
      changeKind: "signature_changed",
      before: sig("validate(input: string): boolean"),
      after,
      compatibility: "breaking",
      breakingReasons: ["Return type changed."]
    }
  };

  const resolution = deterministicAnalysis(conflict).resolution;
  assert.ok(resolution);
  assert.equal(resolution.reconciled, true);
  assert.equal(resolution.proposedContract, after.raw);
  assert.ok(resolution.instruction.includes(after.raw));
});

test("deterministicResolution returns undefined for unrelated rules", () => {
  const conflict: Conflict = {
    id: "conflict:test-stale",
    severity: "warn",
    rule: "stale_base",
    targetSymbol: { raw: symbol },
    counterpart: { memberLogin: "alice", sessionId: "push", agentType: "other" },
    detail: "a recent push touched validate",
    suggestion: "Pull latest."
  };

  assert.equal(deterministicResolution(conflict), undefined);
});

function divergentConflict(options: { flip?: boolean } = {}): Conflict {
  const bobAfter = sig("validate(input: string): Promise<Token>");
  const aliceAfter = sig("validate(input: string): Result<Token>");

  // `flip` swaps which agent is the checking "self" — the instruction must be
  // identical either way because sides are ordered by sessionId.
  const self = options.flip
    ? { sessionId: "alice", after: aliceAfter, counterpartId: "bob", counterpartAfter: bobAfter }
    : { sessionId: "bob", after: bobAfter, counterpartId: "alice", counterpartAfter: aliceAfter };

  return {
    id: `conflict:test-divergent-${options.flip ? "alice" : "bob"}`,
    severity: "warn",
    rule: "contract_divergent",
    targetSymbol: { raw: symbol },
    counterpart: { memberLogin: self.counterpartId, sessionId: self.counterpartId, agentType: "other" },
    detail: "both changed validate",
    suggestion: "Agree on one contract.",
    change: {
      changeKind: "signature_changed",
      before: sig("validate(input: string): boolean"),
      after: self.counterpartAfter,
      compatibility: "breaking",
      breakingReasons: ["Return type changed."]
    },
    selfChange: {
      changeKind: "signature_changed",
      before: sig("validate(input: string): boolean"),
      after: self.after,
      compatibility: "breaking",
      breakingReasons: ["Return type changed."]
    },
    selfSessionId: self.sessionId
  };
}

function sig(raw: string): Signature {
  return { params: [], returns: null, raw };
}
