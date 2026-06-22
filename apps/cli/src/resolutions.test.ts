import assert from "node:assert/strict";
import test from "node:test";
import type { Conflict, ResolutionSide } from "@synapse/conflict-engine";
import {
  createEmptyTeamState,
  type ContractResolution,
  type ProposedResolution,
  type SymbolId,
  type TeamState
} from "@synapse/protocol";
import type { AffectedSite } from "./analysis.js";
import {
  attachAffectedSites,
  contractParses,
  labelSides,
  toProposed,
  withResolution
} from "./resolutions.js";

const sym = (raw: string): SymbolId => ({ raw });

function conflict(rule: Conflict["rule"], targetRaw: string, withAnalysis = true): Conflict {
  return {
    id: `c-${targetRaw}`,
    severity: "warn",
    rule,
    targetSymbol: sym(targetRaw),
    counterpart: { memberLogin: "bob", sessionId: "s2", agentType: "other" },
    detail: "detail",
    suggestion: "suggestion",
    ...(withAnalysis
      ? {
          analysis: {
            assessment: "assessment",
            recommendation: "warn",
            actions: [],
            source: "deterministic"
          }
        }
      : {})
  } as unknown as Conflict;
}

test("attachAffectedSites decorates dependency-ish rules that have analysis and sites", () => {
  const sites: AffectedSite[] = [{ symbolId: sym("ts:b#caller"), filePath: "src/b.ts" }];
  const [decorated] = attachAffectedSites([conflict("dependency_changed", "ts:a#x")], () => sites);
  assert.deepEqual(
    (decorated as { analysis?: { affectedSites?: AffectedSite[] } }).analysis?.affectedSites,
    sites
  );
});

test("attachAffectedSites leaves a conflict untouched when there are no sites", () => {
  const input = conflict("dependency_changed", "ts:a#x");
  const [out] = attachAffectedSites([input], () => []);
  assert.equal(out, input);
});

test("attachAffectedSites ignores rules outside the dependency family", () => {
  const input = conflict("same_symbol_active", "ts:a#x");
  const sites: AffectedSite[] = [{ symbolId: sym("ts:b#c"), filePath: "src/b.ts" }];
  const [out] = attachAffectedSites([input], () => sites);
  assert.equal(out, input);
});

test("attachAffectedSites ignores conflicts that carry no analysis", () => {
  const input = conflict("dependency_changed", "ts:a#x", false);
  const sites: AffectedSite[] = [{ symbolId: sym("ts:b#c"), filePath: "src/b.ts" }];
  const [out] = attachAffectedSites([input], () => sites);
  assert.equal(out, input);
});

test("labelSides swaps member for the session's display login when known", () => {
  const state: TeamState = createEmptyTeamState("repo");
  state.sessions.push({
    id: "s1",
    repoId: "repo",
    memberId: "alice",
    memberLogin: "alice@example",
    agentType: "other",
    filesOpen: [],
    filesEditing: [],
    lastTask: null,
    startedAt: "2026-06-22T00:00:00.000Z",
    lastSeen: "2026-06-22T00:00:00.000Z",
    status: "active"
  });

  const sides = [
    { sessionId: "s1", member: "raw-member" },
    { sessionId: "unknown", member: "fallback" }
  ] as unknown as ResolutionSide[];
  const labeled = labelSides(sides, state);

  assert.equal(labeled[0].member, "alice@example");
  assert.equal(labeled[1].member, "fallback");
});

test("contractParses accepts a full declaration", () => {
  assert.equal(contractParses("export function foo(x: number): void"), true);
  assert.equal(contractParses("interface Foo { x: number }"), true);
});

test("contractParses wraps a bare signature as a type alias and still validates", () => {
  assert.equal(contractParses("{ x: number; y: string }"), true);
});

test("contractParses rejects null and a declaration that cannot parse", () => {
  assert.equal(contractParses(null), false);
  // A token that takes the "declaration" branch but is malformed yields no
  // extractable symbol — the lenient type-alias fallback never runs for it.
  assert.equal(contractParses("function ("), false);
});

test("withResolution attaches a resolution only when analysis is present", () => {
  const resolution: ProposedResolution = {
    reconciled: true,
    proposedContract: "export function foo(): void",
    rationale: "r",
    recommendation: "proceed",
    instruction: "i",
    source: "test"
  };

  const withAnalysis = withResolution(conflict("contract_divergent", "ts:a#x"), resolution);
  assert.deepEqual(withAnalysis.analysis?.resolution, resolution);

  const noAnalysis = withResolution(conflict("contract_divergent", "ts:a#x", false), resolution);
  assert.equal(noAnalysis.analysis, undefined);
});

test("toProposed strips the stored record down to the proposed-resolution shape", () => {
  const record = {
    reconciled: false,
    proposedContract: null,
    rationale: "why",
    recommendation: "escalate",
    instruction: "talk it out",
    source: "model-x",
    repoId: "repo",
    symbol: sym("ts:a#x"),
    inputsHash: "hash",
    createdAt: "2026-06-22T00:00:00.000Z"
  } as unknown as ContractResolution;

  assert.deepEqual(toProposed(record), {
    reconciled: false,
    proposedContract: null,
    rationale: "why",
    recommendation: "escalate",
    instruction: "talk it out",
    source: "model-x"
  });
});
