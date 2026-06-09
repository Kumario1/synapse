import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end proof that the PYTHON analyzer sidecar drives the full loop the
// same way the TypeScript analyzer does: two agents rewrite the SAME Python
// symbol to incompatible return types in SEPARATE worktrees, and the daemon —
// using tree-sitter contract extraction in the sidecar — detects the
// `contract_divergent` conflict live and attaches a resolution. Fully
// deterministic (no OPENROUTER_API_KEY needed).
// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-py-alice-"));
const bobRoot = await mkdtemp(join(tmpdir(), "synapse-py-bob-"));
const filePath = "src/auth/token.py";
const symbol = "py:src/auth/token.py#validate";

const base = `
class Token:
    value: str

class Result:
    value: str

def validate(input: str) -> bool:
    return len(input) > 0
`;

// Alice converges validate on Result; Bob on Token. Same symbol, incompatible
// return types → the language-neutral \`contract_divergent\` rule, now reached
// from Python contracts.
const aliceVersion = base.replace(
  "def validate(input: str) -> bool:\n    return len(input) > 0",
  "def validate(input: str) -> Result:\n    return Result()"
);
const bobVersion = base.replace(
  "def validate(input: str) -> bool:\n    return len(input) > 0",
  "def validate(input: str) -> Token:\n    return Token()"
);

try {
  await writeFixture(aliceRoot, base);
  await writeFixture(bobRoot, base);

  const server = startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = startDaemon("alice", alicePort, aliceRoot);
  const bob = startDaemon("bob", bobPort, bobRoot);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2);

  // Baseline snapshots so the next report diffs against a common contract.
  await report(alicePort, "alice");
  await report(bobPort, "bob");

  // Each side rewrites validate to its own incompatible contract and reports.
  await writeFixture(aliceRoot, aliceVersion);
  const aliceReport = await report(alicePort, "alice");
  assert.ok(
    aliceReport.deltas.some((d) => d.symbolId.raw === symbol),
    "alice produced a Python contract delta on validate (sidecar extraction worked)"
  );

  await writeFixture(bobRoot, bobVersion);
  const bobReport = await report(bobPort, "bob");
  assert.ok(bobReport.deltas.some((d) => d.symbolId.raw === symbol), "bob delta on validate");

  // Two unpushed Python deltas on the one symbol are now in shared state.
  await waitForState(
    serverPort,
    (state) => state.unpushedDeltas.filter((d) => d.symbolId.raw === symbol).length === 2
  );

  const check = await checkFileOnly(bobPort);
  const conflict = check.conflicts.find(
    (c) => c.targetSymbol.raw === symbol && c.rule === "contract_divergent"
  );

  assert.ok(conflict, "expected a contract_divergent conflict on the Python validate symbol");
  assert.equal(check.verdict, "warn");

  const resolution = conflict.analysis?.resolution;
  assert.ok(resolution, "expected an attached resolution");

  if (resolution.source === "deterministic") {
    assert.equal(resolution.reconciled, false, "deterministic path escalates, never guesses a merge");
    assert.equal(resolution.recommendation, "block");
    // Both sides' Python afters are surfaced so the agents can agree on one.
    assert.ok(resolution.instruction.includes("Result"), "instruction names Alice's contract");
    assert.ok(resolution.instruction.includes("Token"), "instruction names Bob's contract");
  }

  assert.ok(resolution.rationale, "resolution explains why it merged or escalated");
  assert.ok(resolution.instruction, "resolution tells both agents what to do next");

  console.log("Python check verification passed:");
  console.log(
    JSON.stringify(
      {
        verdict: check.verdict,
        symbol,
        rule: conflict.rule,
        change: conflict.change,
        resolution
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
  await rm(aliceRoot, { recursive: true, force: true });
  await rm(bobRoot, { recursive: true, force: true });
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

async function report(port, sessionId) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId,
    filePath
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

async function waitForState(port, predicate, timeoutMs = 8000) {
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
