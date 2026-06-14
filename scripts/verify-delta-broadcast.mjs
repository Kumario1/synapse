import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(rootDir, "apps/server/package.json"));
const wsModule = await import(require.resolve("ws"));
const WebSocket = wsModule.WebSocket ?? wsModule.default;
const children = [];

const serverPort = await freePort();
const repoId = "local";

try {
  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);
  const health = await (await fetch(`http://localhost:${serverPort}/health`)).json();
  assert.equal(health.protocolVersion, 2, "server advertises protocol v2");

  const v2 = await openSocket(`ws://localhost:${serverPort}?repoId=${repoId}&v=2`);
  const v1 = await openSocket(`ws://localhost:${serverPort}?repoId=${repoId}`);
  const v2Join = await v2.nextMessage();
  const v1Join = await v1.nextMessage();
  assert.equal(v2Join.type, "state.snapshot", "v2 client gets a baseline snapshot");
  assert.equal(v2Join.v, 2, "v2 baseline snapshot is stamped v2");
  assert.equal(v1Join.type, "state.snapshot", "legacy client gets a baseline snapshot");
  assert.equal(v1Join.v, 1, "legacy baseline snapshot is stamped v1");
  assert.equal(v2Join.payload.seq, 0, "baseline snapshot carries seq");

  v2.send({
    v: 2,
    type: "session.start",
    id: "session-start-1",
    ts: new Date().toISOString(),
    payload: {
      session: {
        id: "alice",
        repoId,
        memberId: "alice",
        agentType: "claude-code",
        filesOpen: [],
        filesEditing: [],
        lastTask: null,
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        status: "active"
      }
    }
  });

  const v2Ack = await readUntil(v2, (message) => message.type === "ack");
  assert.equal(v2Ack.v, 2, "v2 ack is stamped v2");
  assert.equal(v2Ack.payload.ok, true, "mutation acked");
  const delta = await readUntil(v2, (message) => message.type === "state.delta");
  assert.equal(delta.v, 2, "v2 delta is stamped v2");
  assert.equal(delta.payload.repoId, repoId);
  assert.equal(delta.payload.seq, 1);
  assert.deepEqual(
    delta.payload.ops.map((op) => op.op),
    ["upsertSession"],
    "v2 client receives the per-entity op"
  );

  const legacySnapshot = await readUntil(v1, (message) => message.type === "state.snapshot");
  assert.equal(legacySnapshot.v, 1, "legacy mutation update is a v1 snapshot");
  assert.equal(legacySnapshot.payload.seq, 1);
  assert.equal(legacySnapshot.payload.teamState.sessions.length, 1);
  assert.equal(legacySnapshot.payload.teamState.sessions[0].id, "alice");

  const serverState = await getState(serverPort);
  assert.deepEqual(
    delta.payload.ops[0].session,
    serverState.sessions[0],
    "delta payload converges to the server snapshot state"
  );

  v2.socket.close();
  v1.socket.close();

  console.log("Delta broadcast verification passed:");
  console.log(
    JSON.stringify(
      {
        v2: "state.delta",
        legacy: "state.snapshot",
        seq: delta.payload.seq,
        ops: delta.payload.ops.map((op) => op.op)
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const queue = [];
    const waiters = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        queue.push(message);
      }
    });
    socket.on("open", () =>
      resolve({
        socket,
        send: (message) => socket.send(JSON.stringify(message)),
        nextMessage: (timeoutMs = 5000) => {
          if (queue.length > 0) {
            return Promise.resolve(queue.shift());
          }
          return new Promise((resolveMessage, rejectMessage) => {
            const waiter = {
              resolve: resolveMessage,
              timer: setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index !== -1) {
                  waiters.splice(index, 1);
                }
                rejectMessage(new Error("timed out waiting for websocket message"));
              }, timeoutMs)
            };
            waiters.push(waiter);
          });
        }
      })
    );
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`timed out opening ${url}`)), 5000).unref();
  });
}

async function readUntil(client, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    const message = await client.nextMessage(remaining);
    if (predicate(message)) {
      return message;
    }
  }
  throw new Error("timed out waiting for expected websocket message");
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

async function getState(port) {
  const response = await fetch(`http://localhost:${port}/state?repoId=${repoId}`);
  if (!response.ok) {
    throw new Error(`/state failed: ${response.status}`);
  }
  return response.json();
}

async function waitForHttp(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
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
