import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Adaptive severity (F1): the same conflict that warns today is demoted to
// `info` once the team has chronically dismissed its rule (5 dismissals, ≥80%
// dismiss rate, from the explicit synapse_feedback telemetry in shared state).
// Detection itself never changes — the conflict is still reported, just
// quieter. A daemon started with SYNAPSE_ADAPTIVE_SEVERITY=0 keeps warning.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const optOutPort = await freePort();
const worktreeRoot = await mkdtemp(join(tmpdir(), "synapse-adaptive-"));
const filePath = "src/auth/token.ts";

try {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFixture(`
    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);

  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startDaemon("alice", alicePort, {});
  startDaemon("bob", bobPort, {});
  startDaemon("carol", optOutPort, { SYNAPSE_ADAPTIVE_SEVERITY: "0" });
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`),
    waitForHttp(`http://localhost:${optOutPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 3);

  // Alice changes a signature → bob's check warns (same_symbol_unpushed).
  await report(alicePort);
  await writeFixture(`
    export function validate(input: string): { value: string } | null {
      return input ? { value: input } : null;
    }
  `);
  await report(alicePort);
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  const before = await check(bobPort, "bob");
  assert.equal(before.verdict, "warn", "the rule warns before any feedback");
  assert.equal(before.conflicts[0].rule, "same_symbol_unpushed");

  // The team dismisses this warning class five times.
  for (let i = 0; i < 5; i += 1) {
    await postJson(`http://localhost:${bobPort}/tools/synapse_feedback`, {
      conflictId: before.conflicts[0].id,
      outcome: "dismissed",
      rule: "same_symbol_unpushed",
      note: `not relevant to our flow (${i + 1})`
    });
  }
  await waitForState(serverPort, (state) => state.conflictFeedback.length === 5);

  // Same conflict, demoted: still detected and reported, but info now.
  const after = await check(bobPort, "bob");
  assert.equal(after.verdict, "info", "chronically-dismissed rule demoted to info");
  assert.equal(after.conflicts.length, 1, "the conflict is still surfaced (detection untouched)");
  assert.equal(after.conflicts[0].severity, "info");

  // Opt-out daemon (SYNAPSE_ADAPTIVE_SEVERITY=0) still warns on the same state.
  const optOut = await check(optOutPort, "carol");
  assert.equal(optOut.verdict, "warn", "opt-out daemon keeps the warning");

  console.log("Adaptive severity verification passed:");
  console.log(
    JSON.stringify(
      {
        before: before.verdict,
        dismissals: 5,
        after: after.verdict,
        optOut: optOut.verdict
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(worktreeRoot, { recursive: true, force: true });
}

function startDaemon(member, port, env) {
  startProcess(member, [
    "apps/cli/dist/index.js",
    "daemon",
    "--member", member,
    "--session", member,
    "--port", String(port),
    "--server", `ws://localhost:${serverPort}`,
    "--worktree-root", worktreeRoot
  ], env);
}

async function check(port, sessionId) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId,
    files: [filePath]
  });
}

async function writeFixture(source) {
  await writeFile(join(worktreeRoot, filePath), `${source.trim()}\n`);
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
