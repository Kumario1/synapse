import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end, fully deterministic (no OPENROUTER_API_KEY): two agents edit the
// SAME symbol to incompatible contracts in SEPARATE worktrees, and we assert
// the daemon attaches an escalate resolution (no LLM, no guessed merge).
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-resolution-alice-"));
const bobRoot = await mkdtemp(join(tmpdir(), "synapse-resolution-bob-"));
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#validate";

const base = `
  export interface Token {
    value: string;
  }

  export interface Result<T> {
    value: T;
  }

  export function validate(input: string): boolean {
    return input.length > 0;
  }
`;

// Alice converges on a synchronous Result; Bob on an async Promise. Same symbol,
// incompatible return types → the \`contract_divergent\` rule.
const aliceVersion = base.replace(
  "export function validate(input: string): boolean {\n    return input.length > 0;\n  }",
  "export function validate(input: string): Result<Token> {\n    return { value: { value: input } };\n  }"
);
const bobVersion = base.replace(
  "export function validate(input: string): boolean {\n    return input.length > 0;\n  }",
  "export function validate(input: string): Promise<Token> {\n    return Promise.resolve({ value: input });\n  }"
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
  assert.ok(aliceReport.deltas.some((d) => d.symbolId.raw === symbol), "alice delta on validate");

  await writeFixture(bobRoot, bobVersion);
  const bobReport = await report(bobPort, "bob");
  assert.ok(bobReport.deltas.some((d) => d.symbolId.raw === symbol), "bob delta on validate");

  // Two unpushed deltas on the one symbol are now in shared state.
  await waitForState(
    serverPort,
    (state) => state.unpushedDeltas.filter((d) => d.symbolId.raw === symbol).length === 2
  );

  const check = await checkFileOnly(bobPort);
  const conflict = check.conflicts.find(
    (c) => c.targetSymbol.raw === symbol && c.rule === "contract_divergent"
  );

  assert.ok(conflict, "expected a contract_divergent conflict on validate");
  assert.equal(check.verdict, "warn");

  const resolution = conflict.analysis?.resolution;
  assert.ok(resolution, "expected an attached resolution");

  if (resolution.source === "deterministic") {
    assert.equal(resolution.reconciled, false, "deterministic path escalates, never guesses a merge");
    assert.equal(resolution.recommendation, "block");
    assert.equal(resolution.proposedContract, null);
    // Both sides' afters are surfaced so the agents can agree on one contract.
    assert.ok(resolution.instruction.includes("Result<Token>"), "instruction names Alice's contract");
    assert.ok(resolution.instruction.includes("Promise<Token>"), "instruction names Bob's contract");
  } else if (resolution.reconciled) {
    assert.equal(resolution.recommendation, "warn");
    assert.ok(resolution.proposedContract, "LLM resolver must provide the merged contract");
  } else {
    assert.equal(resolution.recommendation, "block");
    assert.equal(resolution.proposedContract, null);
  }

  assert.ok(resolution.rationale, "resolution explains why it merged or escalated");
  assert.ok(resolution.instruction, "resolution tells both agents what to do next");

  console.log("Resolution verification passed:");
  console.log(JSON.stringify({ verdict: check.verdict, conflict }, null, 2));

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
