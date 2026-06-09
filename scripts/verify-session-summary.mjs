import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end Layer II: a session makes a contract change, then ends. The daemon
// distills the session's deltas into a durable SessionSummary (deterministic,
// no key) and publishes it; the server stores it and `whatsup` surfaces it.
// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-summary-"));
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#validate";

const base = `
  export interface Token { value: string; }
  export function validate(input: string): boolean { return input.length > 0; }
`;
const changed = base.replace(
  "export function validate(input: string): boolean { return input.length > 0; }",
  "export function validate(input: string): Token { return { value: input }; }"
);

try {
  await writeFixture(aliceRoot, base);

  startProcess("server", ["apps/server/dist/index.js"], { SYNAPSE_SERVER_PORT: String(serverPort) });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startDaemon("alice", alicePort, aliceRoot);
  await waitForHttp(`http://localhost:${alicePort}/health`);
  await waitForState(serverPort, (s) => s.sessions.length === 1);

  // Baseline, then a real contract change → one unpushed delta for the session.
  await report(alicePort);
  await writeFixture(aliceRoot, changed);
  await report(alicePort);
  await waitForState(serverPort, (s) => s.unpushedDeltas.some((d) => d.symbolId.raw === symbol));
  // Ensure the daemon's own warm cache sees the delta before it summarizes.
  await waitForDaemonState(alicePort, (s) => s.unpushedDeltas.some((d) => d.symbolId.raw === symbol));

  // End the session with a task → daemon computes + publishes the summary.
  await postJson(`http://localhost:${alicePort}/tools/synapse_session`, {
    repoId: "local",
    sessionId: "alice",
    action: "end",
    task: "refactor auth validation"
  });

  await waitForState(serverPort, (s) => s.sessionSummaries.length === 1);
  const state = await getServerState();
  const entry = state.sessionSummaries[0];

  assert.equal(entry.sessionId, "alice");
  assert.equal(entry.memberLogin, "alice");
  assert.equal(entry.source, "deterministic", "no key → deterministic summary");
  assert.ok(entry.deltaCount >= 1, "summary counts the session's deltas");
  assert.ok(entry.symbols.some((s) => s.raw === symbol), "summary lists the changed symbol");
  assert.ok(entry.summary.includes("alice"), "summary names the member");
  assert.ok(entry.summary.includes("validate"), "summary names the changed contract");
  assert.ok(entry.summary.includes("refactor auth validation"), "summary carries the task");

  // whatsup surfaces it too.
  const whatsup = await postJson(`http://localhost:${alicePort}/tools/synapse_whatsup`, {
    repoId: "local",
    sessionId: "alice"
  });
  assert.equal(whatsup.sessionSummaries.length, 1, "whatsup includes the session summary");
  assert.ok(
    whatsup.summary.some((line) => line.includes("session summar")),
    "whatsup headline counts summaries"
  );

  console.log("Session summary verification passed:");
  console.log(JSON.stringify(entry, null, 2));
} finally {
  await stopChildren();
  await rm(aliceRoot, { recursive: true, force: true });
}

function startDaemon(member, port, worktreeRoot) {
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
      worktreeRoot
    ],
    {}
  );
}

async function writeFixture(worktreeRoot, source) {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFile(join(worktreeRoot, filePath), `${source.trim()}\n`);
}

async function report(port) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath
  });
}

function getServerState() {
  return fetch(`http://localhost:${serverPort}/state?repoId=local`).then((r) => r.json());
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
    const response = await fetch(`http://localhost:${port}/state?repoId=local`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs);
}

async function waitForDaemonState(port, predicate, timeoutMs = 6000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state`).catch(() => null);
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
