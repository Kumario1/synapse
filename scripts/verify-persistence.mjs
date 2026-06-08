import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end proof that server state is durable: start the server with a
// file-backed SQLite store, create state over HTTP (a GitHub push webhook),
// kill the process, restart it against the same database, and assert the state
// resumed — nothing re-sent it, so it can only have come from disk.
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = await mkdtemp(join(tmpdir(), "synapse-persist-"));
const dbPath = join(dbDir, "state.db");
const sha = "abc123def456";

try {
  // --- First boot: write some state. ---
  const first = await startServer();
  await pushWebhook(first.port);

  const before = await getState(first.port);
  assert.equal(before.recentPushes.length, 1, "the push was recorded");
  assert.equal(before.recentPushes[0].sha, sha);
  await stopServer(first);

  // --- Restart against the same DB: state must resume from disk. ---
  const second = await startServer();
  const after = await getState(second.port);
  assert.equal(
    after.recentPushes.length,
    1,
    "state survived the restart (loaded from the SQLite store)"
  );
  assert.equal(after.recentPushes[0].sha, sha, "the exact push survived");
  await stopServer(second);

  // --- Control: a different DB path starts empty (no cross-contamination). ---
  const fresh = await startServer(join(dbDir, "other.db"));
  const freshState = await getState(fresh.port);
  assert.equal(freshState.recentPushes.length, 0, "a different DB starts empty");
  await stopServer(fresh);

  console.log("Persistence verification passed:");
  console.log(
    JSON.stringify(
      { dbPath, survivedSha: after.recentPushes[0].sha, recentPushes: after.recentPushes.length },
      null,
      2
    )
  );
} finally {
  await rm(dbDir, { recursive: true, force: true });
}

async function startServer(path = dbPath) {
  const port = await freePort();
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: rootDir,
    env: { ...process.env, SYNAPSE_SERVER_PORT: String(port), SYNAPSE_DB_PATH: path },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[server:${port}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[server:${port}] ${chunk}`));
  await waitForHttp(`http://localhost:${port}/health`);
  return { child, port };
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return;
  }
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill("SIGKILL");
    await once(server.child, "exit");
  }
}

async function pushWebhook(port) {
  const payload = {
    after: sha,
    repository: { full_name: "acme/widgets" },
    sender: { login: "alice" },
    head_commit: { message: "Ship the auth refactor" },
    commits: [{ modified: ["src/auth/token.ts"], added: [], removed: [] }]
  };
  const response = await fetch(`http://localhost:${port}/webhooks/github?repoId=local`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "push" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`webhook failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function getState(port) {
  const response = await fetch(`http://localhost:${port}/state?repoId=local`);
  if (!response.ok) {
    throw new Error(`/state failed: ${response.status}`);
  }
  return response.json();
}

async function waitForHttp(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}
