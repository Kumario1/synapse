import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Multi-instance proof (plan M9): two server instances share Postgres (M8
// rows) + Redis (fan-out channel). Daemons split across them — alice on A,
// bob on B. A contract delta reported through A must (1) be readable in
// `GET /state` on B (shared store + fan-out cache refresh) and (2) arrive in
// B's daemon's cached team state (B re-broadcast the fresh snapshot to its
// local room). Runs when both SYNAPSE_VERIFY_PG_URL and
// SYNAPSE_VERIFY_REDIS_URL (or their SYNAPSE_* runtime twins) are present —
// the CI services — and SKIPs offline so the matrix stays hermetic.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pgUrl = process.env.SYNAPSE_VERIFY_PG_URL ?? process.env.SYNAPSE_DATABASE_URL;
const redisUrl = process.env.SYNAPSE_VERIFY_REDIS_URL ?? process.env.SYNAPSE_REDIS_URL;

if (!pgUrl || !redisUrl) {
  console.log(
    "Multi-instance verification skipped: set SYNAPSE_VERIFY_PG_URL and SYNAPSE_VERIFY_REDIS_URL to run it."
  );
  process.exit(0);
}

// Preflight both services: a present-but-unreachable URL is a real failure.
{
  const require = createRequire(join(rootDir, "apps/server/package.json"));
  const { default: pg } = await import(require.resolve("pg"));
  const client = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  await client.end();
  const { createClient } = await import(require.resolve("redis"));
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  await redis.close();
}

const repoId = `multiverify/${Date.now()}`;
const filePath = "src/auth/token.ts";
const children = [];
const worktreeRoot = await mkdtemp(join(tmpdir(), "synapse-multi-"));

try {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFixture(`
    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);

  const portA = await freePort();
  const portB = await freePort();
  startServer("server-a", portA);
  startServer("server-b", portB);
  await Promise.all([
    waitForHttp(`http://localhost:${portA}/health`),
    waitForHttp(`http://localhost:${portB}/health`)
  ]);

  const alicePort = await freePort();
  const bobPort = await freePort();
  startDaemon("alice", alicePort, portA);
  startDaemon("bob", bobPort, portB);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);

  // Cross-instance session visibility: alice joined A, bob joined B, yet each
  // server must see both sessions (shared rows + fan-out refresh).
  await waitForState(portA, (state) => state.sessions.length === 2, 10_000);
  await waitForState(portB, (state) => state.sessions.length === 2, 10_000);

  // Alice (on A) changes the validate() contract.
  await report(alicePort);
  await writeFixture(`
    export function validate(input: string): { value: string } | null {
      return input ? { value: input } : null;
    }
  `);
  await report(alicePort);

  // (1) The delta is visible in GET /state on B.
  await waitForState(
    portB,
    (state) => state.unpushedDeltas.some((d) => d.symbolId.raw === "ts:src/auth/token.ts#validate"),
    10_000
  );

  // (2) And B pushed it to bob's daemon: the daemon's cached team state (fed
  // only by B's ws broadcasts) carries alice's delta.
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${bobPort}/state`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    const state = await response.json();
    return state.unpushedDeltas.some((d) => d.symbolId.raw === "ts:src/auth/token.ts#validate");
  }, 10_000);

  const stateB = await getState(portB);
  console.log("Multi-instance verification passed:");
  console.log(
    JSON.stringify(
      {
        repoId,
        sessionsOnB: stateB.sessions.map((s) => s.id).sort(),
        deltaOnB: stateB.unpushedDeltas[0].symbolId.raw,
        bobDaemonSawDelta: true
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(worktreeRoot, { recursive: true, force: true });
}

function startServer(label, port) {
  startProcess(label, ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(port),
    SYNAPSE_DATABASE_URL: pgUrl,
    SYNAPSE_REDIS_URL: redisUrl
  });
}

function startDaemon(member, port, serverPort) {
  startProcess(member, [
    "apps/cli/dist/index.js",
    "daemon",
    "--member", member,
    "--session", member,
    "--repo-id", repoId,
    "--port", String(port),
    "--server", `ws://localhost:${serverPort}`,
    "--worktree-root", worktreeRoot
  ], {});
}

async function report(port) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId,
    sessionId: "alice",
    filePath
  });
}

async function writeFixture(source) {
  await writeFile(join(worktreeRoot, filePath), `${source.trim()}\n`);
}

async function getState(serverPort) {
  const response = await fetch(
    `http://localhost:${serverPort}/state?repoId=${encodeURIComponent(repoId)}`
  );
  assert.equal(response.ok, true, `/state on :${serverPort} answered`);
  return response.json();
}

async function waitForState(serverPort, predicate, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(
      `http://localhost:${serverPort}/state?repoId=${encodeURIComponent(repoId)}`
    ).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs);
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

async function waitForHttp(url, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
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
