import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectKey } from "@synapse/protocol";
import { WebSocket } from "ws";

// Prove project-key tenancy: with SYNAPSE_MASTER_SECRET set, a key minted for
// repo A authorizes A and ONLY A. Key A reads GET /state?repoId=A (200) but is
// rejected for repoId=B (401); a WS handshake for B with key A is rejected; and
// a daemon authorized for A that sends a message carrying repoId=B is rejected
// with `forbidden_repo`, leaving B's state empty. /health stays open.
// Hermetic: pin the room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const masterSecret = "master-secret-for-tenancy-test";
const repoA = "github.com/acme/alpha";
const repoB = "github.com/acme/bravo";
const keyA = deriveProjectKey(masterSecret, repoA);
const keyB = deriveProjectKey(masterSecret, repoB);
assert.notEqual(keyA, keyB, "keys for different repos must differ");

const serverPort = await freePort();
const alicePort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-tenancy-"));
const filePath = "src/auth/token.ts";

try {
  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort),
    SYNAPSE_MASTER_SECRET: masterSecret
  });
  await waitForHttp(`http://localhost:${serverPort}/health`); // /health is open

  // 1. Key A reads its own repo but is rejected for repo B.
  const okA = await fetch(stateUrl(repoA, keyA));
  assert.equal(okA.status, 200, "GET /state for repo A with key A succeeds");

  const crossTenant = await fetch(stateUrl(repoB, keyA));
  assert.equal(crossTenant.status, 401, "key A cannot read repo B (cross-tenant)");

  const noKey = await fetch(`http://localhost:${serverPort}/state?repoId=${encodeURIComponent(repoA)}`);
  assert.equal(noKey.status, 401, "GET /state without a key is unauthorized");

  // Key B reads its own repo (sanity: the secret/derivation round-trips).
  const okB = await fetch(stateUrl(repoB, keyB));
  assert.equal(okB.status, 200, "GET /state for repo B with key B succeeds");

  // 2. A WS handshake for repo B presenting key A is rejected; for repo A it connects.
  assert.equal(await wsHandshake(repoB, keyA), "rejected", "WS for B with key A is rejected");
  assert.equal(await wsHandshake(repoA, keyA), "open", "WS for A with key A connects");

  // 3. A daemon authorized for A connects and works normally on A.
  await writeFixture(aliceRoot, "export function validate(input: string): boolean { return !!input; }");
  startDaemon("alice", alicePort, aliceRoot, repoA, keyA);
  await waitForHttp(`http://localhost:${alicePort}/health`);
  await waitForState(repoA, keyA, (s) => s.sessions.some((session) => session.id === "alice"));

  // 4. The same connection cannot write into repo B: a message carrying repoId=B
  // is rejected with `forbidden_repo`, and B's state stays empty.
  const ack = await wsCarryingForeignRepo(repoA, keyA, repoB);
  assert.equal(ack.ok, false, "a message targeting a foreign repo is not applied");
  assert.equal(ack.error, "forbidden_repo", "foreign-repo writes are rejected with forbidden_repo");

  const stateB = await (await fetch(stateUrl(repoB, keyB))).json();
  assert.equal(stateB.sessions.length, 0, "repo B has no sessions — the foreign write never landed");

  console.log("Tenancy verification passed:");
  console.log(
    JSON.stringify(
      {
        crossTenantState: 401,
        ownTenantState: 200,
        wsForeignRepo: "rejected",
        foreignMessage: "forbidden_repo",
        repoBSessions: stateB.sessions.length
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(aliceRoot, { recursive: true, force: true });
}

function stateUrl(repoId, key) {
  return `http://localhost:${serverPort}/state?repoId=${encodeURIComponent(repoId)}&token=${encodeURIComponent(key)}`;
}

function wsHandshake(repoId, key) {
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(
      `ws://localhost:${serverPort}?repoId=${encodeURIComponent(repoId)}&sessionId=probe&token=${encodeURIComponent(key)}`
    );
    let settled = false;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise(result);
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    ws.on("error", () => settle("rejected"));
    ws.on("unexpected-response", () => settle("rejected"));
    ws.on("open", () => settle("open"));
  });
}

// Open an authorized connection for `repoId` and send a session.start whose
// payload targets `foreignRepoId`; resolve with the server's ack payload.
function wsCarryingForeignRepo(repoId, key, foreignRepoId) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${serverPort}?repoId=${encodeURIComponent(repoId)}&sessionId=intruder&token=${encodeURIComponent(key)}`
    );
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out waiting for ack"));
    }, 5000);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          v: 1,
          type: "session.start",
          id: "intruder-msg",
          ts: new Date().toISOString(),
          payload: {
            session: {
              id: "intruder",
              repoId: foreignRepoId,
              memberId: "intruder",
              agentType: "other",
              filesOpen: [],
              filesEditing: [],
              lastTask: null,
              startedAt: new Date().toISOString(),
              lastSeen: new Date().toISOString(),
              status: "active"
            }
          }
        })
      );
    });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "ack" && message.payload.forId === "intruder-msg") {
        clearTimeout(timer);
        ws.close();
        resolvePromise(message.payload);
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function startDaemon(member, port, worktreeRoot, repoId, key) {
  return startProcess(
    member,
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      member,
      "--session",
      member,
      "--repo-id",
      repoId,
      "--port",
      String(port),
      "--server",
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot,
      "--key",
      key
    ],
    {}
  );
}

async function writeFixture(worktreeRoot, source) {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFile(join(worktreeRoot, filePath), `${source}\n`);
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
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      process.stderr.write(`[${label}] exited with code ${code ?? signal}\n`);
    }
  });
  return child;
}

async function waitForHttp(url, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function waitForState(repoId, key, predicate, timeoutMs = 6000) {
  await waitFor(async () => {
    const response = await fetch(stateUrl(repoId, key)).catch(() => null);
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
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
