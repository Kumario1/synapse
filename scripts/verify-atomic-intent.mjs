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
const symbolRaw = "ts:src/widget.ts#area";

try {
  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  // Two clients in the same repo room, both protocol v2.
  const alice = await openSocket(`ws://localhost:${serverPort}?repoId=${repoId}&v=2`);
  const bob = await openSocket(`ws://localhost:${serverPort}?repoId=${repoId}&v=2`);
  // Drain each client's baseline snapshot.
  await readUntil(alice, (m) => m.type === "state.snapshot");
  await readUntil(bob, (m) => m.type === "state.snapshot");

  // Alice registers intent on the symbol first; her ack should carry no peer
  // locks (no one else holds it yet).
  const aliceIntentId = "alice-intent-1";
  alice.send(intentEnvelope(aliceIntentId, "alice"));
  const aliceAck = await readUntil(
    alice,
    (m) => m.type === "ack" && m.payload.forId === aliceIntentId
  );
  assert.equal(aliceAck.payload.ok, true, "alice intent acked ok");
  assert.deepEqual(aliceAck.payload.locks ?? [], [], "alice's ack carries no peer locks");

  // Bob registers intent on the SAME symbol WITHOUT alice ever sending a
  // contract.delta. The server serializes the two intents, so bob's ack must
  // reflect alice's lock — this is the race the plan closes.
  const bobIntentId = "bob-intent-1";
  bob.send(intentEnvelope(bobIntentId, "bob"));
  const bobAck = await readUntil(
    bob,
    (m) => m.type === "ack" && m.payload.forId === bobIntentId
  );
  assert.equal(bobAck.payload.ok, true, "bob intent acked ok");
  assert.ok(Array.isArray(bobAck.payload.locks), "bob's ack carries a locks array");
  const aliceLock = (bobAck.payload.locks ?? []).find(
    (lock) => lock.sessionId === "alice" && lock.symbolId.raw === symbolRaw
  );
  assert.ok(
    aliceLock,
    `bob's ack must include alice's lock on ${symbolRaw}; got ${JSON.stringify(bobAck.payload.locks)}`
  );

  alice.socket.close();
  bob.socket.close();

  console.log("Atomic intent verification passed:");
  console.log(
    JSON.stringify(
      {
        aliceAckLocks: aliceAck.payload.locks ?? [],
        bobAckLocks: bobAck.payload.locks ?? []
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
}

function intentEnvelope(id, sessionId) {
  return {
    v: 2,
    id,
    ts: new Date().toISOString(),
    type: "edit.intent",
    payload: {
      repoId,
      sessionId,
      symbolId: { raw: symbolRaw },
      filePath: "src/widget.ts"
    }
  };
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
