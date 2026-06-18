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
const symbolRaw = "ts:src/auth/token.ts#getUser";
const dependentRaw = "ts:src/routes/me.ts#handleMe";

try {
  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = await openSocket(`ws://localhost:${serverPort}?repoId=${repoId}&v=2`);
  const bob = await openSocket(`ws://localhost:${serverPort}?repoId=${repoId}&v=2`);
  await readUntil(alice, (message) => message.type === "state.snapshot");
  await readUntil(bob, (message) => message.type === "state.snapshot");

  const deltaId = "alice-delta-1";
  alice.send(contractDeltaEnvelope(deltaId));
  const deltaAck = await readUntil(
    alice,
    (message) => message.type === "ack" && message.payload.forId === deltaId
  );
  assert.equal(deltaAck.payload.ok, true, "alice contract.delta acked ok");

  const aliceIntentId = "alice-intent-1";
  alice.send(intentEnvelope(aliceIntentId, "alice"));
  const aliceAck = await readUntil(
    alice,
    (message) => message.type === "ack" && message.payload.forId === aliceIntentId
  );
  assert.equal(aliceAck.payload.ok, true, "alice intent acked ok");

  const bobIntentId = "bob-intent-1";
  bob.send(intentEnvelope(bobIntentId, "bob"));
  const bobAck = await readUntil(
    bob,
    (message) => message.type === "ack" && message.payload.forId === bobIntentId
  );
  assert.equal(bobAck.payload.ok, true, "bob intent acked ok");
  assert.ok(
    (bobAck.payload.locks ?? []).some(
      (lock) => lock.sessionId === "alice" && lock.symbolId.raw === symbolRaw
    ),
    "bob ack includes alice's peer lock"
  );

  const proposingSnapshot = await readUntil(
    bob,
    (message) =>
      message.type === "state.snapshot" &&
      (message.payload.teamState.resolutionProposals ?? []).some(
        (proposal) => proposal.symbol.raw === symbolRaw && proposal.status === "resolving"
      )
  );
  const proposal = (proposingSnapshot.payload.teamState.resolutionProposals ?? []).find(
    (candidate) => candidate.symbol.raw === symbolRaw
  );
  assert.ok(proposal, "expected a mediator proposal");
  assert.equal(proposal.conflictClass, "mechanical");
  assert.equal(proposal.status, "resolving");
  const keep = proposal.directions.find((direction) => direction.role === "keep");
  const adapt = proposal.directions.find((direction) => direction.role === "adapt");
  assert.equal(keep?.sessionId, "alice", "alice is the keep side");
  assert.equal(adapt?.sessionId, "bob", "bob is the adapt side");
  assert.deepEqual(adapt?.affectedSites, [
    { symbolId: { raw: dependentRaw }, filePath: "src/routes/me.ts" }
  ]);

  const aliceResolutionAckId = "alice-resolution-ack";
  alice.send(resolutionAckEnvelope(aliceResolutionAckId, "alice", proposal.id));
  const aliceResolutionAck = await readUntil(
    alice,
    (message) => message.type === "ack" && message.payload.forId === aliceResolutionAckId
  );
  assert.equal(aliceResolutionAck.payload.ok, true, "alice resolution acked ok");
  const afterAlice = await readUntil(
    bob,
    (message) =>
      message.type === "state.snapshot" &&
      (message.payload.teamState.resolutionProposals ?? []).some((candidate) =>
        candidate.acceptedBy.includes("alice")
      )
  );
  const resolving = proposalFrom(afterAlice, proposal.id);
  assert.equal(resolving.status, "resolving", "one accept leaves proposal resolving");
  assert.deepEqual(resolving.acceptedBy, ["alice"]);

  const bobResolutionAckId = "bob-resolution-ack";
  bob.send(resolutionAckEnvelope(bobResolutionAckId, "bob", proposal.id));
  const bobResolutionAck = await readUntil(
    bob,
    (message) => message.type === "ack" && message.payload.forId === bobResolutionAckId
  );
  assert.equal(bobResolutionAck.payload.ok, true, "bob resolution acked ok");
  const afterBob = await readUntil(
    bob,
    (message) =>
      message.type === "state.snapshot" &&
      (message.payload.teamState.resolutionProposals ?? []).some(
        (candidate) => candidate.id === proposal.id && candidate.status === "resolved"
      )
  );
  const resolved = proposalFrom(afterBob, proposal.id);
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.acceptedBy, ["alice", "bob"]);

  alice.socket.close();
  bob.socket.close();

  console.log("Mediator verification passed:");
  console.log(
    JSON.stringify(
      {
        proposalId: proposal.id,
        status: resolved.status,
        acceptedBy: resolved.acceptedBy,
        affectedSites: adapt?.affectedSites ?? []
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
}

function contractDeltaEnvelope(id) {
  return {
    v: 2,
    id,
    ts: new Date().toISOString(),
    type: "contract.delta",
    payload: {
      delta: {
        id: "delta-1",
        repoId,
        sessionId: "alice",
        symbolId: { raw: symbolRaw },
        changeKind: "signature_changed",
        before: { params: [], returns: "User", raw: "() => User" },
        after: { params: [], returns: "User | null", raw: "() => User | null" },
        summary: "getUser can return null",
        filePath: "src/auth/token.ts",
        baseSha: "abc123",
        dependents: [{ raw: dependentRaw }],
        createdAt: new Date().toISOString(),
        pushedAt: null
      }
    }
  };
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
      filePath: "src/auth/token.ts"
    }
  };
}

function resolutionAckEnvelope(id, sessionId, proposalId) {
  return {
    v: 2,
    id,
    ts: new Date().toISOString(),
    type: "resolution.ack",
    payload: {
      repoId,
      sessionId,
      proposalId,
      accept: true
    }
  };
}

function proposalFrom(snapshot, proposalId) {
  const proposal = (snapshot.payload.teamState.resolutionProposals ?? []).find(
    (candidate) => candidate.id === proposalId
  );
  assert.ok(proposal, `expected proposal ${proposalId}`);
  return proposal;
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
