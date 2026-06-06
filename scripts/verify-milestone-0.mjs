import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const symbol = "ts:src/auth/token.ts#TokenValidator.validate";

try {
  const server = startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });

  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = startProcess(
    "alice",
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      "alice",
      "--session",
      "alice",
      "--port",
      String(alicePort),
      "--server",
      `ws://localhost:${serverPort}`
    ],
    {}
  );

  const bob = startProcess(
    "bob",
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      "bob",
      "--session",
      "bob",
      "--port",
      String(bobPort),
      "--server",
      `ws://localhost:${serverPort}`
    ],
    {}
  );

  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);

  await waitForState(serverPort, (state) => state.sessions.length === 2);

  await postJson(`http://localhost:${alicePort}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath: "src/auth/token.ts",
    symbolId: { raw: symbol },
    summary: "TokenValidator.validate now returns Result<Token, AuthError>"
  });

  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  const check = await postJson(`http://localhost:${bobPort}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: ["src/auth/token.ts"],
    symbols: [{ raw: symbol }]
  });

  assert.equal(check.verdict, "warn");
  assert.equal(check.degraded, false);
  assert.deepEqual(
    check.conflicts.map((conflict) => conflict.rule),
    ["same_symbol_unpushed"]
  );

  console.log("Milestone 0 verification passed:");
  console.log(JSON.stringify(check, null, 2));

  server.kill();
  alice.kill();
  bob.kill();
} finally {
  await stopChildren();
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

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
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
