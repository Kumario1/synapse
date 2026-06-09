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
  assert.equal(check.conflicts.length, 1);
  const conflict = check.conflicts[0];
  assert.match(conflict.id, /^conflict:[0-9a-f]{16}$/u);

  const acted = await postJson(`http://localhost:${bobPort}/tools/synapse_feedback`, {
    repoId: "local",
    sessionId: "bob",
    conflictId: conflict.id,
    outcome: "acted",
    rule: conflict.rule,
    targetSymbol: conflict.targetSymbol,
    note: "Adjusted the caller to the new token contract."
  });
  assert.equal(acted.ok, true);
  assert.equal(acted.feedback.outcome, "acted");
  assert.equal(acted.feedback.conflictId, conflict.id);

  await waitForState(
    serverPort,
    (state) =>
      state.conflictFeedback.length === 1 &&
      state.conflictFeedback[0].conflictId === conflict.id &&
      state.conflictFeedback[0].outcome === "acted"
  );
  await waitForDaemonState(
    bobPort,
    (state) =>
      state.conflictFeedback.length === 1 &&
      state.conflictFeedback[0].conflictId === conflict.id
  );

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
    "False alarm after checking Alice's branch."
  ]);
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.feedback.outcome, "dismissed");

  const stateAfterCli = await waitForState(
    serverPort,
    (state) =>
      state.conflictFeedback.length === 2 &&
      state.conflictFeedback[0].outcome === "dismissed" &&
      state.conflictFeedback[1].outcome === "acted"
  );

  const briefing = await postJson(`http://localhost:${bobPort}/tools/synapse_whatsup`, {
    repoId: "local",
    sessionId: "bob"
  });
  assert.equal(briefing.conflictFeedback.length, 2);
  assert.ok(briefing.summary.some((line) => line.includes("2 conflict feedback events")));

  console.log("Conflict feedback verification passed:");
  console.log(
    JSON.stringify(
      {
        conflict: {
          id: conflict.id,
          rule: conflict.rule,
          targetSymbol: conflict.targetSymbol.raw
        },
        feedback: stateAfterCli.conflictFeedback,
        briefingSummary: briefing.summary
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
