import assert from "node:assert/strict";
import test from "node:test";
import type { TeamState } from "@synapse/protocol";
import { deriveContestedSymbols, deriveGraph } from "./derive";

const baseState: TeamState = {
  repoId: "demo/playground",
  sessions: [
    {
      id: "s1",
      repoId: "demo/playground",
      memberId: "alice-id",
      memberLogin: "alice",
      agentType: "claude-code",
      filesOpen: ["src/api.ts"],
      filesEditing: ["src/api.ts"],
      lastTask: "Adjust API contract",
      startedAt: "2026-06-15T12:00:00.000Z",
      lastSeen: "2026-06-15T12:03:00.000Z",
      status: "active",
      branch: "feature/api"
    },
    {
      id: "s2",
      repoId: "demo/playground",
      memberId: "bob-id",
      memberLogin: "bob",
      agentType: "cursor",
      filesOpen: ["src/client.ts"],
      filesEditing: ["src/client.ts"],
      lastTask: "Wire client call",
      startedAt: "2026-06-15T12:01:00.000Z",
      lastSeen: "2026-06-15T12:03:00.000Z",
      status: "active",
      branch: "feature/client"
    }
  ],
  editLocks: [],
  unpushedDeltas: [],
  recentPushes: [],
  recentRepoEvents: [],
  resolutions: [],
  sessionSummaries: [],
  conflictFeedback: []
};

test("no contention creates exact session to server and server to symbol edges", () => {
  const state: TeamState = {
    ...baseState,
    editLocks: [
      {
        sessionId: "s1",
        symbolId: { raw: "src/api.ts#loadRoom" },
        filePath: "src/api.ts",
        acquiredAt: "2026-06-15T12:02:00.000Z",
        ttlSec: 120
      },
      {
        sessionId: "s2",
        symbolId: { raw: "src/client.ts#renderRoom" },
        filePath: "src/client.ts",
        acquiredAt: "2026-06-15T12:02:00.000Z",
        ttlSec: 120
      }
    ]
  };

  assert.deepEqual(deriveContestedSymbols(state), new Set());
  assert.deepEqual(deriveGraph(state), {
    sessions: state.sessions,
    symbols: ["src/api.ts#loadRoom", "src/client.ts#renderRoom"],
    edges: [
      { from: "s1", to: "server", contested: false },
      { from: "s2", to: "server", contested: false },
      { from: "server", to: "src/api.ts#loadRoom", contested: false },
      { from: "server", to: "src/client.ts#renderRoom", contested: false }
    ]
  });
});

test("contested lock plus delta marks the server to symbol edge", () => {
  const state: TeamState = {
    ...baseState,
    editLocks: [
      {
        sessionId: "s1",
        symbolId: { raw: "src/api.ts#loadRoom" },
        filePath: "src/api.ts",
        acquiredAt: "2026-06-15T12:02:00.000Z",
        ttlSec: 120
      }
    ],
    unpushedDeltas: [
      {
        id: "d1",
        repoId: "demo/playground",
        sessionId: "s2",
        symbolId: { raw: "src/api.ts#loadRoom" },
        changeKind: "signature_changed",
        before: null,
        after: null,
        summary: "Return room health with members",
        filePath: "src/api.ts",
        baseSha: "abc123",
        dependents: [],
        createdAt: "2026-06-15T12:02:30.000Z",
        pushedAt: null
      }
    ]
  };

  assert.deepEqual(deriveContestedSymbols(state), new Set(["src/api.ts#loadRoom"]));
  assert.deepEqual(
    deriveGraph(state).edges.find((edge) => edge.from === "server" && edge.to === "src/api.ts#loadRoom"),
    { from: "server", to: "src/api.ts#loadRoom", contested: true }
  );
});

test("ended sessions are excluded from graph and contention", () => {
  const state: TeamState = {
    ...baseState,
    sessions: [
      baseState.sessions[0],
      {
        ...baseState.sessions[1],
        status: "ended"
      }
    ],
    editLocks: [
      {
        sessionId: "s1",
        symbolId: { raw: "src/api.ts#loadRoom" },
        filePath: "src/api.ts",
        acquiredAt: "2026-06-15T12:02:00.000Z",
        ttlSec: 120
      },
      {
        sessionId: "s2",
        symbolId: { raw: "src/api.ts#loadRoom" },
        filePath: "src/api.ts",
        acquiredAt: "2026-06-15T12:02:00.000Z",
        ttlSec: 120
      }
    ]
  };

  const graph = deriveGraph(state);
  assert.deepEqual(deriveContestedSymbols(state), new Set());
  assert.deepEqual(graph.sessions, [baseState.sessions[0]]);
  assert.equal(graph.edges.some((edge) => edge.from === "s2" && edge.to === "server"), false);
  assert.deepEqual(graph.edges, [
    { from: "s1", to: "server", contested: false },
    { from: "server", to: "src/api.ts#loadRoom", contested: false }
  ]);
});
