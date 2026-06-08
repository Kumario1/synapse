import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(rootDir, "apps/cli/dist/index.js");
const children = [];

const serverPort = await freePort();
const daemonPort = await freePort();
const tempRoot = await mkdtemp(join(tmpdir(), "synapse-join-config-"));
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#validate";

try {
  const joinOutput = runCli(
    [
      "join",
      "--repo-id",
      "joined-repo",
      "--member",
      "alice",
      "--session",
      "alice-session",
      "--agent",
      "claude-code",
      "--port",
      String(daemonPort),
      "--server",
      `ws://localhost:${serverPort}`
    ],
    tempRoot
  );
  assert.match(joinOutput.stdout, /wrote .*\.synapse\/config\.json/u);
  assert.match(joinOutput.stdout, /synapse\/cli -- daemon/u);

  const config = JSON.parse(await readFile(join(tempRoot, ".synapse/config.json"), "utf8"));
  assert.equal(config.repoId, "joined-repo");
  assert.equal(config.member, "alice");
  assert.equal(config.sessionId, "alice-session");
  assert.equal(config.agentType, "claude-code");
  assert.equal(config.daemonPort, daemonPort);
  assert.equal(config.serverUrl, `ws://localhost:${serverPort}`);
  assert.equal(config.worktreeRoot, tempRoot);

  const server = startProcess("server", ["apps/server/dist/index.js"], rootDir, {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const daemon = startProcess("daemon", [cliPath, "daemon"], tempRoot, {
    INIT_CWD: tempRoot
  });
  await waitForHttp(`http://localhost:${daemonPort}/health`);

  const health = await getJson(`http://localhost:${daemonPort}/health`);
  assert.equal(health.repoId, "joined-repo");
  assert.equal(health.sessionId, "alice-session");

  await waitForState(serverPort, (state) => state.sessions.length === 1);

  const session = runCliJson(["session"], tempRoot);
  assert.deepEqual(session, { sessionId: "alice-session" });

  const report = runCliJson(
    [
      "report",
      "--file",
      filePath,
      "--symbol",
      symbol,
      "--summary",
      "validate now returns Result<Token>"
    ],
    tempRoot
  );
  assert.equal(report.ok, true);
  assert.equal(report.delta.symbolId.raw, symbol);

  const stateWithDelta = await waitForState(
    serverPort,
    (state) => state.unpushedDeltas.length === 1
  );
  assert.equal(stateWithDelta.unpushedDeltas[0].repoId, "joined-repo");
  assert.equal(stateWithDelta.unpushedDeltas[0].sessionId, "alice-session");

  const check = runCliJson(["check", "--file", filePath, "--symbol", symbol], tempRoot);
  assert.equal(check.degraded, false);

  const push = runCliJson(
    ["push", "--file", filePath, "--symbol", symbol, "--sha", "join123"],
    tempRoot
  );
  assert.deepEqual(push, { ok: true, sha: "join123", files: [filePath] });

  const stateAfterPush = await waitForState(
    serverPort,
    (state) => state.unpushedDeltas.length === 0 && state.recentPushes.length === 1
  );
  assert.equal(stateAfterPush.recentPushes[0].repoId, "joined-repo");
  assert.equal(stateAfterPush.recentPushes[0].memberId, "alice");

  const briefing = runCliJson(["whatsup"], tempRoot);
  assert.equal(briefing.repoId, "joined-repo");
  assert.equal(briefing.degraded, false);
  assert.equal(briefing.sessions.length, 1);
  assert.equal(briefing.sessions[0].id, "alice-session");

  console.log("Join config verification passed:");
  console.log(JSON.stringify({ config, health, session, report, check, push, briefing }, null, 2));

  server.kill();
  daemon.kill();
} finally {
  await stopChildren();
  await rm(tempRoot, { recursive: true, force: true });
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, INIT_CWD: cwd },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  return result;
}

function runCliJson(args, cwd) {
  return JSON.parse(runCli(args, cwd).stdout);
}

function startProcess(label, args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
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

async function getJson(url) {
  const response = await fetch(url);
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
  let lastState = null;

  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=joined-repo`).catch(
      () => null
    );
    if (!response?.ok) {
      return false;
    }

    lastState = await response.json();
    return predicate(lastState);
  }, timeoutMs);

  return lastState;
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
