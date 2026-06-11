import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// G4 security remainder: (1) ingress rate limiting — a flooding WS client gets
// rate_limited acks and its over-limit messages never mutate state; the
// webhook endpoint answers 429 past its budget; (2) production webhook
// posture — a server running with auth refuses unsigned webhooks until
// SYNAPSE_GITHUB_WEBHOOK_SECRET is configured, then accepts correctly signed
// ones; open mode stays unchanged for local/dev.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(rootDir, "apps/server/package.json"));
const wsModule = await import(require.resolve("ws"));
const WebSocket = wsModule.WebSocket ?? wsModule.default;
const children = [];

const WS_LIMIT = 20;
const WEBHOOK_LIMIT = 5;
const token = "security-verify-token";
const webhookSecret = "security-verify-webhook-secret";

try {
  // --- Server A: open mode, tight limits, no webhook secret. ---
  const openPort = await freePort();
  startServer("open", openPort, {
    SYNAPSE_RATE_LIMIT_PER_MIN: String(WS_LIMIT),
    SYNAPSE_WEBHOOK_RATE_LIMIT_PER_MIN: String(WEBHOOK_LIMIT)
  });
  await waitForHttp(`http://localhost:${openPort}/health`);

  // Open mode still accepts unsigned webhooks (local/dev unchanged).
  const unsignedOpen = await pushWebhook(openPort, { sha: "open-1" });
  assert.equal(unsignedOpen.status, 202, "open mode accepts unsigned webhooks");

  // WS flood: the first WS_LIMIT messages in the window apply; the rest are
  // acked as rate_limited and never reach state.
  const socket = await openSocket(`ws://localhost:${openPort}?repoId=local&v=1`);
  const total = WS_LIMIT + 10;
  const acks = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "ack") {
      acks.push(message.payload);
    }
  });
  for (let i = 0; i < total; i += 1) {
    socket.send(JSON.stringify(feedbackMessage(`flood-${i}`)));
  }
  await waitFor(() => acks.length >= total, 8000, "every flood message acked");
  const rateLimited = acks.filter((ack) => ack.ok === false && ack.error === "rate_limited");
  assert.ok(rateLimited.length >= 10, `over-limit messages were refused (${rateLimited.length})`);

  const state = await getState(openPort);
  assert.ok(
    state.conflictFeedback.length <= WS_LIMIT,
    `state holds at most the in-budget messages (${state.conflictFeedback.length} <= ${WS_LIMIT})`
  );
  socket.close();

  // Webhook flood: budget already partly spent; pushing past it answers 429.
  let saw429 = false;
  for (let i = 0; i < WEBHOOK_LIMIT + 2; i += 1) {
    const response = await pushWebhook(openPort, { sha: `flood-${i}` });
    if (response.status === 429) {
      saw429 = true;
      break;
    }
  }
  assert.ok(saw429, "webhook endpoint rate-limits past its budget");

  // --- Server B: auth enabled (production posture), no webhook secret. ---
  const authPort = await freePort();
  startServer("auth", authPort, { SYNAPSE_AUTH_TOKEN: token });
  await waitForHttp(`http://localhost:${authPort}/health`);

  const refused = await pushWebhook(authPort, { sha: "auth-1" });
  assert.equal(refused.status, 403, "auth mode without a webhook secret refuses webhooks");
  assert.equal(refused.body.error, "webhook_secret_required");

  // --- Server C: auth + webhook secret — signed accepted, unsigned rejected. ---
  const signedPort = await freePort();
  startServer("signed", signedPort, {
    SYNAPSE_AUTH_TOKEN: token,
    SYNAPSE_GITHUB_WEBHOOK_SECRET: webhookSecret
  });
  await waitForHttp(`http://localhost:${signedPort}/health`);

  const unsigned = await pushWebhook(signedPort, { sha: "signed-1" });
  assert.equal(unsigned.status, 401, "unsigned webhook rejected when a secret is set");

  const signed = await pushWebhook(signedPort, { sha: "signed-2", secret: webhookSecret });
  assert.equal(signed.status, 202, "correctly signed webhook accepted");

  console.log("Security verification passed:");
  console.log(
    JSON.stringify(
      {
        wsRateLimited: rateLimited.length,
        stateBounded: state.conflictFeedback.length,
        webhook429: saw429,
        authWithoutSecret: refused.status,
        signedAccepted: signed.status
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
}

function startServer(label, port, env) {
  startProcess(label, ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(port),
    ...env
  });
}

function feedbackMessage(id) {
  return {
    v: 1,
    type: "conflict.feedback",
    id,
    ts: new Date().toISOString(),
    payload: {
      repoId: "local",
      feedback: {
        id,
        repoId: "local",
        conflictId: "c1",
        sessionId: "flooder",
        memberId: "flooder",
        outcome: "acted",
        createdAt: new Date().toISOString()
      }
    }
  };
}

async function pushWebhook(port, { sha, secret }) {
  const payload = JSON.stringify({
    after: sha,
    ref: "refs/heads/main",
    sender: { login: "alice" },
    commits: [{ modified: ["src/auth/token.ts"], added: [], removed: [] }]
  });
  const headers = { "content-type": "application/json", "x-github-event": "push" };
  if (secret) {
    headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }
  const response = await fetch(`http://localhost:${port}/webhooks/github?repoId=local`, {
    method: "POST",
    headers,
    body: payload
  });
  return { status: response.status, body: await response.json() };
}

async function getState(port) {
  const response = await fetch(`http://localhost:${port}/state?repoId=local`);
  assert.equal(response.ok, true);
  return response.json();
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`timed out opening ${url}`)), 5000).unref();
  });
}

function startProcess(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return child;
}

async function waitForHttp(url, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs, `reach ${url}`);
}

async function waitFor(predicate, timeoutMs, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
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
            resolve(undefined);
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
