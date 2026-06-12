import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyTeamState, type RecallMatch, type TeamState } from "@synapse/protocol";
import { buildOnboardResponse, mergeRecallIntoOnboard, recentWhySources } from "./briefings.js";

const now = "2026-06-11T00:00:00.000Z";
const later = "2026-06-11T01:00:00.000Z";

test("onboarding a populated room renders every section with numbered decisions", () => {
  const state = populatedState();

  const onboard = buildOnboardResponse(state, { degraded: false });

  assert.equal(onboard.repoId, "local");
  assert.equal(onboard.degraded, false);
  assert.ok(onboard.briefing.startsWith("🧭 Synapse onboarding briefing for local:"));
  assert.ok(onboard.briefing.includes("Active sessions:"));
  assert.ok(onboard.briefing.includes("Recent pushes:"));
  assert.ok(onboard.briefing.includes("Decisions & history:"));
  assert.ok(/ {2}1\. /.test(onboard.briefing), "decisions are numbered citations");
  assert.ok(onboard.sections.decisions.length > 0);
});

test("onboarding an empty room answers with the no-history line, never null", () => {
  const onboard = buildOnboardResponse(createEmptyTeamState("local"), { degraded: true });

  assert.equal(
    onboard.briefing,
    "🧭 Synapse onboarding briefing for local:\nNo recorded team history yet — this room is new."
  );
  assert.equal(onboard.degraded, true);
  assert.deepEqual(onboard.sections.decisions, []);
});

test("recentWhySources orders by recency and clamps to the limit", () => {
  const state = populatedState();

  const sources = recentWhySources(state, 2);

  assert.equal(sources.length, 2);
  assert.ok(sources[0].createdAt >= sources[1].createdAt);
});

test("recall matches merge additively and rerender the decisions section", () => {
  const state = populatedState();
  const onboard = buildOnboardResponse(state, { degraded: false });
  const floorCount = onboard.sections.decisions.length;

  const merged = mergeRecallIntoOnboard(onboard, [recallMatch("vector-only memory")]);

  assert.equal(merged.rag, true);
  assert.equal(merged.sections.decisions.length, floorCount + 1);
  assert.ok(merged.briefing.includes("vector-only memory"));
});

test("a recall match duplicating a floor source is not appended twice", () => {
  const state = populatedState();
  const onboard = buildOnboardResponse(state, { degraded: false });
  const existing = onboard.sections.decisions[0];

  const merged = mergeRecallIntoOnboard(onboard, [
    { ...recallMatch(existing.title), reference: existing.reference }
  ]);

  assert.notEqual(merged.rag, true);
  assert.equal(merged.sections.decisions.length, onboard.sections.decisions.length);
});

test("recall can answer for a room whose lexical floor is empty", () => {
  const onboard = buildOnboardResponse(createEmptyTeamState("local"), { degraded: false });

  const merged = mergeRecallIntoOnboard(onboard, [recallMatch("only vector memory")]);

  assert.equal(merged.rag, true);
  assert.ok(merged.briefing.includes("Decisions & history:"));
  assert.ok(!merged.briefing.includes("No recorded team history yet"));
});

function recallMatch(title: string): RecallMatch {
  return {
    kind: "session_summary",
    title,
    summary: `${title} summary`,
    reference: `ref-${title}`,
    createdAt: now,
    score: 0.9
  };
}

function populatedState(): TeamState {
  const state = createEmptyTeamState("local");
  state.sessions.push({
    id: "alice",
    repoId: "local",
    memberId: "alice",
    memberLogin: "alice",
    agentType: "other",
    filesOpen: [],
    filesEditing: ["src/auth/token.ts"],
    lastTask: "auth refactor",
    startedAt: now,
    lastSeen: later,
    status: "active"
  });
  state.recentPushes.push({
    id: "push-1",
    repoId: "local",
    memberId: "alice",
    summary: "Tighten token validation",
    filesAffected: ["src/auth/token.ts"],
    sha: "abc123",
    pushedAt: later
  });
  state.sessionSummaries.push({
    sessionId: "bob",
    repoId: "local",
    memberLogin: "bob",
    task: "login rework",
    summary: "Reworked login flow around the new validate contract",
    symbols: [],
    deltaCount: 1,
    source: "deterministic",
    startedAt: now,
    endedAt: now
  });
  return state;
}
