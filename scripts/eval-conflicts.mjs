import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateConflicts, verdictFor } from "@synapse/conflict-engine";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioPath = join(rootDir, "evals/conflict-scenarios.json");
const scenarios = JSON.parse(await readFile(scenarioPath, "utf8"));

let passed = 0;
const results = [];

for (const scenario of scenarios) {
  const state = stateFor(scenario);
  const conflicts = evaluateConflicts({
    selfSessionId: scenario.selfSessionId,
    targets: scenario.targets.map((target) => ({
      filePath: target.filePath,
      symbolId: symbol(target.symbol)
    })),
    state,
    graph: graphFor(scenario.dependencies ?? {})
  });
  const verdict = verdictFor(conflicts);

  assert.equal(verdict, scenario.expected.verdict, `${scenario.name}: verdict`);
  assert.deepEqual(
    conflicts.map((conflict) => conflict.rule),
    scenario.expected.rules,
    `${scenario.name}: rules`
  );

  for (const expected of scenario.expected.conflicts ?? []) {
    const conflict = conflicts.find((candidate) => candidate.rule === expected.rule);
    assert.ok(conflict, `${scenario.name}: missing ${expected.rule}`);
    assert.equal(conflict.severity, expected.severity, `${scenario.name}: severity`);

    if (expected.compatibility) {
      assert.equal(
        conflict.change?.compatibility,
        expected.compatibility,
        `${scenario.name}: compatibility`
      );
    }

    if (expected.recommendation) {
      assert.equal(
        conflict.analysis?.recommendation,
        expected.recommendation,
        `${scenario.name}: analysis recommendation`
      );
    }

    if (expected.selfAfter) {
      assert.equal(conflict.selfChange?.after?.raw, expected.selfAfter, `${scenario.name}: selfAfter`);
    }

    if (expected.resolution) {
      const resolution = conflict.analysis?.resolution;
      assert.ok(resolution, `${scenario.name}: missing resolution`);
      assert.equal(
        resolution.reconciled,
        expected.resolution.reconciled,
        `${scenario.name}: resolution reconciled`
      );
      assert.equal(
        resolution.recommendation,
        expected.resolution.recommendation,
        `${scenario.name}: resolution recommendation`
      );
      assert.equal(
        resolution.proposedContract,
        expected.resolution.proposedContract,
        `${scenario.name}: resolution proposed contract`
      );
    }
  }

  passed += 1;
  results.push({
    name: scenario.name,
    verdict,
    rules: conflicts.map((conflict) => conflict.rule),
    recommendations: conflicts.map((conflict) => conflict.analysis?.recommendation ?? null)
  });
}

console.log("Conflict eval passed:");
console.log(JSON.stringify({ passed, total: scenarios.length, results }, null, 2));

function stateFor(scenario) {
  return {
    repoId: "local",
    sessions: (scenario.sessions ?? []).map(sessionFor),
    editLocks: (scenario.editLocks ?? []).map((lock, index) => ({
      sessionId: lock.sessionId,
      symbolId: symbol(lock.symbol),
      filePath: lock.filePath,
      acquiredAt: lock.acquiredAt ?? timestamp(index),
      ttlSec: lock.ttlSec ?? 90
    })),
    unpushedDeltas: (scenario.deltas ?? []).map(deltaFor),
    recentPushes: (scenario.recentPushes ?? []).map((push, index) => ({
      id: push.id ?? `push-${index}`,
      repoId: "local",
      memberId: push.memberId,
      summary: push.summary,
      filesAffected: push.filesAffected,
      symbols: push.symbols?.map(symbol),
      sha: push.sha,
      pushedAt: push.pushedAt ?? timestamp(index)
    })),
    resolutions: []
  };
}

function sessionFor(input) {
  const id = typeof input === "string" ? input : input.id;
  return {
    id,
    repoId: "local",
    memberId: id,
    memberLogin: typeof input === "string" ? id : input.memberLogin ?? id,
    agentType: typeof input === "string" ? "other" : input.agentType ?? "other",
    filesOpen: typeof input === "string" ? [] : input.filesOpen ?? [],
    filesEditing: typeof input === "string" ? [] : input.filesEditing ?? [],
    lastTask: typeof input === "string" ? null : input.lastTask ?? null,
    startedAt: typeof input === "string" ? timestamp(0) : input.startedAt ?? timestamp(0),
    lastSeen: typeof input === "string" ? timestamp(0) : input.lastSeen ?? timestamp(0),
    status: typeof input === "string" ? "active" : input.status ?? "active"
  };
}

function deltaFor(input, index) {
  return {
    id: input.id ?? `${input.sessionId}-${index}`,
    repoId: "local",
    sessionId: input.sessionId,
    symbolId: symbol(input.symbol),
    changeKind: input.changeKind ?? "signature_changed",
    before: input.before ?? null,
    after: input.after ?? null,
    summary: input.summary,
    filePath: input.filePath,
    baseSha: input.baseSha ?? "local",
    dependents: (input.dependents ?? []).map(symbol),
    createdAt: input.createdAt ?? timestamp(index),
    pushedAt: input.pushedAt ?? null
  };
}

function graphFor(dependencies) {
  return {
    dependenciesOf(symbolId) {
      return (dependencies[symbolId.raw] ?? []).map((hop) => ({
        symbolId: symbol(hop.symbol),
        hops: hop.hops
      }));
    }
  };
}

function symbol(raw) {
  return { raw };
}

function timestamp(index) {
  return new Date(Date.UTC(2026, 5, 8, 0, 0, index)).toISOString();
}
