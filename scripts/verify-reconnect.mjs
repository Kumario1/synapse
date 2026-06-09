import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Prove the daemon↔server channel survives a server outage with NO message
// loss: a delta reported while the server is up persists across its restart
// (SQLite store), and a delta reported while the server is DOWN is queued in
// the daemon's offline outbox and flushed on reconnect. Before this existed,
// `sendToServer` silently dropped messages on a closed socket — the team never
// learned about the change.
// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const worktreeRoot = await mkdtemp(join(tmpdir(), "synapse-reconnect-"));
const dbDir = await mkdtemp(join(tmpdir(), "synapse-reconnect-db-"));
const dbPath = join(dbDir, "state.db");
const filePath = "src/auth/token.ts";
const secondFile = "src/auth/refresh.ts";

try {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFixture(filePath, `
    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);
  await writeFixture(secondFile, `
    export function refresh(token: string): string {
      return token;
    }
  `);

  // --- Boot 1: daemon connects, reports a signature change. ---
  let server = startServer();
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = startProcess(
    "alice",
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member", "alice",
      "--session", "alice",
      "--port", String(alicePort),
      "--server", `ws://localhost:${serverPort}`,
      "--worktree-root", worktreeRoot
    ],
    // Fast, bounded backoff so the verifier completes quickly.
    { SYNAPSE_RECONNECT_BASE_MS: "100", SYNAPSE_RECONNECT_MAX_MS: "500" }
  );
  await waitForHttp(`http://localhost:${alicePort}/health`);
  await waitForState(serverPort, (state) => state.sessions.length === 1);

  await report(filePath); // baseline snapshot
  await writeFixture(filePath, `
    export function validate(input: string): { value: string } | null {
      return input ? { value: input } : null;
    }
  `);
  const first = await report(filePath);
  assert.equal(first.deltas.length, 1, "first delta was extracted");
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  // --- Outage: kill the server, report another change while it is DOWN. ---
  await stopChild(server);
  await report(secondFile); // baseline snapshot for the second file (queued)
  await writeFixture(secondFile, `
    export function refresh(token: string, force: boolean): string {
      return force ? token : token;
    }
  `);
  const offline = await report(secondFile);
  assert.equal(offline.deltas.length, 1, "the daemon still extracts deltas while offline");

  // --- Boot 2: same port + same DB. Daemon must reconnect and flush. ---
  server = startServer();
  await waitForHttp(`http://localhost:${serverPort}/health`);

  await waitForState(
    serverPort,
    (state) =>
      state.unpushedDeltas.length === 2 &&
      state.sessions.some((session) => session.id === "alice"),
    15_000
  );
  const state = await getState(serverPort);
  const symbols = state.unpushedDeltas.map((delta) => delta.symbolId.raw).sort();
  assert.deepEqual(
    symbols,
    ["ts:src/auth/refresh.ts#refresh", "ts:src/auth/token.ts#validate"],
    "the pre-outage delta survived the restart AND the during-outage delta was flushed from the outbox"
  );

  console.log("Reconnect verification passed:");
  console.log(
    JSON.stringify(
      { survivedDelta: symbols[1], flushedDelta: symbols[0], sessions: state.sessions.length },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(worktreeRoot, { recursive: true, force: true });
  await rm(dbDir, { recursive: true, force: true });
}

function startServer() {
  return startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort),
    SYNAPSE_DB_PATH: dbPath
  });
}

async function writeFixture(path, source) {
  await writeFile(join(worktreeRoot, path), `${source.trim()}\n`);
}

async function report(path) {
  return postJson(`http://localhost:${alicePort}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath: path
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

async function getState(port) {
  const response = await fetch(`http://localhost:${port}/state?repoId=local`);
  if (!response.ok) {
    throw new Error(`/state failed: ${response.status}`);
  }
  return response.json();
}

async function waitForHttp(url, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function waitForState(port, predicate, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=local`).catch(() => null);
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

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function stopChildren() {
  await Promise.all(children.map((child) => stopChild(child)));
}
