import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const demoRoot = await mkdtemp(join(tmpdir(), "synapse-latency-"));
const aliceRoot = join(demoRoot, "alice");
const bobRoot = join(demoRoot, "bob");

const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#validate";
const warmupIterations = 10;
const measuredIterations = 60;
const p95BudgetMs = 50;
const maxBudgetMs = 150;

try {
  const baselineSource = `
    export interface Token {
      value: string;
    }

    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `;

  await writeFixture(aliceRoot, baselineSource);
  await writeFixture(bobRoot, baselineSource);

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

  await warmCheck(bobPort);
  const noConflict = await measureChecks(bobPort, "none");
  assert.equal(noConflict.last.verdict, "none");
  assertLatencyBudget("no-conflict file-only check", noConflict);

  await report(alicePort);
  await writeFixture(
    aliceRoot,
    `
    export interface Token {
      value: string;
    }

    export function validate(input: string): Token | null {
      return input ? { value: input } : null;
    }
  `
  );
  await report(alicePort);
  await waitForState(serverPort, (state) =>
    state.unpushedDeltas.some((delta) => delta.symbolId.raw === symbol)
  );
  await waitForDaemonState(bobPort, (state) =>
    state.unpushedDeltas.some((delta) => delta.symbolId.raw === symbol)
  );

  await warmCheck(bobPort);
  const conflict = await measureChecks(bobPort, "warn");
  assert.equal(conflict.last.verdict, "warn");
  assert.deepEqual(
    conflict.last.conflicts.map((item) => item.rule),
    ["same_symbol_unpushed"]
  );
  assertLatencyBudget("warn file-only check", conflict);

  console.log("Hot-path latency verification passed:");
  console.log(
    JSON.stringify(
      {
        budgets: { p95Ms: p95BudgetMs, maxMs: maxBudgetMs },
        iterations: measuredIterations,
        noConflict: noConflict.stats,
        conflict: conflict.stats
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

async function writeFixture(worktreeRoot, source) {
  const fullPath = join(worktreeRoot, filePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${source.trim()}\n`);
}

async function report(port) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath
  });
}

async function warmCheck(port) {
  for (let index = 0; index < warmupIterations; index += 1) {
    await checkFileOnly(port);
  }
}

async function measureChecks(port, expectedVerdict) {
  const samples = [];
  let last = null;

  for (let index = 0; index < measuredIterations; index += 1) {
    const start = performance.now();
    last = await checkFileOnly(port);
    const elapsed = performance.now() - start;
    assert.equal(last.verdict, expectedVerdict);
    assert.equal(last.degraded, false);
    samples.push(elapsed);
  }

  return { samples, stats: stats(samples), last };
}

async function checkFileOnly(port) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [filePath]
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
