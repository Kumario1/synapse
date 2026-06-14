import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end proof that the Postgres store (plan M8, selected by
// SYNAPSE_DATABASE_URL) is durable: start the server against Postgres, create
// state over HTTP (a GitHub push webhook), SIGKILL the process — no graceful
// flush — restart it against the same database, and assert the state resumed.
// Runs when SYNAPSE_VERIFY_PG_URL (CI service) or SYNAPSE_DATABASE_URL is
// present; SKIPs offline so the matrix stays hermetic without a database.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pgUrl = process.env.SYNAPSE_VERIFY_PG_URL ?? process.env.SYNAPSE_DATABASE_URL;

if (!pgUrl) {
  console.log(
    "Postgres persistence verification skipped: set SYNAPSE_VERIFY_PG_URL (or SYNAPSE_DATABASE_URL) to run it."
  );
  process.exit(0);
}

// Preflight: a present-but-unreachable URL is a real failure (CI asked for it).
{
  const require = createRequire(join(rootDir, "apps/server/package.json"));
  const { default: pg } = await import(require.resolve("pg"));
  const client = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  await client.end();
}

// Unique room per run: unlike the SQLite verify's throwaway tmp file, the CI
// Postgres service is shared by every script in the job run.
const repoId = `pgverify/${Date.now()}`;
const sha = "abc123def456";

// --- First boot: write some state. ---
const first = await startServer();
await pushWebhook(first.port);

const before = await getState(first.port);
assert.equal(before.recentPushes.length, 1, "the push was recorded");
assert.equal(before.recentPushes[0].sha, sha);

// SIGKILL: durability must not depend on the graceful-shutdown flush. The
// store applies ops as they are issued; give the queue a beat to drain.
await delay(300);
first.child.kill("SIGKILL");
await once(first.child, "exit");

// --- Restart against the same database: state must resume from rows. ---
const second = await startServer();
const after = await getState(second.port);
assert.equal(
  after.recentPushes.length,
  1,
  "state survived the SIGKILL restart (loaded from the Postgres store)"
);
assert.equal(after.recentPushes[0].sha, sha, "the exact push survived");
assert.equal(after.recentPushes[0].branch, "main", "the webhook-derived branch survived");

// --- Control: a different repo room is empty (per-repo row isolation). ---
const fresh = await fetch(
  `http://localhost:${second.port}/state?repoId=${encodeURIComponent(`${repoId}-other`)}`
);
assert.equal((await fresh.json()).recentPushes.length, 0, "a different repo starts empty");
await stopServer(second);

console.log("Postgres persistence verification passed:");
console.log(
  JSON.stringify(
    { repoId, survivedSha: after.recentPushes[0].sha, recentPushes: after.recentPushes.length },
    null,
    2
  )
);

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: rootDir,
    env: { ...process.env, SYNAPSE_SERVER_PORT: String(port), SYNAPSE_DATABASE_URL: pgUrl },
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
    ref: "refs/heads/main",
    repository: { full_name: repoId },
    sender: { login: "alice" },
    head_commit: { message: "Ship the auth refactor" },
    commits: [{ modified: ["src/auth/token.ts"], added: [], removed: [] }]
  };
  const response = await fetch(
    `http://localhost:${port}/webhooks/github?repoId=${encodeURIComponent(repoId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push" },
      body: JSON.stringify(payload)
    }
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`webhook failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function getState(port) {
  const response = await fetch(
    `http://localhost:${port}/state?repoId=${encodeURIComponent(repoId)}`
  );
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
