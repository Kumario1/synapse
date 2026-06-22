import assert from "node:assert/strict";
import test from "node:test";
import type { ContractDelta, SymbolId } from "@synapse/protocol";
import type { RuntimeConfig } from "./config.js";
import { deterministicSessionSummary, makeSession, summaryDeltaFor } from "./session-summary.js";

const config = {
  repoId: "repo",
  sessionId: "sess",
  member: "alice",
  agentType: "other",
  worktreeRoot: "/nonexistent-worktree-root-for-test"
} as unknown as RuntimeConfig;

const sym = (raw: string): SymbolId => ({ raw });

function delta(raw: string, overrides: Partial<ContractDelta> = {}): ContractDelta {
  return {
    id: `id-${raw}`,
    repoId: "repo",
    sessionId: "sess",
    symbolId: sym(raw),
    changeKind: "signature_changed",
    before: null,
    after: null,
    summary: `Changed ${raw}`,
    filePath: "src/a.ts",
    baseSha: "local",
    dependents: [],
    createdAt: "2026-06-22T00:00:00.000Z",
    pushedAt: null,
    ...overrides
  };
}

test("deterministicSessionSummary reports the no-change case with the task suffix", () => {
  assert.equal(
    deterministicSessionSummary("alice", "ship auth", []),
    "alice's session ended with no contract changes. Task: ship auth."
  );
});

test("deterministicSessionSummary omits the task suffix when task is null", () => {
  assert.equal(
    deterministicSessionSummary("alice", null, []),
    "alice's session ended with no contract changes."
  );
});

test("deterministicSessionSummary names the symbol tail and pluralizes", () => {
  const summary = deterministicSessionSummary("alice", null, [
    delta("ts:src/a.ts#foo", { filePath: "src/a.ts" }),
    delta("ts:src/b.ts#bar", { filePath: "src/b.ts" })
  ]);
  assert.ok(summary.startsWith("alice's session changed 2 contracts across 2 files: "));
  assert.ok(summary.includes("foo (signature_changed)"));
  assert.ok(summary.includes("bar (signature_changed)"));
});

test("deterministicSessionSummary shows a before -> after shape when both signatures exist", () => {
  const summary = deterministicSessionSummary("bob", null, [
    delta("ts:src/a.ts#foo", {
      before: { params: [], returns: null, raw: "foo(): void" },
      after: { params: [], returns: null, raw: "foo(x: number): void" }
    })
  ]);
  assert.ok(summary.includes("foo (signature_changed: foo(): void -> foo(x: number): void)"));
});

test("deterministicSessionSummary caps the list at five and appends a +N more", () => {
  const deltas = Array.from({ length: 7 }, (_unused, i) => delta(`ts:src/a.ts#fn${i}`));
  const summary = deterministicSessionSummary("alice", null, deltas);
  assert.ok(summary.includes("+2 more"));
});

test("summaryDeltaFor projects the LLM-facing delta view", () => {
  const view = summaryDeltaFor(
    delta("ts:src/a.ts#foo", {
      before: { params: [], returns: null, raw: "foo(): void" },
      after: { params: [], returns: null, raw: "foo(x: number): void" },
      summary: "added a param"
    })
  );
  assert.deepEqual(view, {
    symbol: "ts:src/a.ts#foo",
    changeKind: "signature_changed",
    before: "foo(): void",
    after: "foo(x: number): void",
    summary: "added a param"
  });
});

test("makeSession seeds an active session from the runtime config", () => {
  const session = makeSession(config, "ship auth");
  assert.equal(session.id, "sess");
  assert.equal(session.repoId, "repo");
  assert.equal(session.memberId, "alice");
  assert.equal(session.lastTask, "ship auth");
  assert.equal(session.status, "active");
  assert.deepEqual(session.filesOpen, []);
  assert.equal(session.startedAt, session.lastSeen);
});

test("makeSession defaults lastTask to null", () => {
  assert.equal(makeSession(config).lastTask, null);
});
