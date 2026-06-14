import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Protocol version negotiation (plan M15): versions are exchanged at the WS
// handshake. A legacy client (no announcement) still connects as v1; a newer
// client downgrades gracefully to the server's dialect; a client outside the
// supported range is refused at the handshake with HTTP 426 and the server's
// range in headers — never opaque per-message failures. The upgrade response
// advertises the server's dialect so clients can verify from their side.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(rootDir, "apps/server/package.json"));
const wsModule = await import(require.resolve("ws"));
const WebSocket = wsModule.WebSocket ?? wsModule.default;
const children = [];

const serverPort = await freePort();

try {
  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  // /health reports the full supported range for doctor-style preflights.
  const health = await (await fetch(`http://localhost:${serverPort}/health`)).json();
  assert.equal(typeof health.protocolVersion, "number");
  assert.equal(typeof health.minProtocolVersion, "number");
  assert.ok(health.minProtocolVersion <= health.protocolVersion);

  // 1. A current client announces its version and the upgrade response
  //    advertises the server's dialect.
  const current = await openSocket(`ws://localhost:${serverPort}?repoId=local&v=${health.protocolVersion}`);
  assert.equal(current.headers["x-synapse-protocol"], String(health.protocolVersion));
  assert.equal(current.headers["x-synapse-protocol-min"], String(health.minProtocolVersion));
  const currentSnapshot = await current.firstMessage;
  assert.equal(currentSnapshot.type, "state.snapshot", "current client gets the snapshot");
  assert.equal(currentSnapshot.v, 2, "current client gets v2 envelopes");
  current.socket.close();

  // 2. A legacy client (no announcement at all) still connects as v1.
  const legacy = await openSocket(`ws://localhost:${serverPort}?repoId=local`);
  const legacySnapshot = await legacy.firstMessage;
  assert.equal(legacySnapshot.type, "state.snapshot", "legacy client still connects (assumed v1)");
  assert.equal(legacySnapshot.v, 1, "legacy client gets v1 snapshots");
  legacy.socket.send(
    JSON.stringify({
      v: 1,
      type: "query.briefing",
      id: "legacy-query-1",
      ts: new Date().toISOString(),
      payload: { repoId: "local" }
    })
  );
  const legacyAck = await readMessage(legacy.socket);
  assert.equal(legacyAck.type, "ack", "legacy client gets an ack");
  assert.equal(legacyAck.v, 1, "legacy client gets v1 acks");
  legacy.socket.close();

  // 3. A newer client downgrades gracefully: accepted, served the server's
  //    (v1) dialect rather than refused.
  const future = await openSocket(`ws://localhost:${serverPort}?repoId=local&v=99`);
  const futureSnapshot = await future.firstMessage;
  assert.equal(futureSnapshot.type, "state.snapshot", "newer client accepted");
  assert.equal(futureSnapshot.v, health.protocolVersion, "served the negotiated (server) dialect");
  future.socket.close();

  // 4. A client outside the supported range is refused at the handshake with
  //    a clear status and the server's range in headers.
  const refusal = await expectRefusal(`ws://localhost:${serverPort}?repoId=local&v=0`);
  assert.equal(refusal.statusCode, 426, "handshake refused with 426 Upgrade Required");
  assert.equal(refusal.headers["x-synapse-protocol"], String(health.protocolVersion));
  assert.equal(refusal.headers["x-synapse-protocol-min"], String(health.minProtocolVersion));

  console.log("Protocol compatibility verification passed:");
  console.log(
    JSON.stringify(
      {
        range: `${health.minProtocolVersion}-${health.protocolVersion}`,
        legacyClient: "accepted",
        newerClient: `downgraded to v${futureSnapshot.v}`,
        outOfRangeClient: `refused ${refusal.statusCode}`
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
}

function readMessage(socket) {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let headers = {};
    socket.on("upgrade", (response) => {
      headers = response.headers;
    });
    const firstMessage = new Promise((resolveMessage) => {
      socket.once("message", (data) => resolveMessage(JSON.parse(data.toString())));
    });
    socket.on("open", () => resolve({ socket, headers, firstMessage }));
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`timed out opening ${url}`)), 5000).unref();
  });
}

function expectRefusal(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("unexpected-response", (_request, response) => {
      resolve({ statusCode: response.statusCode, headers: response.headers });
      socket.terminate();
    });
    socket.on("open", () => reject(new Error(`expected a refusal for ${url}, but it connected`)));
    socket.on("error", () => {});
    setTimeout(() => reject(new Error(`timed out waiting for refusal from ${url}`)), 5000).unref();
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
