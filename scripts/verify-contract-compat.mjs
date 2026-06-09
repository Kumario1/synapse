import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const worktreeRoot = await mkdtemp(join(tmpdir(), "synapse-contract-compat-"));
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#validate";

try {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFixture(`
    export interface Token {
      value: string;
    }

    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);

  const server = startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = startDaemon("alice", alicePort);
  const bob = startDaemon("bob", bobPort);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2);

  // Baseline snapshot for alice's daemon.
  await report(alicePort);

  // --- Scenario 1: a BREAKING change (return type boolean -> Token | null) ---
  await writeFixture(`
    export interface Token {
      value: string;
    }

    export function validate(input: string): Token | null {
      return input ? { value: input } : null;
    }
  `);
  const breakingReport = await report(alicePort);
  assert.equal(breakingReport.deltas.length, 1);
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  const breakingCheck = await checkFileOnly(bobPort);
  const breakingConflict = breakingCheck.conflicts.find((c) => c.targetSymbol.raw === symbol);
  assert.equal(breakingCheck.verdict, "warn");
  assert.equal(breakingConflict.rule, "same_symbol_unpushed");
  assert.equal(breakingConflict.change.compatibility, "breaking");
  // The actual change is now visible, not just a prose summary.
  assert.equal(breakingConflict.change.before.returns, "boolean");
  assert.equal(breakingConflict.change.after.returns, "Token | null");
  // The deterministic analysis gives actionable, side-addressed steps.
  assert.equal(breakingConflict.analysis.recommendation, "warn");
  assert.ok(breakingConflict.analysis.actions.length >= 1);
  assert.ok(breakingConflict.analysis.actions.some((a) => a.audience === "you"));
  assert.ok(breakingConflict.analysis.actions.some((a) => a.audience === "counterpart"));

  // Alice pushes; live state resets.
  await push(alicePort);
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 0);

  // --- Scenario 2: a BACKWARD-COMPATIBLE change (added optional parameter) ---
  await writeFixture(`
    export interface Token {
      value: string;
    }

    export interface Options {
      strict: boolean;
    }

    export function validate(input: string, opts?: Options): Token | null {
      return input ? { value: input } : null;
    }
  `);
  const compatReport = await report(alicePort);
  assert.ok(compatReport.deltas.length >= 1);
  await waitForState(serverPort, (state) => state.unpushedDeltas.some((d) => d.symbolId.raw === symbol));

  const compatCheck = await checkFileOnly(bobPort);
  // The push leaves a stale_base warning on the same symbol; select the
  // unpushed-delta conflict specifically to inspect its classification.
  const compatConflict = compatCheck.conflicts.find(
    (c) => c.targetSymbol.raw === symbol && c.rule === "same_symbol_unpushed"
  );
  assert.equal(compatConflict.change.compatibility, "compatible");
  // A safe change is demoted below "warn" so it doesn't add to alarm fatigue.
  assert.equal(compatConflict.severity, "info");

  console.log("Contract compatibility verification passed:");
  console.log(
    JSON.stringify(
      {
        breaking: { verdict: breakingCheck.verdict, conflict: breakingConflict },
        compatible: { verdict: compatCheck.verdict, conflict: compatConflict }
      },
      null,
      2
    )
  );

  server.kill();
  alice.kill();
  bob.kill();
} finally {
  await stopChildren();
  await rm(worktreeRoot, { recursive: true, force: true });
}

function startDaemon(member, port) {
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

async function push(port) {
  return postJson(`http://localhost:${port}/tools/synapse_push`, {
    repoId: "local",
    sessionId: "alice",
    sha: "abc123",
    summary: "Pushed auth token changes",
    files: [filePath],
    symbols: [{ raw: symbol }]
  });
}

async function checkFileOnly(port) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [filePath]
  });
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
