import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#TokenValidator.validate";

try {
  const server = startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = startDaemon("alice", alicePort);
  const bob = startDaemon("bob", bobPort);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2);

  const aliceCheck = await postJson(`http://localhost:${alicePort}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "alice",
    filePath,
    files: [filePath],
    symbols: [{ raw: symbol }]
  });
  assert.equal(aliceCheck.verdict, "none");
  await waitForState(
    serverPort,
    (state) =>
      state.editLocks.some(
        (lock) => lock.sessionId === "alice" && lock.symbolId.raw === symbol
      )
  );

  await postJson(`http://localhost:${alicePort}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath,
    symbolId: { raw: symbol },
    summary: "TokenValidator.validate now returns Result<Token, AuthError>"
  });
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  const check = await postJson(`http://localhost:${bobPort}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    filePath,
    files: [filePath],
    symbols: [{ raw: symbol }]
  });
  assert.equal(check.verdict, "warn");
  assert.ok(check.conflicts.length >= 1);
  const conflict = check.conflicts.find((item) => item.rule === "same_symbol_unpushed");
  assert.ok(conflict);
  await waitForState(
    serverPort,
    (state) =>
      (state.resolutionProposals ?? []).some(
        (proposal) => proposal.symbol.raw === symbol && proposal.status === "resolving"
      )
  );

  const acted = await postJson(`http://localhost:${bobPort}/tools/synapse_feedback`, {
    repoId: "local",
    sessionId: "bob",
    conflictId: conflict.id,
    outcome: "acted",
    rule: conflict.rule,
    targetSymbol: conflict.targetSymbol,
    note: "Adjusted caller to match the changed contract."
  });
  assert.equal(acted.ok, true);

  const dismissed = runCliJson([
    "feedback",
    "--port",
    String(bobPort),
    "--conflict-id",
    conflict.id,
    "--outcome",
    "dismissed",
    "--rule",
    conflict.rule,
    "--symbol",
    symbol,
    "--note",
    "No follow-up needed after reviewing the branch."
  ]);
  assert.equal(dismissed.ok, true);

  await waitForDaemonState(
    bobPort,
    (state) =>
      state.conflictFeedback.length === 2 &&
      state.conflictFeedback[0].outcome === "dismissed" &&
      state.conflictFeedback[1].outcome === "acted"
  );

  const daemonInsights = await postJson(`http://localhost:${bobPort}/tools/synapse_insights`, {
    repoId: "local",
    sessionId: "bob"
  });
  assertInsights(daemonInsights);

  const cliInsights = runCliJson(["insights", "--port", String(bobPort)]);
  assertInsights(cliInsights);

  console.log("Insights verification passed:");
  console.log(
    JSON.stringify(
      {
        totals: cliInsights.totals,
        topRulesByFeedback: cliInsights.topRulesByFeedback,
        topConflictTargets: cliInsights.topConflictTargets,
        summary: cliInsights.summary
      },
      null,
      2
    )
  );

  server.kill();
  alice.kill();
  bob.kill();
} finally {
  await stopChildren();
}

function assertInsights(insights) {
  assert.equal(insights.repoId, "local");
  assert.equal(insights.degraded, false);
  assert.equal(insights.totals.feedback, 2);
  assert.equal(insights.totals.acted, 1);
  assert.equal(insights.totals.dismissed, 1);
  assert.equal(insights.totals.activeSessions, 2);
  assert.equal(insights.totals.unpushedDeltas, 1);
  assert.equal(insights.totals.resolutionResolving, 1);
  assert.equal(insights.totals.resolutionResolved, 0);
  assert.equal(insights.totals.resolutionEscalated, 0);
  assert.equal(insights.topRulesByFeedback[0].name, "same_symbol_unpushed");
  assert.equal(insights.topRulesByFeedback[0].count, 2);
  assert.equal(insights.topConflictTargets[0].name, symbol);
  assert.equal(insights.topConflictTargets[0].count, 2);
  assert.deepEqual(
    insights.recentFeedback.map((item) => item.outcome),
    ["dismissed", "acted"]
  );
  assert.ok(insights.summary.some((line) => line.includes("2 feedback events recorded")));
  assert.ok(insights.summary.some((line) => line.includes("Mediator proposals: 1 resolving")));
}

function startDaemon(member, port) {
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
      `ws://localhost:${serverPort}`
    ],
    {}
  );
}

function runCliJson(args) {
  const result = spawnSync(process.execPath, ["apps/cli/dist/index.js", ...args], {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function startProcess(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  children.push(child);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });

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

async function waitForState(port, predicate, timeoutMs = 5000) {
  let lastState = null;

  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=local`).catch(() => null);
    if (!response?.ok) {
      return false;
    }

    lastState = await response.json();
    return predicate(lastState);
  }, timeoutMs);

  return lastState;
}

async function waitForDaemonState(port, predicate, timeoutMs = 5000) {
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

    await new Promise((resolve) => setTimeout(resolve, 50));
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
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }

          child.once("exit", resolve);
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
