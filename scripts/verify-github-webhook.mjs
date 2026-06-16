import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectKey } from "@synapse/protocol";

// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const tenancyServerPort = await freePort();
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#TokenValidator.validate";
const webhookSecret = "synapse-test-secret";
const masterSecret = "synapse-webhook-tenancy-secret";

try {
  const tenancyServer = startProcess("tenancy-server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(tenancyServerPort),
    SYNAPSE_MASTER_SECRET: masterSecret,
    SYNAPSE_GITHUB_WEBHOOK_SECRET: webhookSecret
  });
  await waitForHttp(`http://localhost:${tenancyServerPort}/health`);

  const tenantRepo = "someone/else";
  const tenantKey = deriveProjectKey(masterSecret, tenantRepo);
  const missingRepoPayload = {
    after: "tenant123",
    sender: { login: "mallory" },
    head_commit: { message: "Attempt missing repo binding" },
    commits: [{ modified: [filePath] }]
  };
  const missingRepoWebhook = await postJsonResponse(
    `http://localhost:${tenancyServerPort}/webhooks/github?repoId=${encodeURIComponent(tenantRepo)}`,
    missingRepoPayload,
    signedGitHubHeaders(missingRepoPayload)
  );
  assert.equal(missingRepoWebhook.status, 422, "project-key webhook requires repository.full_name");
  assert.equal(missingRepoWebhook.body.error, "repository_full_name_required");

  const tenantStateAfterReject = await getState(tenancyServerPort, tenantRepo, tenantKey);
  assert.equal(
    tenantStateAfterReject.recentPushes.length,
    0,
    "missing full_name webhook does not write a push"
  );
  assert.equal(
    tenantStateAfterReject.recentRepoEvents.length,
    0,
    "missing full_name webhook does not write a repo event"
  );

  const boundPayload = {
    after: "tenant456",
    repository: { full_name: tenantRepo },
    sender: { login: "alice" },
    head_commit: { message: "Bound tenant push" },
    commits: [{ modified: [filePath] }]
  };
  const boundWebhook = await postJson(
    `http://localhost:${tenancyServerPort}/webhooks/github?repoId=${encodeURIComponent(tenantRepo)}`,
    boundPayload,
    signedGitHubHeaders(boundPayload)
  );
  assert.deepEqual(boundWebhook, { ok: true, repoId: tenantRepo, sha: "tenant456", files: [filePath] });
  const tenantStateAfterAccept = await getState(tenancyServerPort, tenantRepo, tenantKey);
  assert.equal(
    tenantStateAfterAccept.recentPushes.length,
    1,
    "repository.full_name webhook writes in project-key mode"
  );
  tenancyServer.kill();

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

  const mismatchedPayload = {
    after: "mismatch123",
    repository: { full_name: "owner/repo-a" },
    sender: { login: "mallory" },
    head_commit: { message: "Attempt cross-repo routing" },
    commits: [{ modified: [filePath] }]
  };
  const mismatchedWebhook = await postJsonResponse(
    `http://localhost:${serverPort}/webhooks/github?repoId=owner/repo-b`,
    mismatchedPayload,
    signedGitHubHeaders(mismatchedPayload)
  );
  assert.equal(mismatchedWebhook.status, 400, "mismatched repo id is rejected");
  assert.match(mismatchedWebhook.body.error, /repository\.full_name does not match repoId/);
  const repoBState = await getState(serverPort, "owner/repo-b");
  assert.equal(repoBState.recentPushes.length, 0, "mismatched webhook does not mutate query repo");

  const unpushedCheck = await checkSymbol(bobPort);
  assert.equal(unpushedCheck.verdict, "warn");
  assert.deepEqual(
    unpushedCheck.conflicts.map((conflict) => conflict.rule),
    ["same_symbol_unpushed"]
  );

  const webhookPayload = {
    after: "abc123",
    repository: { full_name: "local" },
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

  // PR-thread decision memory (plan C3 slice): an issue_comment body is
  // distilled into the repo event's `detail` — decision prose survives, code
  // blocks never do.
  const commentPayload = {
    action: "created",
    repository: { full_name: "local" },
    sender: { login: "bob" },
    issue: { number: 5, title: "Auth design", pull_request: {} },
    comment: {
      html_url: "https://github.com/Kumario1/synapse/pull/5#c1",
      body: "Decision: keep HMAC project keys for self-host.\n\n```js\nconst leaked = secrets();\n```"
    }
  };
  const commentWebhook = await postJson(
    `http://localhost:${serverPort}/webhooks/github?repoId=local`,
    commentPayload,
    signedGitHubHeaders(commentPayload, "issue_comment")
  );
  assert.equal(commentWebhook.ok, true);

  const stateWithComment = await waitForState(
    serverPort,
    (state) => state.recentRepoEvents.length >= 1
  );
  const event = stateWithComment.recentRepoEvents.find((e) => e.kind === "issue_comment");
  assert.ok(event, "comment repo event stored");
  assert.equal(
    event.detail,
    "Decision: keep HMAC project keys for self-host. [code omitted]"
  );
  assert.ok(!event.detail.includes("secrets()"), "code-block content never persists");

  console.log("GitHub webhook verification passed:");
  console.log(JSON.stringify({ webhook, stateAfterWebhook, postPushCheck, commentDetail: event.detail }, null, 2));

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
  const { status, body: responseBody } = await postJsonResponse(url, body, headers);

  if (status < 200 || status >= 300) {
    throw new Error(`${url} failed: ${JSON.stringify(responseBody)}`);
  }

  return responseBody;
}

async function postJsonResponse(url, body, headers = {}) {
  const raw = JSON.stringify(body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw
  });
  const responseBody = await response.json();

  return { status: response.status, body: responseBody };
}

function signedGitHubHeaders(body, event = "push") {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", webhookSecret).update(raw).digest("hex");
  return {
    "x-github-event": event,
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

async function getState(port, repoId, token) {
  const url = new URL(`http://localhost:${port}/state`);
  url.searchParams.set("repoId", repoId);
  if (token) {
    url.searchParams.set("token", token);
  }
  const response = await fetch(url);
  assert.equal(response.ok, true);
  return response.json();
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
