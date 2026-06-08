import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#TokenValidator.validate";
const webhookSecret = "synapse-test-secret";

try {
  const server = startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort),
    SYNAPSE_GITHUB_WEBHOOK_SECRET: webhookSecret
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

  const unpushedCheck = await checkSymbol(bobPort);
  assert.equal(unpushedCheck.verdict, "warn");
  assert.deepEqual(
    unpushedCheck.conflicts.map((conflict) => conflict.rule),
    ["same_symbol_unpushed"]
  );

  const webhookPayload = {
    after: "abc123",
    repository: { full_name: "Kumario1/synapse" },
    sender: { login: "alice" },
    head_commit: { message: "Pushed auth token changes" },
    commits: [{ modified: [filePath] }]
  };
  const webhook = await postJson(
    `http://localhost:${serverPort}/webhooks/github?repoId=local`,
    webhookPayload,
    signedGitHubHeaders(webhookPayload)
  );
  assert.deepEqual(webhook, { ok: true, repoId: "local", sha: "abc123", files: [filePath] });

  const stateAfterWebhook = await waitForState(
    serverPort,
    (state) =>
      state.unpushedDeltas.length === 0 &&
      state.editLocks.length === 0 &&
      state.recentPushes.length === 1 &&
      state.sessions.every((session) => !session.filesEditing.includes(filePath))
  );

  const postPushCheck = await checkSymbol(bobPort);
  assert.equal(postPushCheck.verdict, "warn");
  assert.deepEqual(
    postPushCheck.conflicts.map((conflict) => conflict.rule),
    ["stale_base"]
  );

  console.log("GitHub webhook verification passed:");
  console.log(JSON.stringify({ webhook, stateAfterWebhook, postPushCheck }, null, 2));

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

async function checkSymbol(port) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [filePath],
    symbols: [{ raw: symbol }]
  });
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

async function postJson(url, body, headers = {}) {
  const raw = JSON.stringify(body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function signedGitHubHeaders(body) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", webhookSecret).update(raw).digest("hex");
  return {
    "x-github-event": "push",
    "x-hub-signature-256": `sha256=${signature}`
  };
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
