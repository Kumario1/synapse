import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyTeamState, type ConflictFeedback } from "@synapse/protocol";
import type { RuntimeConfig } from "./config.js";
import {
  buildInsightsResponse,
  bucketTop,
  clampLimit,
  createConflictFeedback
} from "./insights.js";

const config = {
  repoId: "repo",
  sessionId: "sess",
  member: "alice"
} as unknown as RuntimeConfig;

test("bucketTop counts, sorts by count desc then name asc, and clamps", () => {
  const ranked = bucketTop(["b", "a", "b", "c", "a", "b"], 2);
  assert.deepEqual(ranked, [
    { name: "b", count: 3 },
    { name: "a", count: 2 }
  ]);
});

test("bucketTop breaks ties alphabetically", () => {
  const ranked = bucketTop(["y", "x", "y", "x"], 5);
  assert.deepEqual(ranked, [
    { name: "x", count: 2 },
    { name: "y", count: 2 }
  ]);
});

test("clampLimit floors to fallback for non-finite and caps to max", () => {
  assert.equal(clampLimit(undefined, 5, 20), 5);
  assert.equal(clampLimit(Number.NaN, 5, 20), 5);
  assert.equal(clampLimit(Infinity, 5, 20), 5);
  assert.equal(clampLimit(100, 5, 20), 20);
  assert.equal(clampLimit(0, 5, 20), 1);
  assert.equal(clampLimit(7.9, 5, 20), 7);
});

test("createConflictFeedback stamps repo/session/member identity", () => {
  const feedback = createConflictFeedback(config, {
    conflictId: "c1",
    outcome: "acted",
    rule: "contract_divergent",
    targetSymbol: { raw: "ts:a#x" }
  });

  assert.equal(feedback.repoId, "repo");
  assert.equal(feedback.sessionId, "sess");
  assert.equal(feedback.memberId, "alice");
  assert.equal(feedback.conflictId, "c1");
  assert.equal(feedback.outcome, "acted");
  assert.match(feedback.id, /[0-9a-f-]{36}/u);
});

test("buildInsightsResponse summarizes feedback totals and the noisiest rule", () => {
  const state = createEmptyTeamState("repo");
  state.conflictFeedback.push(
    feedback("c1", "acted", "contract_divergent"),
    feedback("c2", "dismissed", "contract_divergent"),
    feedback("c3", "dismissed", "stale_base")
  );

  const insights = buildInsightsResponse(state, { degraded: false });

  assert.equal(insights.totals.feedback, 3);
  assert.equal(insights.totals.acted, 1);
  assert.equal(insights.totals.dismissed, 2);
  assert.equal(insights.degraded, false);
  assert.equal(insights.topRulesByFeedback[0]?.name, "contract_divergent");
  assert.equal(insights.topRulesByFeedback[0]?.count, 2);
  assert.ok(insights.summary.some((line) => line.includes("Noisiest feedback rule")));
});

test("buildInsightsResponse on an empty room reports zeros and stays non-degraded-aware", () => {
  const insights = buildInsightsResponse(createEmptyTeamState("repo"), { degraded: true });

  assert.equal(insights.totals.feedback, 0);
  assert.equal(insights.degraded, true);
  assert.deepEqual(insights.topRulesByFeedback, []);
});

function feedback(
  conflictId: string,
  outcome: ConflictFeedback["outcome"],
  rule: ConflictFeedback["rule"]
): ConflictFeedback {
  return {
    id: `fb-${conflictId}`,
    repoId: "repo",
    conflictId,
    sessionId: "sess",
    memberId: "alice",
    outcome,
    rule,
    targetSymbol: { raw: `ts:a#${conflictId}` },
    createdAt: "2026-06-22T00:00:00.000Z"
  };
}
