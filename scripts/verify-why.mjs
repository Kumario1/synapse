import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

  const report = await postJson(`http://localhost:${alicePort}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath,
    symbolId: { raw: symbol },
    summary: "TokenValidator.validate now returns Result<Token, AuthError>"
  });
  assert.equal(report.ok, true);

  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);
  const check = await postJson(`http://localhost:${bobPort}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [filePath],
    symbols: [{ raw: symbol }],
    task: "update auth validation caller"
  });
  assert.equal(check.verdict, "warn");
  assert.equal(check.conflicts.length, 1);
  await postJson(`http://localhost:${bobPort}/tools/synapse_feedback`, {
    repoId: "local",
    sessionId: "bob",
    conflictId: check.conflicts[0].id,
    outcome: "acted",
    rule: check.conflicts[0].rule,
    targetSymbol: check.conflicts[0].targetSymbol,
    note: "Adjusted auth validation caller to match Alice's contract."
  });
  await waitForDaemonState(bobPort, (state) => state.conflictFeedback.length === 1);

  await postGitHub("pull_request", {
    action: "opened",
    repository: { full_name: "local" },
    sender: { login: "carol" },
    pull_request: {
      number: 42,
      title: "Add billing ledger",
      html_url: "https://github.com/acme/widgets/pull/42",
      merged: false
    }
  });
  await postJson(`http://localhost:${alicePort}/tools/synapse_session`, {
    repoId: "local",
    sessionId: "alice",
    action: "end",
    task: "refactor auth validation"
  });
  await waitForDaemonState(bobPort, (state) => state.sessionSummaries.length === 1);

  const why = await postJson(`http://localhost:${bobPort}/tools/synapse_why`, {
    repoId: "local",
    sessionId: "bob",
    question: "why did auth validation change?",
    limit: 5
  });

  assert.equal(why.degraded, false);
  assert.equal(why.question, "why did auth validation change?");
  assert.ok(why.answer.includes("auth validation") || why.answer.includes("TokenValidator.validate"));
  assert.ok(why.sources.length >= 2);
  assert.ok(why.sources.some((source) => source.kind === "session_summary"));
  assert.ok(why.sources.some((source) => source.kind === "unpushed_delta"));
  assert.ok(why.sources.some((source) => source.kind === "conflict_feedback"));
  assert.ok(why.sources.every((source) => source.score > 0));

  const repoWhy = await postJson(`http://localhost:${bobPort}/tools/synapse_why`, {
    repoId: "local",
    sessionId: "bob",
    question: "what happened with billing ledger?",
    limit: 3
  });
  assert.ok(repoWhy.sources.some((source) => source.kind === "repo_event"));
  assert.ok(repoWhy.answer.includes("Add billing ledger"));

  const empty = await postJson(`http://localhost:${bobPort}/tools/synapse_why`, {
    repoId: "local",
    sessionId: "bob",
    question: "payments webhooks retry policy",
    limit: 3
  });
  assert.deepEqual(empty.sources, []);
  assert.ok(empty.answer.includes("No matching Synapse memory"));

  console.log("Synapse why verification passed:");
  console.log(JSON.stringify({ why, repoWhy, empty }, null, 2));

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

function startProcess(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...env,
      OPENROUTER_API_KEY: "",
      SYNAPSE_LLM_EXPLAIN: "0",
      SYNAPSE_LLM_RESOLVE: "0",
      SYNAPSE_LLM_SUMMARY: "0"
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

async function postGitHub(event, payload) {
  const response = await fetch(`http://localhost:${serverPort}/webhooks/github?repoId=local`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub webhook ${event} failed: ${JSON.stringify(body)}`);
  }
  return body;
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
