import assert from "node:assert/strict";
import test from "node:test";
import type { ResolutionProposal, TeamState } from "@synapse/protocol";
import { deriveContestedSymbols, deriveGraph, deriveResolutionOverview } from "./derive";

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
  resolutionProposals: [],
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

test("deriveResolutionOverview groups resolving, resolved, and escalated proposals", () => {
  const resolving = proposal("p1", "resolving");
  const resolved = proposal("p2", "resolved");
  const awaitingOwner = proposal("p3", "awaiting_owner");
  const voided = proposal("p4", "voided");
  const overview = deriveResolutionOverview({
    ...baseState,
    resolutionProposals: [resolving, resolved, awaitingOwner, voided]
  });

  assert.deepEqual(overview.resolving, [resolving]);
  assert.deepEqual(overview.resolved, [resolved]);
  assert.deepEqual(overview.escalated, [awaitingOwner, voided]);
});

function proposal(id: string, status: ResolutionProposal["status"]): ResolutionProposal {
  return {
    id,
    repoId: baseState.repoId,
    symbol: { raw: `src/api.ts#${id}` },
    conflictClass: status === "awaiting_owner" ? "semantic" : "mechanical",
    before: null,
    after: status === "awaiting_owner" ? null : { params: [], returns: "Room", raw: "() => Room" },
    status,
    candidates: status === "awaiting_owner" ? ["s1", "s2"] : undefined,
    directions:
      status === "awaiting_owner"
        ? []
        : [
            { sessionId: "s1", role: "keep", summary: "Keep the contract.", affectedSites: [] },
            { sessionId: "s2", role: "adapt", summary: "Adapt callers.", affectedSites: [] }
          ],
    acceptedBy: status === "resolved" ? ["s1", "s2"] : [],
    voidReason: status === "voided" ? "timeout" : undefined,
    createdAt: "2026-06-15T12:03:00.000Z"
  };
}
