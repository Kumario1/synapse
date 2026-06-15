import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateConflicts } from "@synapse/conflict-engine";
import { diffTypeScriptContracts, extractTypeScriptContracts } from "@synapse/analyzer-ts";

// Measures per-rule precision/recall of the conflict engine's seven rules
// against a corpus of scenarios (state-built or real TS source), and gates
// CI against a committed baseline (evals/detection-baseline.json) that can
// only move via deliberate `--write-baseline` runs.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = join(rootDir, "evals/detection-corpus");
const defaultBaselinePath = join(rootDir, "evals/detection-baseline.json");
const { baselinePath, writeBaseline } = parseArgs(process.argv.slice(2));

runSelfTest();

const corpusFiles = (await readdir(corpusDir)).filter((name) => name.endsWith(".json")).sort();
const scenarios = [];
for (const file of corpusFiles) {
  const entries = JSON.parse(await readFile(join(corpusDir, file), "utf8"));
  for (const entry of entries) {
    scenarios.push({ ...entry, _file: file });
  }
}

const scenarioNameCounts = new Map();
for (const scenario of scenarios) {
  scenarioNameCounts.set(scenario.name, (scenarioNameCounts.get(scenario.name) ?? 0) + 1);
}
const duplicateScenarioNames = [...scenarioNameCounts.entries()]
  .filter(([, count]) => count > 1)
  .map(([name]) => name);

let skipped = 0;
const results = [];
for (const scenario of scenarios) {
  if (scenario.skip) {
    skipped += 1;
    continue;
  }

  const conflicts =
    scenario.type === "source" ? evaluateSourceScenario(scenario) : evaluateStateScenario(scenario);

  results.push({
    name: scenario.name,
    flagged: new Set(conflicts.map((conflict) => conflict.rule)),
    expected: new Set(scenario.expected.rules)
  });
}

const metrics = scoreResults(results);
printTable(metrics, scenarios.length, skipped);

const preflightFailures = [];
if (skipped > 0) {
  preflightFailures.push(`skipped scenarios are not allowed in detection evals (skipped=${skipped})`);
}
if (duplicateScenarioNames.length > 0) {
  preflightFailures.push(`duplicate scenario names: ${duplicateScenarioNames.join(", ")}`);
}

if (writeBaseline) {
  if (preflightFailures.length > 0) {
    for (const failure of preflightFailures) {
      console.error(failure);
    }
    process.exit(1);
  }

  const baseline = {
    generatedAt: new Date().toISOString(),
    corpusSize: scenarios.length,
    rules: metrics
  };
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nWrote ${baselinePath} (${scenarios.length} scenarios).`);
  process.exit(0);
}

const baselineText = await readFile(baselinePath, "utf8").catch(() => null);
if (baselineText === null) {
  console.error(`\nMissing detection baseline at ${baselinePath}; run with --write-baseline to update ${defaultBaselinePath}.`);
  process.exit(1);
}

const baseline = JSON.parse(baselineText);
const allRules = new Set([...Object.keys(metrics), ...Object.keys(baseline.rules)]);
let failed = preflightFailures.length > 0;

for (const failure of preflightFailures) {
  console.error(failure);
}

if (scenarios.length !== baseline.corpusSize) {
  console.error(`corpus size changed: baseline ${baseline.corpusSize}, current ${scenarios.length}; run --write-baseline deliberately`);
  failed = true;
}

for (const rule of allRules) {
  if (!(rule in baseline.rules)) {
    console.error(`new rule ${rule}: run --write-baseline deliberately`);
    failed = true;
    continue;
  }

  if (!(rule in metrics)) {
    console.error(`rule ${rule} missing from this run (present in baseline): run --write-baseline deliberately`);
    failed = true;
    continue;
  }

  const base = baseline.rules[rule];
  const current = metrics[rule];

  if (current.tp < base.tp) {
    console.error(`regression on ${rule}: tp ${base.tp} -> ${current.tp}`);
    failed = true;
  }

  if (current.fp > base.fp) {
    console.error(`regression on ${rule}: fp ${base.fp} -> ${current.fp}`);
    failed = true;
  }

  if (current.fn > base.fn) {
    console.error(`regression on ${rule}: fn ${base.fn} -> ${current.fn}`);
    failed = true;
  }

  if (current.precision < base.precision) {
    console.error(
      `regression on ${rule}: precision ${base.precision} -> ${current.precision} (tp=${current.tp} fp=${current.fp})`
    );
    failed = true;
  }

  if (current.recall < base.recall) {
    console.error(
      `regression on ${rule}: recall ${base.recall} -> ${current.recall} (tp=${current.tp} fn=${current.fn})`
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log(`\nDetection eval passed: ${scenarios.length} scenarios (${skipped} skipped), baseline holds.`);

function parseArgs(args) {
  let baselinePath = defaultBaselinePath;
  let writeBaseline = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--strict") {
      continue;
    }
    if (arg === "--write-baseline") {
      writeBaseline = true;
      continue;
    }
    if (arg === "--baseline") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        console.error("--baseline requires a path");
        process.exit(1);
      }
      baselinePath = value;
      index += 1;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }

  if (writeBaseline && baselinePath !== defaultBaselinePath) {
    console.error("--write-baseline always updates evals/detection-baseline.json; do not combine it with --baseline");
    process.exit(1);
  }

  return { baselinePath, writeBaseline };
}

function evaluateStateScenario(scenario) {
  const state = stateFor(scenario);
  return evaluateConflicts({
    selfSessionId: scenario.selfSessionId,
    targets: scenario.targets.map((target) => ({
      filePath: target.filePath,
      symbolId: symbol(target.symbol)
    })),
    state,
    graph: graphFor(scenario.dependencies ?? {})
  });
}

function evaluateSourceScenario(scenario) {
  const deltas = [];

  for (const [filePath, versions] of Object.entries(scenario.files)) {
    const before = extractTypeScriptContracts({ filePath, source: versions.before }).symbols;
    const after = extractTypeScriptContracts({ filePath, source: versions.after }).symbols;

    for (const change of diffTypeScriptContracts(before, after)) {
      deltas.push({
        id: `${filePath}#${change.symbolId.raw}`,
        repoId: "local",
        sessionId: "alice",
        symbolId: change.symbolId,
        changeKind: change.changeKind,
        before: change.before?.signature ?? null,
        after: change.after?.signature ?? null,
        summary: `${change.changeKind} ${change.symbolId.raw}`,
        filePath,
        baseSha: "local",
        dependents: [],
        createdAt: timestamp(0),
        pushedAt: null
      });
    }
  }

  const state = {
    repoId: "local",
    sessions: [sessionFor("alice"), sessionFor("bob")],
    editLocks: [],
    unpushedDeltas: deltas,
    recentPushes: [],
    recentRepoEvents: [],
    resolutions: [],
    sessionSummaries: [],
    conflictFeedback: []
  };

  return evaluateConflicts({
    selfSessionId: "bob",
    targets: [
      {
        filePath: scenario.checkTarget.filePath,
        symbolId: symbol(scenario.checkTarget.symbol)
      }
    ],
    state,
    graph: graphFor(scenario.dependencies ?? {})
  });
}

// Per rule R over the whole corpus: TP += 1 if R is in both flagged and
// expected for a scenario, FP += 1 if R is flagged-only, FN += 1 if R is
// expected-only. precision/recall are 1.0 when their denominator is 0.
function scoreResults(results) {
  const rules = new Set();
  for (const result of results) {
    for (const rule of result.flagged) {
      rules.add(rule);
    }
    for (const rule of result.expected) {
      rules.add(rule);
    }
  }

  const metrics = {};
  for (const rule of rules) {
    let tp = 0;
    let fp = 0;
    let fn = 0;

    for (const result of results) {
      const inFlagged = result.flagged.has(rule);
      const inExpected = result.expected.has(rule);

      if (inFlagged && inExpected) {
        tp += 1;
      } else if (inFlagged && !inExpected) {
        fp += 1;
      } else if (!inFlagged && inExpected) {
        fn += 1;
      }
    }

    metrics[rule] = {
      tp,
      fp,
      fn,
      precision: tp + fp === 0 ? 1 : tp / (tp + fp),
      recall: tp + fn === 0 ? 1 : tp / (tp + fn)
    };
  }

  return metrics;
}

function printTable(metrics, total, skipped) {
  console.log(`Detection benchmark: ${total} scenarios (${skipped} skipped)\n`);
  console.log("rule".padEnd(24), "tp".padStart(4), "fp".padStart(4), "fn".padStart(4), "precision".padStart(10), "recall".padStart(10));

  let micro = { tp: 0, fp: 0, fn: 0 };
  for (const rule of Object.keys(metrics).sort()) {
    const m = metrics[rule];
    micro.tp += m.tp;
    micro.fp += m.fp;
    micro.fn += m.fn;
    console.log(
      rule.padEnd(24),
      String(m.tp).padStart(4),
      String(m.fp).padStart(4),
      String(m.fn).padStart(4),
      m.precision.toFixed(3).padStart(10),
      m.recall.toFixed(3).padStart(10)
    );
  }

  const microPrecision = micro.tp + micro.fp === 0 ? 1 : micro.tp / (micro.tp + micro.fp);
  const microRecall = micro.tp + micro.fn === 0 ? 1 : micro.tp / (micro.tp + micro.fn);
  console.log(
    "TOTAL (micro-avg)".padEnd(24),
    String(micro.tp).padStart(4),
    String(micro.fp).padStart(4),
    String(micro.fn).padStart(4),
    microPrecision.toFixed(3).padStart(10),
    microRecall.toFixed(3).padStart(10)
  );
}

// Three cases exercising the TP/FP/FN/precision/recall math before it runs
// against any real scenario: a perfect match, a flagged-only rule (FP), and
// an expected-only rule (FN).
function runSelfTest() {
  const perfect = scoreResults([{ flagged: new Set(["dependency_changed"]), expected: new Set(["dependency_changed"]) }]);
  assert.deepEqual(perfect.dependency_changed, { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 });

  const withFalsePositive = scoreResults([
    { flagged: new Set(["dependency_changed", "stale_base"]), expected: new Set(["dependency_changed"]) }
  ]);
  assert.deepEqual(withFalsePositive.dependency_changed, { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 });
  assert.deepEqual(withFalsePositive.stale_base, { tp: 0, fp: 1, fn: 0, precision: 0, recall: 1 });

  const withFalseNegative = scoreResults([
    { flagged: new Set(["dependency_changed"]), expected: new Set(["dependency_changed", "transitive_dependency"]) }
  ]);
  assert.deepEqual(withFalseNegative.dependency_changed, { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 });
  assert.deepEqual(withFalseNegative.transitive_dependency, { tp: 0, fp: 0, fn: 1, precision: 1, recall: 0 });
}

// --- helpers copied from scripts/eval-conflicts.mjs ---

function stateFor(scenario) {
  const repoId = scenario.repoId ?? "local";
  return {
    repoId,
    sessions: (scenario.sessions ?? [])
      .map((session) => sessionFor(session, repoId))
      .filter((session) => session.repoId === repoId),
    editLocks: (scenario.editLocks ?? []).map((lock, index) => ({
      sessionId: lock.sessionId,
      repoId: lock.repoId ?? repoId,
      symbolId: symbol(lock.symbol),
      filePath: lock.filePath,
      acquiredAt: lock.acquiredAt ?? activeLockTimestamp(),
      ttlSec: lock.ttlSec ?? 90
    })).filter((lock) => lock.repoId === repoId),
    unpushedDeltas: (scenario.deltas ?? [])
      .map((delta, index) => deltaFor(delta, index, repoId))
      .filter((delta) => delta.repoId === repoId),
    recentPushes: (scenario.recentPushes ?? []).map((push, index) => ({
      id: push.id ?? `push-${index}`,
      repoId: push.repoId ?? repoId,
      memberId: push.memberId,
      summary: push.summary,
      filesAffected: push.filesAffected,
      symbols: push.symbols?.map(symbol),
      sha: push.sha,
      pushedAt: push.pushedAt ?? timestamp(index)
    })).filter((push) => push.repoId === repoId),
    recentRepoEvents: [],
    resolutions: [],
    sessionSummaries: [],
    conflictFeedback: []
  };
}

function sessionFor(input, repoId = "local") {
  const id = typeof input === "string" ? input : input.id;
  return {
    id,
    repoId: typeof input === "string" ? repoId : input.repoId ?? repoId,
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

function deltaFor(input, index, repoId = "local") {
  return {
    id: input.id ?? `${input.sessionId}-${index}`,
    repoId: input.repoId ?? repoId,
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

function activeLockTimestamp() {
  return new Date().toISOString();
}
