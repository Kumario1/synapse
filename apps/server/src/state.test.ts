import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ContractDelta,
  type ContractResolution,
  type EditLock,
  type Session,
  type Signature,
  type TeamState
} from "@synapse/protocol";
import { resolutionInputsHash, resolutionSidesForSymbol } from "@synapse/conflict-engine";
import { applyMessage, pruneStaleSessions } from "./state.js";

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

test("session.summary stores most-recent-first and replaces a session's prior summary", () => {
  const state = createEmptyTeamState("local");

  applyMessage(state, "local", summaryMessage("alice", "alice's first summary"));
  applyMessage(state, "local", summaryMessage("bob", "bob's summary"));
  // Re-ending alice replaces her entry rather than adding a second.
  applyMessage(state, "local", summaryMessage("alice", "alice's revised summary"));

  assert.equal(state.sessionSummaries.length, 2);
  assert.equal(state.sessionSummaries[0].sessionId, "alice", "most recent is first");
  assert.equal(state.sessionSummaries[0].summary, "alice's revised summary");
  assert.equal(state.sessionSummaries.filter((s) => s.sessionId === "alice").length, 1);
});

test("repo.event stores recent GitHub activity most-recent-first and caps history", () => {
  const state = createEmptyTeamState("local");

  for (let index = 0; index < 55; index += 1) {
    applyMessage(state, "local", repoEventMessage(index));
  }

  assert.equal(state.recentRepoEvents.length, 50);
  assert.equal(state.recentRepoEvents[0].summary, "GitHub PR #54 opened: Feature 54");
  assert.equal(state.recentRepoEvents[49].summary, "GitHub PR #5 opened: Feature 5");
});

test("conflict.feedback stores most-recent-first, replaces retries, and caps history", () => {
  const state = createEmptyTeamState("local");

  applyMessage(state, "local", feedbackMessage("f-retry", "acted", 0));
  applyMessage(state, "local", feedbackMessage("f-retry", "dismissed", 1));

  assert.equal(state.conflictFeedback.length, 1);
  assert.equal(state.conflictFeedback[0].outcome, "dismissed");

  for (let index = 0; index < 105; index += 1) {
    applyMessage(state, "local", feedbackMessage(`f-${index}`, "acted", index));
  }

  assert.equal(state.conflictFeedback.length, 100);
  assert.equal(state.conflictFeedback[0].conflictId, "conflict-104");
  assert.equal(state.conflictFeedback[99].conflictId, "conflict-5");
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

function summaryMessage(sessionId: string, summary: string): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "session.summary",
    id: `s-${sessionId}`,
    ts: now,
    payload: {
      repoId: "local",
      summary: {
        sessionId,
        repoId: "local",
        memberLogin: sessionId,
        task: null,
        summary,
        symbols: [{ raw: symbol }],
        deltaCount: 1,
        source: "deterministic",
        startedAt: now,
        endedAt: now
      }
    }
  };
}

function repoEventMessage(index: number): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "repo.event",
    id: `e-${index}`,
    ts: now,
    payload: {
      repoId: "local",
      kind: "pull_request",
      action: "opened",
      actor: "alice",
      title: `Feature ${index}`,
      number: index,
      url: `https://github.com/acme/widgets/pull/${index}`,
      summary: `GitHub PR #${index} opened: Feature ${index}`
    }
  };
}

function feedbackMessage(
  id: string,
  outcome: "acted" | "dismissed",
  index: number
): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "conflict.feedback",
    id: `f-msg-${index}`,
    ts: now,
    payload: {
      repoId: "local",
      feedback: {
        id,
        repoId: "local",
        conflictId: `conflict-${index}`,
        sessionId: "bob",
        memberId: "bob",
        outcome,
        rule: "same_symbol_unpushed",
        targetSymbol: { raw: symbol },
        note: `note ${index}`,
        createdAt: new Date(Date.parse(now) + index).toISOString()
      }
    }
  };
}

test("session.heartbeat with a branch refreshes the session branch", () => {
  const state = createEmptyTeamState("local");
  applyMessage(state, "local", sessionStartMessage("alice", "main"));

  applyMessage(state, "local", heartbeatMessage("alice", "feature-x"));

  assert.equal(state.sessions[0].branch, "feature-x");
});

test("session.heartbeat without a branch preserves the known branch", () => {
  const state = createEmptyTeamState("local");
  applyMessage(state, "local", sessionStartMessage("alice", "main"));

  applyMessage(state, "local", heartbeatMessage("alice"));

  assert.equal(state.sessions[0].branch, "main");
});

test("session.heartbeat with a task sets lastTask", () => {
  const state = createEmptyTeamState("local");
  applyMessage(state, "local", sessionStartMessage("alice", "main"));

  applyMessage(state, "local", heartbeatMessage("alice", undefined, "add JWT refresh"));

  assert.equal(state.sessions[0].lastTask, "add JWT refresh");
});

test("session.heartbeat without a task preserves the known lastTask", () => {
  const state = createEmptyTeamState("local");
  applyMessage(state, "local", sessionStartMessage("alice", "main"));
  applyMessage(state, "local", heartbeatMessage("alice", undefined, "add JWT refresh"));

  applyMessage(state, "local", heartbeatMessage("alice"));

  assert.equal(state.sessions[0].lastTask, "add JWT refresh");
});

function sessionStartMessage(sessionId: string, branch?: string): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "session.start",
    id: `s-${sessionId}`,
    ts: now,
    payload: {
      session: {
        id: sessionId,
        repoId: "local",
        memberId: sessionId,
        memberLogin: sessionId,
        agentType: "other",
        filesOpen: [],
        filesEditing: [],
        lastTask: null,
        startedAt: now,
        lastSeen: now,
        status: "active",
        ...(branch ? { branch } : {})
      }
    }
  };
}

function heartbeatMessage(sessionId: string, branch?: string, task?: string): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "session.heartbeat",
    id: `hb-${sessionId}-${branch ?? "none"}-${task ?? "none"}`,
    ts: now,
    payload: {
      repoId: "local",
      sessionId,
      ...(branch ? { branch } : {}),
      ...(task ? { task } : {})
    }
  };
}

const sweepNow = Date.parse(now);
const FIVE_MIN_MS = 5 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;

function staleSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "alice",
    repoId: "local",
    memberId: "alice",
    memberLogin: "alice",
    agentType: "other",
    filesOpen: ["src/auth/token.ts"],
    filesEditing: ["src/auth/token.ts"],
    lastTask: "refactor auth",
    startedAt: now,
    lastSeen: now,
    status: "active",
    ...overrides
  };
}

function lockFor(sessionId: string): EditLock {
  return {
    sessionId,
    symbolId: { raw: symbol },
    filePath: "src/auth/token.ts",
    acquiredAt: now,
    ttlSec: 90
  };
}

test("pruneStaleSessions ends a session that missed heartbeats past the TTL", () => {
  const state = createEmptyTeamState("local");
  state.sessions.push(staleSession({ lastSeen: new Date(sweepNow - FIVE_MIN_MS - 1).toISOString() }));
  state.editLocks.push(lockFor("alice"));

  pruneStaleSessions(state, undefined, sweepNow);

  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].status, "ended");
  assert.deepEqual(state.sessions[0].filesEditing, []);
  assert.equal(state.editLocks.length, 0);
});

test("pruneStaleSessions leaves a recently-seen active session unchanged", () => {
  const state = createEmptyTeamState("local");
  state.sessions.push(staleSession({ lastSeen: new Date(sweepNow - 60_000).toISOString() }));
  state.editLocks.push(lockFor("alice"));

  pruneStaleSessions(state, undefined, sweepNow);

  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].status, "active");
  assert.deepEqual(state.sessions[0].filesEditing, ["src/auth/token.ts"]);
  assert.equal(state.editLocks.length, 1);
});

test("pruneStaleSessions removes a long-ended session from state", () => {
  const state = createEmptyTeamState("local");
  state.sessions.push(
    staleSession({ status: "ended", lastSeen: new Date(sweepNow - ONE_DAY_MS - 1).toISOString() })
  );

  pruneStaleSessions(state, undefined, sweepNow);

  assert.equal(state.sessions.length, 0);
});

test("SYNAPSE_SESSION_SWEEP=0 disables the sweep", () => {
  const state = createEmptyTeamState("local");
  state.sessions.push(staleSession({ lastSeen: new Date(sweepNow - FIVE_MIN_MS - 1).toISOString() }));

  const previous = process.env.SYNAPSE_SESSION_SWEEP;
  process.env.SYNAPSE_SESSION_SWEEP = "0";
  try {
    pruneStaleSessions(state, undefined, sweepNow);
  } finally {
    if (previous === undefined) {
      delete process.env.SYNAPSE_SESSION_SWEEP;
    } else {
      process.env.SYNAPSE_SESSION_SWEEP = previous;
    }
  }

  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].status, "active");
});

test("a returning daemon's session.start revives a session the sweep ended", () => {
  const state = createEmptyTeamState("local");
  state.sessions.push(staleSession({ lastSeen: new Date(sweepNow - FIVE_MIN_MS - 1).toISOString() }));

  pruneStaleSessions(state, undefined, sweepNow);
  assert.equal(state.sessions[0].status, "ended");

  applyMessage(state, "local", sessionStartMessage("alice"));

  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].status, "active");
});
