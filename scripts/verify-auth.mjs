import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// Prove the optional shared-token auth: with SYNAPSE_AUTH_TOKEN set, the server
// rejects an unauthenticated WSS handshake and GET /state, accepts both with the
// token, and the daemon (configured with the token) connects and reports
// normally. /health stays open.
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
const token = "s3cr3t-token";

const serverPort = await freePort();
const alicePort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-auth-"));
const filePath = "src/auth/token.ts";

try {
  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort),
    SYNAPSE_AUTH_TOKEN: token
  });
  await waitForHttp(`http://localhost:${serverPort}/health`); // /health is open

  // 1. GET /state without a token is rejected; with the token it succeeds.
  const noAuth = await fetch(`http://localhost:${serverPort}/state?repoId=local`);
  assert.equal(noAuth.status, 401, "GET /state without a token is unauthorized");

  const badAuth = await fetch(`http://localhost:${serverPort}/state?repoId=local&token=wrong`);
  assert.equal(badAuth.status, 401, "GET /state with the wrong token is unauthorized");

  const okAuth = await fetch(`http://localhost:${serverPort}/state?repoId=local&token=${token}`);
  assert.equal(okAuth.status, 200, "GET /state with the token succeeds");

  // Authorization: Bearer header also works.
  const bearer = await fetch(`http://localhost:${serverPort}/state?repoId=local`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(bearer.status, 200, "Bearer header is accepted");

  // 2. A WSS handshake without the token is rejected; with it, it connects.
  assert.equal(await wsHandshake(""), "rejected", "WSS without a token is rejected");
  assert.equal(await wsHandshake(`&token=${token}`), "open", "WSS with the token connects");

  // 3. The daemon, given the token, connects and the normal flow works.
  await writeFixture(aliceRoot, "export function validate(input: string): boolean { return !!input; }");
  startDaemon("alice", alicePort, aliceRoot, token);
  await waitForHttp(`http://localhost:${alicePort}/health`);
  await waitForState(serverPort, (s) => s.sessions.some((session) => session.id === "alice"));

  await report(alicePort);
  await writeFixture(aliceRoot, "export function validate(input: string): string { return input; }");
  await report(alicePort);
  await waitForState(serverPort, (s) =>
    s.unpushedDeltas.some((d) => d.symbolId.raw === "ts:src/auth/token.ts#validate")
  );

  console.log("Auth verification passed:");
  console.log(
    JSON.stringify(
      { stateNoToken: 401, stateWithToken: 200, wsNoToken: "rejected", wsWithToken: "open", daemonFlow: "ok" },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(aliceRoot, { recursive: true, force: true });
}

function wsHandshake(tokenParam) {
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(`ws://localhost:${serverPort}?repoId=local&sessionId=probe${tokenParam}`);
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
    // Persistent error handler so a post-close error never goes unhandled.
    ws.on("error", () => settle("rejected"));
    ws.on("unexpected-response", () => settle("rejected"));
    ws.on("open", () => settle("open"));
  });
}

function startDaemon(member, port, worktreeRoot, authToken) {
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
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot,
      "--token",
      authToken
    ],
    {}
  );
}

async function writeFixture(worktreeRoot, source) {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFile(join(worktreeRoot, filePath), `${source}\n`);
}

async function report(port) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath
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

async function waitForState(port, predicate, timeoutMs = 6000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=local&token=${token}`).catch(
      () => null
    );
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
