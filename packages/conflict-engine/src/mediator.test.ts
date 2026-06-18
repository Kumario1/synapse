import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContractDelta } from "@synapse/protocol";
import {
  affectedSitesFromDelta,
  buildMechanicalDirections,
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
