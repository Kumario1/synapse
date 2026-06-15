import assert from "node:assert/strict";
import test from "node:test";
import type { ContractDelta, EditLock, Session, SymbolId, TeamState } from "@synapse/protocol";
import {
  editLockIsActive,
  evaluateConflicts,
  type DependencyGraph,
  type DependencyHop,
  verdictFor
} from "./index.js";

const tokenValidator = id("ts:src/auth/token.ts#TokenValidator.validate");
const token = id("ts:src/auth/token.ts#Token");
const login = id("ts:src/auth/login.ts#login");

test("warns on same-symbol unpushed contract delta", () => {
  const state = teamState({
    sessions: [
      { ...session("alice"), filesEditing: ["src/auth/token.ts"] },
      session("bob")
    ],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        symbolId: tokenValidator,
        summary: "validate now returns Result<Token, AuthError>"
      })
    ]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: tokenValidator }],
    state
  });

  assert.equal(verdictFor(conflicts), "warn");
  assert.deepEqual(
    conflicts.map((conflict) => conflict.rule),
    ["same_symbol_unpushed"]
  );
  assert.match(conflicts[0].id, /^conflict:[0-9a-f]{16}$/u);
});

test("conflict ids are stable for the same warning input", () => {
  const state = teamState({
    sessions: [session("alice"), session("bob")],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        symbolId: tokenValidator,
        summary: "validate now returns Result<Token, AuthError>"
      })
    ]
  });

  const first = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: tokenValidator }],
    state
  });
  const second = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: tokenValidator }],
    state
  });

  assert.equal(first[0]?.id, second[0]?.id);
});

test("suppresses same-file noise when another target has a specific conflict", () => {
  const state = teamState({
    sessions: [
      { ...session("alice"), filesEditing: ["src/auth/token.ts"] },
      session("bob")
    ],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        symbolId: tokenValidator,
        summary: "validate now returns Result<Token, AuthError>"
      })
    ]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [
      { filePath: "src/auth/token.ts", symbolId: token },
      { filePath: "src/auth/token.ts", symbolId: tokenValidator }
    ],
    state
  });

  assert.equal(verdictFor(conflicts), "warn");
  assert.deepEqual(
    conflicts.map((conflict) => conflict.rule),
    ["same_symbol_unpushed"]
  );
});

test("warns when a direct dependency has an unpushed contract delta", () => {
  const graph: DependencyGraph = {
    dependenciesOf(symbol: SymbolId): DependencyHop[] {
      if (symbol.raw === login.raw) {
        return [{ symbolId: tokenValidator, hops: 1 }];
      }

      return [];
    }
  };

  const state = teamState({
    sessions: [session("alice"), session("bob")],
    unpushedDeltas: [
      delta({
        sessionId: "alice",
        symbolId: tokenValidator,
        summary: "validate now returns Result<Token, AuthError>"
      })
    ]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/login.ts", symbolId: login }],
    state,
    graph
  });

  assert.equal(verdictFor(conflicts), "warn");
  assert.equal(conflicts[0]?.rule, "dependency_changed");
});

test("stays silent when there is no overlap", () => {
  const state = teamState({
    sessions: [session("alice"), session("bob")]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/login.ts", symbolId: login }],
    state
  });

  assert.equal(verdictFor(conflicts), "none");
  assert.deepEqual(conflicts, []);
});

test("ignores expired edit locks during conflict evaluation", () => {
  const expiredLock = editLock({
    sessionId: "alice",
    acquiredAt: "2026-06-14T00:00:00.000Z",
    ttlSec: 1
  });
  const liveLock = editLock({
    sessionId: "alice",
    acquiredAt: "2026-06-14T00:00:00.000Z",
    ttlSec: 60_000
  });

  assert.equal(editLockIsActive(expiredLock, Date.parse("2026-06-14T00:00:02.000Z")), false);
  assert.equal(editLockIsActive(liveLock, Date.parse("2026-06-14T00:00:02.000Z")), true);

  const state = teamState({
    sessions: [session("alice"), session("bob")],
    editLocks: [expiredLock]
  });

  const conflicts = evaluateConflicts({
    selfSessionId: "bob",
    targets: [{ filePath: "src/auth/token.ts", symbolId: tokenValidator }],
    state
  });

  assert.equal(verdictFor(conflicts), "none");
  assert.equal(conflicts.some((conflict) => conflict.rule === "same_symbol_active"), false);
});

function id(raw: string): SymbolId {
  return { raw };
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
  symbolId: SymbolId;
  summary: string;
}): ContractDelta {
  return {
    id: `${input.sessionId}-${input.symbolId.raw}`,
    repoId: "local",
    sessionId: input.sessionId,
    symbolId: input.symbolId,
    changeKind: "signature_changed",
    before: null,
    after: null,
    summary: input.summary,
    filePath: "src/auth/token.ts",
    baseSha: "local",
    dependents: [],
    createdAt: "2026-06-06T00:00:00.000Z",
    pushedAt: null
  };
}

function editLock(input: { sessionId: string; acquiredAt: string; ttlSec: number }): EditLock {
  return {
    sessionId: input.sessionId,
    symbolId: tokenValidator,
    filePath: "src/auth/token.ts",
    acquiredAt: input.acquiredAt,
    ttlSec: input.ttlSec
  };
}

function teamState(partial: Partial<TeamState>): TeamState {
  return {
    repoId: "local",
    sessions: [],
    editLocks: [],
    unpushedDeltas: [],
    recentPushes: [],
    recentRepoEvents: [],
    resolutions: [],
    sessionSummaries: [],
    conflictFeedback: [],
    ...partial
  };
}
