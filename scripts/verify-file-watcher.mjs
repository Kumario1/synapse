import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// File watcher (M10, spec §1): a manual edit — no agent, no synapse_report
// call — must still produce a contract delta. The daemon watches the worktree;
// the first event for a file records its baseline, the next emits deltas
// through the exact same report path the hooks use. Non-analyzable files are
// ignored, and SYNAPSE_FILE_WATCHER=0 turns the watcher off.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const optOutPort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-watch-alice-"));
const optOutRoot = await mkdtemp(join(tmpdir(), "synapse-watch-optout-"));
const filePath = "src/auth/token.ts";

try {
  await mkdir(join(aliceRoot, "src/auth"), { recursive: true });
  await mkdir(join(optOutRoot, "src/auth"), { recursive: true });

  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startDaemon("alice", alicePort, aliceRoot, "local", {
    SYNAPSE_WATCH_DEBOUNCE_MS: "50"
  });
  startDaemon("optout", optOutPort, optOutRoot, "other", {
    SYNAPSE_WATCH_DEBOUNCE_MS: "50",
    SYNAPSE_FILE_WATCHER: "0"
  });
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${optOutPort}/health`)
  ]);

  // Files created during chokidar's initial scan can be swallowed by
  // ignoreInitial, so wait until the watcher reports ready before writing.
  await waitFor(
    async () => (await metricValue(alicePort, "synapse_watch_ready")) >= 1,
    8000,
    "watcher finished its initial scan"
  );

  // A new file appears (manual `git checkout`, editor save, codegen, …): the
  // watcher reports it, which records the baseline contract snapshot.
  await writeFixture(aliceRoot, `
    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);
  await waitFor(
    async () => (await watchReports(alicePort)) >= 1,
    8000,
    "watcher reported the new file (baseline)"
  );

  // The contract changes with no agent and no synapse_report call…
  await writeFixture(aliceRoot, `
    export function validate(input: string): { value: string } | null {
      return input ? { value: input } : null;
    }
  `);

  // …and the delta still lands in shared team state.
  await waitFor(async () => {
    const state = await getState("local");
    return state.unpushedDeltas.some((d) => d.symbolId.raw === "ts:src/auth/token.ts#validate");
  }, 8000, "manual edit produced a contract delta with no report call");

  const reportsAfterDelta = await watchReports(alicePort);

  // Non-analyzable files are filtered before the report path.
  await writeFile(join(aliceRoot, "README.md"), "# notes\n");
  await delay(600);
  assert.equal(
    await watchReports(alicePort),
    reportsAfterDelta,
    "a non-analyzable file does not trigger a watch report"
  );

  // SYNAPSE_FILE_WATCHER=0: same manual edits, nothing reported.
  await writeFixture(optOutRoot, `
    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);
  await delay(300);
  await writeFixture(optOutRoot, `
    export function validate(input: string): number {
      return input.length;
    }
  `);
  await delay(700);
  assert.equal(await watchReports(optOutPort), 0, "opt-out daemon never watch-reports");
  const otherState = await getState("other");
  assert.equal(otherState.unpushedDeltas.length, 0, "opt-out daemon emitted no deltas");

  console.log("File watcher verification passed:");
  console.log(
    JSON.stringify(
      {
        watchReports: reportsAfterDelta,
        deltaFromManualEdit: "ts:src/auth/token.ts#validate",
        nonAnalyzableIgnored: true,
        optOutInert: true
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(aliceRoot, { recursive: true, force: true });
  await rm(optOutRoot, { recursive: true, force: true });
}

function startDaemon(member, port, worktreeRoot, repoId, env) {
  startProcess(member, [
    "apps/cli/dist/index.js",
    "daemon",
    "--member", member,
    "--session", member,
    "--repo-id", repoId,
    "--port", String(port),
    "--server", `ws://localhost:${serverPort}`,
    "--worktree-root", worktreeRoot
  ], env);
}

async function watchReports(daemonPort) {
  return metricValue(daemonPort, "synapse_watch_reports_total");
}

async function metricValue(daemonPort, name) {
  const response = await fetch(`http://localhost:${daemonPort}/metrics`).catch(() => null);
  if (!response?.ok) {
    return 0;
  }
  const text = await response.text();
  const match = new RegExp(`${name}(?:\\{[^}]*\\})?\\s+(\\d+)`, "u").exec(text);
  return match ? Number(match[1]) : 0;
}

async function getState(repoId) {
  const response = await fetch(
    `http://localhost:${serverPort}/state?repoId=${encodeURIComponent(repoId)}`
  );
  assert.equal(response.ok, true);
  return response.json();
}

async function writeFixture(root, source) {
  await writeFile(join(root, filePath), `${source.trim()}\n`);
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
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs, `reach ${url}`);
}

async function waitFor(predicate, timeoutMs, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
