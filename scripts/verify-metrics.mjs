import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Observability proof: drive one real report→check→conflict flow, then scrape
// GET /metrics on both processes. The daemon owns the hot path, so check
// latency + verdict + conflict counters live there; the server counts wire
// messages and connections. Hermetic — deterministic path only.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const worktreeRoot = await mkdtemp(join(tmpdir(), "synapse-metrics-"));
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

  for (const [member, port] of [["alice", alicePort], ["bob", bobPort]]) {
    startProcess(member, [
      "apps/cli/dist/index.js",
      "daemon",
      "--member", member,
      "--session", member,
      "--port", String(port),
      "--server", `ws://localhost:${serverPort}`,
      "--worktree-root", worktreeRoot
    ], {});
  }
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2);

  // Baseline snapshot, then a signature change → one delta → bob sees a warn.
  await report(alicePort);
  await writeFixture(`
    export function validate(input: string): { value: string } | null {
      return input ? { value: input } : null;
    }
  `);
  await report(alicePort);
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  const check = await postJson(`http://localhost:${bobPort}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [filePath]
  });
  assert.equal(check.verdict, "warn", "the conflict fired (precondition for the counters)");

  // --- Daemon metrics: verdicts, conflict rules, hot-path latency histogram. ---
  const daemonMetrics = await scrape(`http://localhost:${bobPort}/metrics`);
  assertCounter(daemonMetrics, /synapse_checks_total\{verdict="warn"\} [1-9]/, "warn check counted");
  assertCounter(
    daemonMetrics,
    /synapse_conflicts_total\{rule="same_symbol_unpushed",severity="warn"\} [1-9]/,
    "conflict rule counted"
  );
  assertCounter(
    daemonMetrics,
    /synapse_check_duration_ms_count [1-9]/,
    "check latency histogram observed"
  );

  // --- Alice's daemon counted the report + emitted delta. ---
  const aliceMetrics = await scrape(`http://localhost:${alicePort}/metrics`);
  assertCounter(aliceMetrics, /synapse_reports_total \d+/, "reports counted");
  assertCounter(
    aliceMetrics,
    /synapse_deltas_emitted_total\{changeKind="signature_changed"\} [1-9]/,
    "emitted delta counted"
  );

  // --- Server metrics: connections + wire messages + apply histogram. ---
  const serverMetrics = await scrape(`http://localhost:${serverPort}/metrics`);
  assertCounter(serverMetrics, /synapse_ws_connections_total 2/, "both daemons counted");
  assertCounter(
    serverMetrics,
    /synapse_messages_total\{type="contract\.delta"\} [1-9]/,
    "delta message counted"
  );
  assertCounter(serverMetrics, /synapse_message_apply_ms_count [1-9]/, "apply histogram observed");

  console.log("Metrics verification passed:");
  console.log(
    JSON.stringify(
      {
        daemonSample: daemonMetrics.split("\n").filter((line) => line.includes("synapse_checks_total")),
        serverSample: serverMetrics.split("\n").filter((line) => line.includes("synapse_messages_total"))
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(worktreeRoot, { recursive: true, force: true });
}

function assertCounter(body, pattern, label) {
  assert.match(body, pattern, `${label}: expected ${pattern} in /metrics`);
}

async function scrape(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} responds`);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/, "prometheus text format");
  return response.text();
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
