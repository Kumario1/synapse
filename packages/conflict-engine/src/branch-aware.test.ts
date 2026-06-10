import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conflict } from "@synapse/protocol";
import { applyBranchAwareness } from "./branch-aware.js";

function conflict(
  rule: Conflict["rule"],
  options: { severity?: Conflict["severity"]; branch?: string } = {}
): Conflict {
  return {
    id: `c-${rule}`,
    severity: options.severity ?? "warn",
    rule,
    targetSymbol: { raw: "ts:src/a.ts#f" },
    counterpart: {
      memberLogin: "alice",
      sessionId: "alice",
      agentType: "claude-code",
      branch: options.branch
    },
    detail: "detail",
    suggestion: "suggestion"
  };
}

test("demotes cross-branch dependency_changed and stale_base to info", () => {
  const result = applyBranchAwareness(
    [
      conflict("dependency_changed", { branch: "feature-x" }),
      conflict("stale_base", { branch: "feature-x" })
    ],
    "main"
  );

  assert.deepEqual(
    result.conflicts.map((entry) => entry.severity),
    ["info", "info"]
  );
  assert.deepEqual(result.demotedRules.sort(), ["dependency_changed", "stale_base"]);
});

test("same-branch conflicts keep their severity", () => {
  const result = applyBranchAwareness(
    [conflict("dependency_changed", { branch: "main" }), conflict("stale_base", { branch: "main" })],
    "main"
  );

  assert.deepEqual(
    result.conflicts.map((entry) => entry.severity),
    ["warn", "warn"]
  );
  assert.deepEqual(result.demotedRules, []);
});

test("never demotes merge-blocking rules even across branches", () => {
  const result = applyBranchAwareness(
    [
      conflict("same_symbol_active", { branch: "feature-x" }),
      conflict("same_symbol_unpushed", { branch: "feature-x" }),
      conflict("contract_divergent", { branch: "feature-x" })
    ],
    "main"
  );

  assert.deepEqual(
    result.conflicts.map((entry) => entry.severity),
    ["warn", "warn", "warn"]
  );
  assert.deepEqual(result.demotedRules, []);
});

test("unknown branch on either side leaves the conflict untouched", () => {
  const counterpartUnknown = applyBranchAwareness(
    [conflict("dependency_changed", { branch: undefined })],
    "main"
  );
  assert.equal(counterpartUnknown.conflicts[0].severity, "warn");

  const selfUnknown = applyBranchAwareness(
    [conflict("dependency_changed", { branch: "feature-x" })],
    undefined
  );
  assert.equal(selfUnknown.conflicts[0].severity, "warn");
  assert.deepEqual(selfUnknown.demotedRules, []);
});

test("never promotes info conflicts", () => {
  const result = applyBranchAwareness(
    [conflict("transitive_dependency", { severity: "info", branch: "feature-x" })],
    "main"
  );
  assert.equal(result.conflicts[0].severity, "info");
});
