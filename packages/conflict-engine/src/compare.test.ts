import assert from "node:assert/strict";
import test from "node:test";
import type { ContractDelta, Session, Signature, SymbolId, TeamState } from "@synapse/protocol";
import {
  compareSignatures,
  enrichConflicts,
  evaluateConflicts,
  type AnalysisProvider,
  verdictFor
} from "./index.js";

const validate = id("ts:src/auth/token.ts#TokenValidator.validate");

test("classifies a return-type change as breaking", () => {
  const result = compareSignatures(
    sig("(token: string) => Token", [param("token", "string")], "Token"),
    sig("(token: string) => Result<Token, AuthError>", [param("token", "string")], "Result<Token, AuthError>")
  );

  assert.equal(result.compatibility, "breaking");
  assert.ok(result.reasons.some((reason) => reason.includes("Return type changed")));
});

test("classifies an added optional parameter as backward-compatible", () => {
  const result = compareSignatures(
    sig("(token: string) => Token", [param("token", "string")], "Token"),
    sig("(token: string, opts?: Options) => Token", [param("token", "string"), param("opts", "Options", true)], "Token")
  );

  assert.equal(result.compatibility, "compatible");
});

test("classifies an added required parameter as breaking", () => {
  const result = compareSignatures(
    sig("(token: string) => Token", [param("token", "string")], "Token"),
    sig("(token: string, scope: string) => Token", [param("token", "string"), param("scope", "string")], "Token")
  );

  assert.equal(result.compatibility, "breaking");
});

test("treats a summary-only change (no signatures) as unknown", () => {
  const result = compareSignatures(null, null);
  assert.equal(result.compatibility, "unknown");
});

test("breaking same-symbol change warns and carries the before/after", () => {
  const state = teamState({
    sessions: [session("alice"), session("bob")],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        before: sig("(token: string) => Token", [param("token", "string")], "Token"),
        after: sig(
          "(token: string) => Result<Token, AuthError>",
          [param("token", "string")],
          "Result<Token, AuthError>"
        )
      })
    ]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: validate }],
    state
  });

  assert.equal(verdictFor(conflicts), "warn");
  assert.equal(conflicts[0]?.rule, "same_symbol_unpushed");
  assert.equal(conflicts[0]?.change?.compatibility, "breaking");
  // A breaking change yields an actionable analysis addressed to both sides.
  assert.equal(conflicts[0]?.analysis?.recommendation, "warn");
  assert.ok((conflicts[0]?.analysis?.actions.length ?? 0) >= 1);
  assert.ok(conflicts[0]?.analysis?.actions.some((action) => action.audience === "you"));
});

test("backward-compatible same-symbol change is demoted to info", () => {
  const state = teamState({
    sessions: [session("alice"), session("bob")],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        before: sig("(token: string) => Token", [param("token", "string")], "Token"),
        after: sig(
          "(token: string, opts?: Options) => Token",
          [param("token", "string"), param("opts", "Options", true)],
          "Token"
        )
      })
    ]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: validate }],
    state
  });

  assert.equal(verdictFor(conflicts), "info");
  assert.equal(conflicts[0]?.change?.compatibility, "compatible");
});

test("two divergent changes to the same symbol raise contract_divergent", () => {
  const state = teamState({
    sessions: [session("alice"), session("bob")],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        after: sig("(token: string) => Result<Token, AuthError>", [param("token", "string")], "Result<Token, AuthError>")
      }),
      delta({
        sessionId: "bob",
        after: sig("(token: string) => Promise<Token>", [param("token", "string")], "Promise<Token>")
      })
    ]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: validate }],
    state
  });

  assert.equal(verdictFor(conflicts), "warn");
  assert.equal(conflicts[0]?.rule, "contract_divergent");
});

test("enrichConflicts replaces explanation and falls back when the provider returns null", async () => {
  const state = teamState({
    sessions: [session("alice"), session("bob")],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        before: sig("(token: string) => Token", [param("token", "string")], "Token"),
        after: sig("(token: string) => Result<Token, AuthError>", [param("token", "string")], "Result<Token, AuthError>")
      })
    ]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: validate }],
    state
  });

  const provider: AnalysisProvider = {
    async analyzeConflict(input) {
      return {
        assessment: `LLM analysis of ${input.rule}`,
        recommendation: "warn",
        actions: [{ audience: "you", step: "do the thing" }],
        source: "test-model"
      };
    }
  };
  const enriched = await enrichConflicts(conflicts, provider);
  assert.equal(enriched[0]?.analysis?.source, "test-model");
  assert.ok(enriched[0]?.analysis?.assessment.startsWith("LLM analysis"));

  const failing: AnalysisProvider = {
    async analyzeConflict() {
      throw new Error("model unavailable");
    }
  };
  const fallback = await enrichConflicts(conflicts, failing);
  assert.equal(fallback[0]?.analysis?.source, "deterministic");
});

test("enrichConflicts keeps the deterministic recommendation floor", async () => {
  const state = teamState({
    sessions: [session("alice"), session("bob")],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        before: sig("(token: string) => Token", [param("token", "string")], "Token"),
        after: sig("(token: string) => Result<Token, AuthError>", [param("token", "string")], "Result<Token, AuthError>")
      })
    ]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: validate }],
    state
  });

  const provider: AnalysisProvider = {
    async analyzeConflict() {
      return {
        assessment: "LLM marked the breaking change as informational.",
        recommendation: "info",
        actions: [{ audience: "you", step: "inspect the change" }],
        source: "test-model"
      };
    }
  };

  const enriched = await enrichConflicts(conflicts, provider);
  assert.equal(enriched[0]?.analysis?.source, "test-model");
  assert.equal(enriched[0]?.analysis?.recommendation, "warn");
  assert.equal(enriched[0]?.analysis?.assessment, "LLM marked the breaking change as informational.");
});

function id(raw: string): SymbolId {
  return { raw };
}

function sig(raw: string, params: Signature["params"], returns: string | null): Signature {
  return { raw, params, returns };
}

function param(name: string, type: string, optional = false): Signature["params"][number] {
  return { name, type, optional };
}

function session(idValue: string): Session {
  return {
    id: idValue,
    repoId: "local",
    memberId: idValue,
    memberLogin: idValue,
    agentType: "other",
    filesOpen: [],
    filesEditing: [],
    lastTask: null,
    startedAt: "2026-06-06T00:00:00.000Z",
    lastSeen: "2026-06-06T00:00:00.000Z",
    status: "active"
  };
}

function delta(input: {
  sessionId: string;
  before?: Signature | null;
  after?: Signature | null;
}): ContractDelta {
  return {
    id: `${input.sessionId}-${validate.raw}`,
    repoId: "local",
    sessionId: input.sessionId,
    symbolId: validate,
    changeKind: "signature_changed",
    before: input.before ?? null,
    after: input.after ?? null,
    summary: "validate signature updated",
    filePath: "src/auth/token.ts",
    baseSha: "local",
    dependents: [],
    createdAt: "2026-06-06T00:00:00.000Z",
    pushedAt: null
  };
}

function teamState(partial: Partial<TeamState>): TeamState {
  return {
    repoId: "local",
    sessions: [],
    editLocks: [],
    unpushedDeltas: [],
    recentPushes: [],
    resolutions: [],
    ...partial
  };
}
