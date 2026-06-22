import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContractDelta, ResolutionProposal } from "@synapse/protocol";
import {
  affectedSitesFromDelta,
  applyMediatorResolutionProse,
  buildMechanicalDirections,
  buildMediatorResolutionRequest,
  classifyCollision
} from "./mediator.js";

const keepDelta: ContractDelta = {
  id: "delta-1",
  repoId: "local",
  sessionId: "alice",
  symbolId: { raw: "ts:src/auth/token.ts#getUser" },
  changeKind: "signature_changed",
  before: { params: [], returns: "User", raw: "() => User" },
  after: { params: [], returns: "User | null", raw: "() => User | null" },
  summary: "getUser can return null",
  filePath: "src/auth/token.ts",
  baseSha: "abc123",
  dependents: [{ raw: "ts:src/routes/me.ts#handleMe" }, { raw: "ts:src/audit/log.ts#writeAudit" }],
  createdAt: "2026-06-17T00:00:00.000Z",
  pushedAt: null
};

const adaptDelta: ContractDelta = {
  ...keepDelta,
  id: "delta-2",
  sessionId: "bob",
  summary: "handle nullable user",
  filePath: "src/routes/me.ts",
  dependents: [],
  createdAt: "2026-06-17T00:01:00.000Z"
};

test("affectedSitesFromDelta derives file paths from dependent symbols", () => {
  assert.deepEqual(affectedSitesFromDelta(keepDelta), [
    { symbolId: { raw: "ts:src/routes/me.ts#handleMe" }, filePath: "src/routes/me.ts" },
    { symbolId: { raw: "ts:src/audit/log.ts#writeAudit" }, filePath: "src/audit/log.ts" }
  ]);
});

test("buildMechanicalDirections yields keep and adapt directions", () => {
  const directions = buildMechanicalDirections("alice", "bob", keepDelta);

  assert.deepEqual(directions, [
    {
      sessionId: "alice",
      role: "keep",
      summary: "Keep your change to ts:src/auth/token.ts#getUser.",
      affectedSites: []
    },
    {
      sessionId: "bob",
      role: "adapt",
      summary: "Update 2 call-site(s) to match ts:src/auth/token.ts#getUser's new signature.",
      affectedSites: [
        { symbolId: { raw: "ts:src/routes/me.ts#handleMe" }, filePath: "src/routes/me.ts" },
        { symbolId: { raw: "ts:src/audit/log.ts#writeAudit" }, filePath: "src/audit/log.ts" }
      ]
    }
  ]);
});

test("classifyCollision treats a single-sided contract change as mechanical", () => {
  assert.equal(classifyCollision(keepDelta, undefined), "mechanical");
});

test("classifyCollision treats identical after-signatures as mechanical", () => {
  const adaptDelta: ContractDelta = {
    ...keepDelta,
    id: "delta-2",
    sessionId: "bob",
    after: { params: [], returns: "User | null", raw: "() => User | null" }
  };

  assert.equal(classifyCollision(keepDelta, adaptDelta), "mechanical");
});

test("classifyCollision treats divergent after-signatures as semantic", () => {
  const adaptDelta: ContractDelta = {
    ...keepDelta,
    id: "delta-3",
    sessionId: "bob",
    after: {
      params: [{ name: "strict", type: "boolean", optional: false }],
      returns: "User",
      raw: "(strict: boolean) => User"
    }
  };

  assert.equal(classifyCollision(keepDelta, adaptDelta), "semantic");
});

test("buildMechanicalDirections puts winner call-sites on the loser's adapt direction", () => {
  const directions = buildMechanicalDirections("winner", "loser", keepDelta);
  const winner = directions.find((direction) => direction.sessionId === "winner");
  const loser = directions.find((direction) => direction.sessionId === "loser");

  assert.equal(winner?.role, "keep");
  assert.deepEqual(winner?.affectedSites, []);
  assert.equal(loser?.role, "adapt");
  assert.deepEqual(loser?.affectedSites, affectedSitesFromDelta(keepDelta));
});

test("applyMediatorResolutionProse with no prose preserves deterministic directions", () => {
  const proposal = mechanicalProposal();
  const original = structuredClone(proposal.directions);
  const request = buildMediatorResolutionRequest(proposal, keepDelta, adaptDelta);
  assert.ok(request);

  assert.equal(applyMediatorResolutionProse(proposal, request, null), false);
  assert.deepEqual(proposal.directions, original);
});

test("buildMediatorResolutionRequest contains only deterministic proposal facts", async () => {
  const proposal = mechanicalProposal();
  const request = buildMediatorResolutionRequest(proposal, keepDelta, adaptDelta);
  assert.ok(request);

  let received: typeof request | null = null;
  await {
    proposeResolution: async (candidate: typeof request) => {
      received = candidate;
      return { adaptSummary: validAdaptSummary() };
    }
  }.proposeResolution(request);

  assert.deepEqual(received, {
    proposalId: proposal.id,
    symbol: "ts:src/auth/token.ts#getUser",
    conflictClass: "mechanical",
    keep: {
      sessionId: "alice",
      before: "() => User",
      after: "() => User | null",
      filePath: "src/auth/token.ts",
      summary: "getUser can return null"
    },
    adapt: {
      sessionId: "bob",
      before: "() => User",
      after: "() => User | null",
      filePath: "src/routes/me.ts",
      summary: "handle nullable user"
    },
    affectedSites: [
      { symbolId: { raw: "ts:src/routes/me.ts#handleMe" }, filePath: "src/routes/me.ts" },
      { symbolId: { raw: "ts:src/audit/log.ts#writeAudit" }, filePath: "src/audit/log.ts" }
    ],
    deterministicSummary:
      "Update 2 call-site(s) to match ts:src/auth/token.ts#getUser's new signature."
  });
});

test("valid mediator prose updates only the adapt direction summary", () => {
  const proposal = mechanicalProposal();
  const request = buildMediatorResolutionRequest(proposal, keepDelta, adaptDelta);
  assert.ok(request);
  const keepSummary = proposal.directions[0]?.summary;

  assert.equal(
    applyMediatorResolutionProse(proposal, request, { adaptSummary: validAdaptSummary() }),
    true
  );

  assert.equal(proposal.directions[0]?.summary, keepSummary);
  assert.equal(proposal.directions[1]?.summary, validAdaptSummary());
});

test("mediator prose with an invented call-site file path is rejected", () => {
  const proposal = mechanicalProposal();
  const request = buildMediatorResolutionRequest(proposal, keepDelta, adaptDelta);
  assert.ok(request);
  const deterministicSummary = proposal.directions[1]?.summary;

  assert.equal(
    applyMediatorResolutionProse(proposal, request, {
      adaptSummary: `${validAdaptSummary()} Do not touch src/admin/debug.ts.`
    }),
    false
  );

  assert.equal(proposal.directions[1]?.summary, deterministicSummary);
});

test("mediator prose with a path fragment that only substring-matches an allowed id is rejected", () => {
  const proposal = mechanicalProposal();
  const request = buildMediatorResolutionRequest(proposal, keepDelta, adaptDelta);
  assert.ok(request);
  const deterministicSummary = proposal.directions[1]?.summary;

  // "auth/token" sits inside the allowed id ts:src/auth/token.ts#getUser but is
  // not a real referenced path; the old substring grounding let it through.
  assert.equal(
    applyMediatorResolutionProse(proposal, request, {
      adaptSummary: `${validAdaptSummary()} Also rewrite auth/token internals.`
    }),
    false
  );

  assert.equal(proposal.directions[1]?.summary, deterministicSummary);
});

test("mediator prose with an invented signature snippet is rejected", () => {
  const proposal = mechanicalProposal();
  const request = buildMediatorResolutionRequest(proposal, keepDelta, adaptDelta);
  assert.ok(request);
  const deterministicSummary = proposal.directions[1]?.summary;

  assert.equal(
    applyMediatorResolutionProse(proposal, request, {
      adaptSummary: `${validAdaptSummary()} Avoid rewriting it as \`(id: string) => User\`.`
    }),
    false
  );

  assert.equal(proposal.directions[1]?.summary, deterministicSummary);
});

function mechanicalProposal(): ResolutionProposal {
  return {
    id: "rp:ts:src/auth/token.ts#getUser:alice:bob",
    repoId: "local",
    symbol: keepDelta.symbolId,
    conflictClass: "mechanical",
    before: keepDelta.before,
    after: keepDelta.after,
    status: "resolving",
    directions: buildMechanicalDirections("alice", "bob", keepDelta),
    acceptedBy: [],
    createdAt: "2026-06-17T01:00:00.000Z"
  };
}

function validAdaptSummary(): string {
  return "Update ts:src/auth/token.ts#getUser callers in src/routes/me.ts and src/audit/log.ts to handle () => User | null.";
}
