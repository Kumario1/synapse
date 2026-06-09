import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conflict, ConflictFeedback } from "@synapse/protocol";
import { applyAdaptiveSeverity } from "./adaptive.js";

function conflict(rule: Conflict["rule"], severity: Conflict["severity"] = "warn"): Conflict {
  return {
    id: `c-${rule}`,
    severity,
    rule,
    targetSymbol: { raw: "ts:src/a.ts#f" },
    counterpart: { memberLogin: "alice", sessionId: "alice", agentType: "claude-code" },
    detail: "detail",
    suggestion: "suggestion"
  };
}

function feedback(
  rule: ConflictFeedback["rule"],
  outcome: ConflictFeedback["outcome"],
  count: number
): ConflictFeedback[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `f-${rule}-${outcome}-${i}`,
    repoId: "local",
    conflictId: `c-${rule}`,
    sessionId: "bob",
    memberId: "bob",
    outcome,
    rule,
    createdAt: new Date().toISOString()
  }));
}

test("demotes a chronically-dismissed rule from warn to info", () => {
  const result = applyAdaptiveSeverity(
    [conflict("same_symbol_unpushed")],
    feedback("same_symbol_unpushed", "dismissed", 5)
  );
  assert.equal(result.conflicts[0].severity, "info");
  assert.deepEqual(result.demotedRules, ["same_symbol_unpushed"]);
});

test("leaves other rules untouched", () => {
  const result = applyAdaptiveSeverity(
    [conflict("same_symbol_unpushed"), conflict("dependency_changed")],
    feedback("same_symbol_unpushed", "dismissed", 5)
  );
  assert.equal(result.conflicts[0].severity, "info");
  assert.equal(result.conflicts[1].severity, "warn", "a rule without feedback keeps its severity");
});

test("below the dismissal floor nothing demotes", () => {
  const result = applyAdaptiveSeverity(
    [conflict("same_symbol_unpushed")],
    feedback("same_symbol_unpushed", "dismissed", 4)
  );
  assert.equal(result.conflicts[0].severity, "warn");
  assert.deepEqual(result.demotedRules, []);
});

test("acted feedback keeps the dismiss rate under the threshold", () => {
  const result = applyAdaptiveSeverity(
    [conflict("same_symbol_unpushed")],
    [
      ...feedback("same_symbol_unpushed", "dismissed", 5),
      ...feedback("same_symbol_unpushed", "acted", 2)
    ]
  );
  // 5 / 7 ≈ 0.71 < 0.8 — the team does act on this rule, keep warning.
  assert.equal(result.conflicts[0].severity, "warn");
});

test("never promotes and never touches info conflicts", () => {
  const result = applyAdaptiveSeverity(
    [conflict("transitive_dependency", "info")],
    feedback("transitive_dependency", "acted", 20)
  );
  assert.equal(result.conflicts[0].severity, "info");
});

test("feedback without a rule is ignored", () => {
  const entries = feedback("same_symbol_unpushed", "dismissed", 5).map((entry) => ({
    ...entry,
    rule: undefined
  }));
  const result = applyAdaptiveSeverity([conflict("same_symbol_unpushed")], entries);
  assert.equal(result.conflicts[0].severity, "warn");
});

test("thresholds are configurable", () => {
  const result = applyAdaptiveSeverity(
    [conflict("stale_base")],
    feedback("stale_base", "dismissed", 2),
    { minDismissals: 2 }
  );
  assert.equal(result.conflicts[0].severity, "info");
});
