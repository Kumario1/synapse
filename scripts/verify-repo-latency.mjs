import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const demoRoot = await mkdtemp(join(tmpdir(), "synapse-repo-latency-"));
const archivePath = join(demoRoot, "repo.tar");
const aliceRoot = join(demoRoot, "alice");
const bobRoot = join(demoRoot, "bob");

const targetFile = "packages/conflict-engine/src/explain.ts";
const targetSymbol = "ts:packages/conflict-engine/src/explain.ts#deterministicAnalysis";
const warmupIterations = 10;
const measuredIterations = 60;
const coldMaxBudgetMs = 7500;
const p95BudgetMs = 50;
const maxBudgetMs = 150;

try {
  const commit = (await run("git", ["rev-parse", "--short", "HEAD"], rootDir)).trim();
  await snapshotRepo();
  const sourceFiles = await countSourceFiles(bobRoot);

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
  const coldCheck = await checkTargetFile(bobPort, "bob");
  const coldFirstCheckMs = round(performance.now() - coldStart);
  assert.equal(coldCheck.verdict, "none");
  assert.equal(coldCheck.degraded, false);
  assert.ok(
    coldFirstCheckMs <= coldMaxBudgetMs,
    `repo cold first check ${coldFirstCheckMs}ms exceeded ${coldMaxBudgetMs}ms`
  );

  await warmCheck(bobPort, "none");
  const noConflict = await measureChecks(bobPort, "none");
  assert.equal(noConflict.last.verdict, "none");
  assertLatencyBudget("repo warm no-conflict file-only check", noConflict);

  await report(alicePort, "alice", targetFile);
  await makeBreakingSignatureChange(aliceRoot);
  await report(alicePort, "alice", targetFile);
  await waitForState(serverPort, (state) =>
    state.unpushedDeltas.some((delta) => delta.symbolId.raw === targetSymbol)
  );
  await waitForDaemonState(bobPort, (state) =>
    state.unpushedDeltas.some((delta) => delta.symbolId.raw === targetSymbol)
  );

  await warmCheck(bobPort, "warn");
  const sameSymbolConflict = await measureChecks(bobPort, "warn");
  assert.equal(sameSymbolConflict.last.verdict, "warn");
  assert.ok(
    sameSymbolConflict.last.conflicts.some(
      (conflict) =>
        conflict.rule === "same_symbol_unpushed" &&
        conflict.targetSymbol.raw === targetSymbol
    ),
    "expected a same_symbol_unpushed warning for deterministicAnalysis"
  );
  assertLatencyBudget("repo warm same-symbol warning file-only check", sameSymbolConflict);

  console.log("Repo latency verification passed:");
  console.log(
    JSON.stringify(
      {
        source: "git archive HEAD",
        commit,
        sourceFiles,
        targetFile,
        targetSymbol,
        budgets: {
          coldMaxMs: coldMaxBudgetMs,
          warmP95Ms: p95BudgetMs,
          warmMaxMs: maxBudgetMs
        },
        iterations: measuredIterations,
        coldFirstCheckMs,
        noConflict: noConflict.stats,
        sameSymbolConflict: sameSymbolConflict.stats
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(demoRoot, { recursive: true, force: true });
}

async function snapshotRepo() {
  await mkdir(aliceRoot, { recursive: true });
  await mkdir(bobRoot, { recursive: true });
  await run("git", ["archive", "--format=tar", "HEAD", "-o", archivePath], rootDir);
  await run("tar", ["-xf", archivePath, "-C", aliceRoot], rootDir);
  await run("tar", ["-xf", archivePath, "-C", bobRoot], rootDir);
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

async function makeBreakingSignatureChange(worktreeRoot) {
  const fullPath = join(worktreeRoot, targetFile);
  const source = await readFile(fullPath, "utf8");
  const before = "export function deterministicAnalysis(conflict: Conflict): ConflictAnalysis {";
  const after = "export function deterministicAnalysis(conflict: Conflict): ConflictAnalysis | null {";
  assert.ok(source.includes(before), `expected signature not found in ${targetFile}`);
  await writeFile(fullPath, source.replace(before, after));
}

async function report(port, sessionId, filePath) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId,
    filePath
  });
}

async function warmCheck(port, expectedVerdict) {
  for (let index = 0; index < warmupIterations; index += 1) {
    const result = await checkTargetFile(port, "bob");
    assert.equal(result.verdict, expectedVerdict);
  }
}

async function measureChecks(port, expectedVerdict) {
  const samples = [];
  let last = null;

  for (let index = 0; index < measuredIterations; index += 1) {
    const start = performance.now();
    last = await checkTargetFile(port, "bob");
    const elapsed = performance.now() - start;
    assert.equal(last.verdict, expectedVerdict);
    assert.equal(last.degraded, false);
    samples.push(elapsed);
  }

  return { samples, stats: stats(samples), last };
}

async function checkTargetFile(port, sessionId) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId,
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

async function countSourceFiles(root, currentDir = root) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectory(entry.name)) {
        continue;
      }
      count += await countSourceFiles(root, fullPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (/\.(cts|mts|tsx?|jsx?|pyi?)$/u.test(fullPath)) {
      count += 1;
    }
  }

  return count;
}

function ignoredDirectory(name) {
  return [".git", ".turbo", ".venv", "__pycache__", "dist", "node_modules"].includes(name);
}

async function run(command, args, cwd) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 1024 * 1024 * 20
  });
  return stdout;
}
