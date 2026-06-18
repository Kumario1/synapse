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
// Reject case uses a distinct symbol so its proposal id never collides.
const symbolRawB = "ts:src/auth/token.ts#refresh";
const dependentRawB = "ts:src/routes/me.ts#handleRefresh";
// Semantic case: both sides report mutually exclusive signatures.
const symbolRawS = "ts:src/auth/token.ts#semanticGetUser";
const dependentRawS = "ts:src/routes/me.ts#handleSemanticGetUser";
// Timeout case runs against a second short-TTL server, with its own symbol.
const symbolRawC = "ts:src/auth/token.ts#revoke";
const dependentRawC = "ts:src/routes/me.ts#handleRevoke";

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

  // --- Reject case: bob rejects → pair voids + dismiss feedback, never resolves.
  const deltaBId = "alice-delta-2";
  alice.send(contractDeltaEnvelope(deltaBId, "delta-2", symbolRawB, dependentRawB));
  const deltaBAck = await readUntil(
    alice,
    (message) => message.type === "ack" && message.payload.forId === deltaBId
  );
  assert.equal(deltaBAck.payload.ok, true, "alice symB contract.delta acked ok");

  const aliceIntentBId = "alice-intent-b";
  alice.send(intentEnvelope(aliceIntentBId, "alice", symbolRawB));
  await readUntil(
    alice,
    (message) => message.type === "ack" && message.payload.forId === aliceIntentBId
  );

  const bobIntentBId = "bob-intent-b";
  bob.send(intentEnvelope(bobIntentBId, "bob", symbolRawB));
  await readUntil(
    bob,
    (message) => message.type === "ack" && message.payload.forId === bobIntentBId
  );

  const proposingB = await readUntil(
    bob,
    (message) =>
      message.type === "state.snapshot" &&
      (message.payload.teamState.resolutionProposals ?? []).some(
        (p) => p.symbol.raw === symbolRawB && p.status === "resolving"
      )
  );
  const proposalB = (proposingB.payload.teamState.resolutionProposals ?? []).find(
    (p) => p.symbol.raw === symbolRawB
  );
  assert.ok(proposalB, "expected a symB proposal");

  const aliceAckBId = "alice-resolution-ack-b";
  alice.send(resolutionAckEnvelope(aliceAckBId, "alice", proposalB.id, true));
  await readUntil(
    alice,
    (message) => message.type === "ack" && message.payload.forId === aliceAckBId
  );

  const bobRejectId = "bob-resolution-reject-b";
  bob.send(resolutionAckEnvelope(bobRejectId, "bob", proposalB.id, false));
  const bobRejectAck = await readUntil(
    bob,
    (message) => message.type === "ack" && message.payload.forId === bobRejectId
  );
  assert.equal(bobRejectAck.payload.ok, true, "bob reject acked ok");

  const afterReject = await readUntil(
    bob,
    (message) =>
      message.type === "state.snapshot" &&
      (message.payload.teamState.resolutionProposals ?? []).some(
        (p) => p.id === proposalB.id && p.status === "voided"
      )
  );
  const voidedB = proposalFrom(afterReject, proposalB.id);
  assert.equal(voidedB.status, "voided", "reject voids the pair");
  assert.equal(voidedB.voidReason, "rejected", "void reason is rejected");
  assert.notEqual(voidedB.status, "resolved", "a rejected proposal never resolves");
  const feedback = (afterReject.payload.teamState.conflictFeedback ?? []).find(
    (entry) => entry.conflictId === proposalB.id
  );
  assert.ok(feedback, "expected dismiss feedback for the rejected proposal");
  assert.equal(feedback.outcome, "dismissed", "reject is recorded as dismiss feedback");

  // --- Semantic case: divergent signatures escalate to Owner winner choice.
  const aliceDeltaSId = "alice-delta-semantic";
  alice.send(
    contractDeltaEnvelope(
      aliceDeltaSId,
      "delta-semantic-alice",
      symbolRawS,
      dependentRawS,
      "alice",
      { params: [], returns: "User | null", raw: "() => User | null" }
    )
  );
  await readUntil(
    alice,
    (message) => message.type === "ack" && message.payload.forId === aliceDeltaSId
  );

  const bobDeltaSId = "bob-delta-semantic";
  bob.send(
    contractDeltaEnvelope(bobDeltaSId, "delta-semantic-bob", symbolRawS, dependentRawS, "bob", {
      params: [{ name: "strict", type: "boolean", optional: false }],
      returns: "User",
      raw: "(strict: boolean) => User"
    })
  );
  await readUntil(
    bob,
    (message) => message.type === "ack" && message.payload.forId === bobDeltaSId
  );

  const aliceIntentSId = "alice-intent-semantic";
  alice.send(intentEnvelope(aliceIntentSId, "alice", symbolRawS));
  await readUntil(
    alice,
    (message) => message.type === "ack" && message.payload.forId === aliceIntentSId
  );

  const bobIntentSId = "bob-intent-semantic";
  bob.send(intentEnvelope(bobIntentSId, "bob", symbolRawS));
  await readUntil(
    bob,
    (message) => message.type === "ack" && message.payload.forId === bobIntentSId
  );

  const semanticSnapshot = await readUntil(
    bob,
    (message) =>
      message.type === "state.snapshot" &&
      (message.payload.teamState.resolutionProposals ?? []).some(
        (p) => p.symbol.raw === symbolRawS && p.status === "awaiting_owner"
      )
  );
  const semantic = (semanticSnapshot.payload.teamState.resolutionProposals ?? []).find(
    (p) => p.symbol.raw === symbolRawS
  );
  assert.ok(semantic, "expected a semantic proposal");
  assert.equal(semantic.conflictClass, "semantic", "divergent signatures are semantic");
  assert.equal(semantic.status, "awaiting_owner", "semantic proposals wait for the Owner");
  assert.deepEqual(semantic.directions, [], "semantic proposals do not fabricate directions");
  assert.equal(semantic.after, null, "semantic proposals do not fabricate a merged signature");
  assert.ok(semantic.candidates?.includes("alice"), "alice is a semantic candidate");
  assert.ok(semantic.candidates?.includes("bob"), "bob is a semantic candidate");
  await assert.rejects(
    readUntil(
      bob,
      (message) =>
        message.type === "state.snapshot" &&
        (message.payload.teamState.resolutionProposals ?? []).some(
          (p) => p.id === semantic.id && p.status === "resolved"
        ),
      1000
    ),
    /timed out/,
    "semantic proposal must not auto-resolve before owner choice"
  );

  alice.socket.close();
  bob.socket.close();

  // --- Timeout case: a separate short-TTL server voids an un-acked proposal.
  const timeoutPort = await freePort();
  startProcess("server-ttl", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(timeoutPort),
    SYNAPSE_RESOLUTION_TTL_MS: "800"
  });
  await waitForHttp(`http://localhost:${timeoutPort}/health`);

  const carol = await openSocket(`ws://localhost:${timeoutPort}?repoId=${repoId}&v=2`);
  const dave = await openSocket(`ws://localhost:${timeoutPort}?repoId=${repoId}&v=2`);
  await readUntil(carol, (message) => message.type === "state.snapshot");
  await readUntil(dave, (message) => message.type === "state.snapshot");

  const deltaCId = "carol-delta-c";
  carol.send(contractDeltaEnvelope(deltaCId, "delta-c", symbolRawC, dependentRawC));
  await readUntil(carol, (message) => message.type === "ack" && message.payload.forId === deltaCId);

  const carolIntentId = "carol-intent-c";
  carol.send(intentEnvelope(carolIntentId, "alice", symbolRawC));
  await readUntil(
    carol,
    (message) => message.type === "ack" && message.payload.forId === carolIntentId
  );

  const daveIntentId = "dave-intent-c";
  dave.send(intentEnvelope(daveIntentId, "bob", symbolRawC));
  await readUntil(
    dave,
    (message) => message.type === "ack" && message.payload.forId === daveIntentId
  );

  const proposingC = await readUntil(
    dave,
    (message) =>
      message.type === "state.snapshot" &&
      (message.payload.teamState.resolutionProposals ?? []).some(
        (p) => p.symbol.raw === symbolRawC && p.status === "resolving"
      )
  );
  const proposalC = (proposingC.payload.teamState.resolutionProposals ?? []).find(
    (p) => p.symbol.raw === symbolRawC
  );
  assert.ok(proposalC, "expected a symC proposal");

  // Send no acks; wait for the TTL to elapse and void the proposal.
  const afterTimeout = await readUntil(
    dave,
    (message) =>
      message.type === "state.snapshot" &&
      (message.payload.teamState.resolutionProposals ?? []).some(
        (p) => p.id === proposalC.id && p.status === "voided"
      ),
    5000
  );
  const voidedC = proposalFrom(afterTimeout, proposalC.id);
  assert.equal(voidedC.status, "voided", "timeout voids the pair");
  assert.equal(voidedC.voidReason, "timeout", "void reason is timeout");
  assert.notEqual(voidedC.status, "resolved", "a timed-out proposal never resolves");

  carol.socket.close();
  dave.socket.close();

  console.log("Mediator verification passed (resolve + reject + semantic + timeout):");
  console.log(
    JSON.stringify(
      {
        resolve: {
          proposalId: proposal.id,
          status: resolved.status,
          acceptedBy: resolved.acceptedBy
        },
        reject: {
          proposalId: proposalB.id,
          status: voidedB.status,
          voidReason: voidedB.voidReason
        },
        semantic: {
          proposalId: semantic.id,
          status: semantic.status,
          candidates: semantic.candidates,
          after: semantic.after
        },
        timeout: {
          proposalId: proposalC.id,
          status: voidedC.status,
          voidReason: voidedC.voidReason
        }
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
}

function contractDeltaEnvelope(
  id,
  deltaId = "delta-1",
  symbol = symbolRaw,
  dependent = dependentRaw,
  sessionId = "alice",
  after = { params: [], returns: "User | null", raw: "() => User | null" }
) {
  return {
    v: 2,
    id,
    ts: new Date().toISOString(),
    type: "contract.delta",
    payload: {
      delta: {
        id: deltaId,
        repoId,
        sessionId,
        symbolId: { raw: symbol },
        changeKind: "signature_changed",
        before: { params: [], returns: "User", raw: "() => User" },
        after,
        summary: "getUser can return null",
        filePath: "src/auth/token.ts",
        baseSha: "abc123",
        dependents: [{ raw: dependent }],
        createdAt: new Date().toISOString(),
        pushedAt: null
      }
    }
  };
}

function intentEnvelope(id, sessionId, symbol = symbolRaw) {
  return {
    v: 2,
    id,
    ts: new Date().toISOString(),
    type: "edit.intent",
    payload: {
      repoId,
      sessionId,
      symbolId: { raw: symbol },
      filePath: "src/auth/token.ts"
    }
  };
}

function resolutionAckEnvelope(id, sessionId, proposalId, accept = true) {
  return {
    v: 2,
    id,
    ts: new Date().toISOString(),
    type: "resolution.ack",
    payload: {
      repoId,
      sessionId,
      proposalId,
      accept
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
