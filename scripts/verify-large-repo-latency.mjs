import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const demoRoot = await mkdtemp(join(tmpdir(), "synapse-large-latency-"));
const aliceRoot = join(demoRoot, "alice");
const bobRoot = join(demoRoot, "bob");

const tokenFile = "src/auth/token.ts";
const validateSymbol = "ts:src/auth/token.ts#validate";
const featureCount = 180;
const targetFeatureIndex = featureCount - 1;
const targetFile = featureFile(targetFeatureIndex);
const targetSymbol = `ts:${targetFile}#${featureName(targetFeatureIndex)}`;
const warmupIterations = 10;
const measuredIterations = 60;
const coldMaxBudgetMs = 2500;
const p95BudgetMs = 50;
const maxBudgetMs = 150;

try {
  await writeLargeRepo(aliceRoot, baselineTokenSource());
  await writeLargeRepo(bobRoot, baselineTokenSource());

  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startDaemon("alice", alicePort, aliceRoot);
  startDaemon("bob", bobPort, bobRoot);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2);

  const coldStart = performance.now();
  const coldCheck = await checkTargetFile(bobPort);
  const coldFirstCheckMs = round(performance.now() - coldStart);
  assert.equal(coldCheck.verdict, "none");
  assert.equal(coldCheck.degraded, false);
  assert.ok(
    coldFirstCheckMs <= coldMaxBudgetMs,
    `large-repo cold first check ${coldFirstCheckMs}ms exceeded ${coldMaxBudgetMs}ms`
  );

  await warmCheck(bobPort);
  const noConflict = await measureChecks(bobPort, "none");
  assert.equal(noConflict.last.verdict, "none");
  assertLatencyBudget("large-repo warm no-conflict file-only check", noConflict);

  await report(alicePort, tokenFile);
  await writeFile(join(aliceRoot, tokenFile), `${changedTokenSource().trim()}\n`);
  await report(alicePort, tokenFile);
  await waitForState(serverPort, (state) =>
    state.unpushedDeltas.some((delta) => delta.symbolId.raw === validateSymbol)
  );
  await waitForDaemonState(bobPort, (state) =>
    state.unpushedDeltas.some((delta) => delta.symbolId.raw === validateSymbol)
  );

  await warmCheck(bobPort);
  const dependencyConflict = await measureChecks(bobPort, "warn");
  assert.equal(dependencyConflict.last.verdict, "warn");
  assert.deepEqual(
    dependencyConflict.last.conflicts.map((item) => [item.rule, item.targetSymbol.raw]),
    [["dependency_changed", targetSymbol]]
  );
  assertLatencyBudget("large-repo warm dependency-warning file-only check", dependencyConflict);

  // Warm-check graph cache (plan 007): once the watcher is ready and a check
  // has validated the cached graph, subsequent warm checks reuse it without
  // re-fingerprinting (counter increments); a watcher-observed source change
  // invalidates it (the next check rebuilds — no hit), then reuse resumes.
  await waitFor(async () => (await fetchMetric(bobPort, "synapse_watch_ready")) >= 1, 10000);
  await checkTargetFile(bobPort); // fingerprint-validates → cache marked clean
  const hitsBefore = await fetchMetric(bobPort, "synapse_graph_cache_hits_total");
  await checkTargetFile(bobPort);
  const hitsWarm = await fetchMetric(bobPort, "synapse_graph_cache_hits_total");
  assert.ok(hitsWarm > hitsBefore, `warm check should reuse the clean graph (${hitsBefore} → ${hitsWarm})`);

  const watchReportsBefore = await fetchMetric(bobPort, "synapse_watch_reports_total");
  await writeFileAt(bobRoot, "src/features/invalidator.ts", "export function invalidator(): number { return 1; }");
  await waitFor(
    async () => (await fetchMetric(bobPort, "synapse_watch_reports_total")) > watchReportsBefore,
    10000
  );
  const hitsAfterChange = await fetchMetric(bobPort, "synapse_graph_cache_hits_total");
  const rebuildCheck = await checkTargetFile(bobPort);
  assert.equal(rebuildCheck.verdict, "warn", "post-invalidation check still detects the conflict");
  const hitsOnRebuild = await fetchMetric(bobPort, "synapse_graph_cache_hits_total");
  assert.equal(hitsOnRebuild, hitsAfterChange, "the check after a source change must rebuild, not reuse");
  await checkTargetFile(bobPort);
  const hitsResumed = await fetchMetric(bobPort, "synapse_graph_cache_hits_total");
  assert.ok(hitsResumed > hitsOnRebuild, "reuse resumes once the rebuilt graph is clean again");

  console.log("Large-repo latency verification passed:");
  console.log(
    JSON.stringify(
      {
        sourceFiles: featureCount + 1,
        targetFile,
        budgets: {
          coldMaxMs: coldMaxBudgetMs,
          warmP95Ms: p95BudgetMs,
          warmMaxMs: maxBudgetMs
        },
        iterations: measuredIterations,
        coldFirstCheckMs,
        noConflict: noConflict.stats,
        dependencyConflict: dependencyConflict.stats,
        graphCache: { hitsWarm, rebuildOnChange: hitsOnRebuild === hitsAfterChange, hitsResumed }
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(demoRoot, { recursive: true, force: true });
}

function startDaemon(member, port, worktreeRoot) {
  return startProcess(
    member,
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      member,
      "--session",
      member,
      "--port",
      String(port),
      "--server",
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot
    ],
    {}
  );
}

async function writeLargeRepo(worktreeRoot, tokenSource) {
  await writeFileAt(worktreeRoot, tokenFile, tokenSource);
  for (let index = 0; index < featureCount; index += 1) {
    await writeFileAt(worktreeRoot, featureFile(index), featureSource(index));
  }
}

async function writeFileAt(worktreeRoot, filePath, source) {
  const fullPath = join(worktreeRoot, filePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${source.trim()}\n`);
}

function baselineTokenSource() {
  return `
    export interface Token {
      value: string;
    }

    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `;
}

function changedTokenSource() {
  return `
    export interface Token {
      value: string;
    }

    export function validate(input: string): Token | null {
      return input ? { value: input } : null;
    }
  `;
}

function featureSource(index) {
  const name = featureName(index);
  return `
    import { validate } from "../auth/token";

    export function ${name}(input: string): boolean {
      return validate(input);
    }
  `;
}

function featureFile(index) {
  return `src/features/feature-${String(index).padStart(3, "0")}.ts`;
}

function featureName(index) {
  return `feature${index}`;
}

async function report(port, filePath) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath
  });
}

async function warmCheck(port) {
  for (let index = 0; index < warmupIterations; index += 1) {
    await checkTargetFile(port);
  }
}

async function measureChecks(port, expectedVerdict) {
  const samples = [];
  let last = null;

  for (let index = 0; index < measuredIterations; index += 1) {
    const start = performance.now();
    last = await checkTargetFile(port);
    const elapsed = performance.now() - start;
    assert.equal(last.verdict, expectedVerdict);
    assert.equal(last.degraded, false);
    samples.push(elapsed);
  }

  return { samples, stats: stats(samples), last };
}

async function checkTargetFile(port) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [targetFile]
  });
}

function assertLatencyBudget(label, result) {
  assert.ok(
    result.stats.p95Ms <= p95BudgetMs,
    `${label} p95 ${result.stats.p95Ms}ms exceeded ${p95BudgetMs}ms`
  );
  assert.ok(
    result.stats.maxMs <= maxBudgetMs,
    `${label} max ${result.stats.maxMs}ms exceeded ${maxBudgetMs}ms`
  );
}

function stats(samples) {
  const ordered = [...samples].sort((a, b) => a - b);
  const sum = ordered.reduce((total, value) => total + value, 0);
  return {
    minMs: round(ordered[0]),
    medianMs: round(percentile(ordered, 50)),
    p95Ms: round(percentile(ordered, 95)),
    maxMs: round(ordered[ordered.length - 1]),
    meanMs: round(sum / ordered.length)
  };
}

function percentile(ordered, percentileValue) {
  const index = Math.ceil((percentileValue / 100) * ordered.length) - 1;
  return ordered[Math.max(0, Math.min(ordered.length - 1, index))];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function startProcess(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...env,
      OPENROUTER_API_KEY: "",
      SYNAPSE_LLM_EXPLAIN: "0",
      SYNAPSE_LLM_RESOLVE: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      process.stderr.write(`[${label}] exited with code ${code ?? signal}\n`);
    }
  });

  return child;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function fetchMetric(port, name) {
  const response = await fetch(`http://localhost:${port}/metrics`).catch(() => null);
  if (!response?.ok) {
    return 0;
  }
  const text = await response.text();
  const match = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\d+)`, "m"));
  return match ? Number(match[1]) : 0;
}

async function waitForHttp(url, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function waitForState(port, predicate, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=local`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs);
}

async function waitForDaemonState(port, predicate, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs);
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolvePromise) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolvePromise();
            return;
          }
          child.once("exit", resolvePromise);
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 1000).unref();
        })
    )
  );
}
