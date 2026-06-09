import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectKey } from "@synapse/protocol";

// Prove the shippable artifact: build the server image via docker compose, boot
// it with project-key auth, and drive one real edit→report through a local
// daemon pointed at the container — asserting the contract delta lands in the
// container's state. Skipped (exit 0) when docker is unavailable so offline/CI-
// without-docker stays green.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!dockerAvailable()) {
  console.log("Docker verification skipped: `docker compose` is unavailable here.");
  process.exit(0);
}

const project = "synapse-verify-docker";
const masterSecret = "docker-verify-master-secret";
const repoId = "github.com/acme/dockerized";
const key = deriveProjectKey(masterSecret, repoId);
const foreignKey = deriveProjectKey(masterSecret, "github.com/acme/other");

const serverPort = await freePort();
const alicePort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-docker-"));
const filePath = "src/auth/token.ts";
const children = [];

const composeEnv = {
  ...process.env,
  SYNAPSE_SERVER_PORT: String(serverPort),
  SYNAPSE_MASTER_SECRET: masterSecret
};

try {
  console.log(`Building and starting the server image on :${serverPort} (this builds the image)…`);
  runCompose(["up", "-d", "--build", "server"], composeEnv, 600_000);

  await waitForHttp(`http://localhost:${serverPort}/health`, 60_000);

  // The container enforces project-key tenancy: its own repo reads, a foreign
  // key does not.
  const own = await fetch(stateUrl(repoId, key));
  assert.equal(own.status, 200, "containerized server authorizes the project key");
  const foreign = await fetch(stateUrl(repoId, foreignKey));
  assert.equal(foreign.status, 401, "containerized server rejects a foreign key");

  // Drive one edit→report through a local daemon pointed at the container.
  await writeFixture(aliceRoot, "export function validate(input: string): boolean { return !!input; }");
  startDaemon("alice", alicePort, aliceRoot, repoId, key);
  await waitForHttp(`http://localhost:${alicePort}/health`, 10_000);
  await waitForState(repoId, key, (s) => s.sessions.some((session) => session.id === "alice"));

  await report(alicePort);
  await writeFixture(aliceRoot, "export function validate(input: string): string { return input; }");
  await report(alicePort);
  await waitForState(repoId, key, (s) =>
    s.unpushedDeltas.some((d) => d.symbolId.raw === "ts:src/auth/token.ts#validate")
  );

  console.log("Docker verification passed:");
  console.log(
    JSON.stringify({ ownKeyState: 200, foreignKeyState: 401, daemonFlow: "ok" }, null, 2)
  );
} finally {
  await stopChildren();
  await rm(aliceRoot, { recursive: true, force: true });
  // Tear the stack down and drop the durable volume so reruns start clean.
  runCompose(["down", "-v"], composeEnv, 60_000, { ignoreFailure: true });
}

function dockerAvailable() {
  // `docker info` (unlike `docker compose version`) requires a running daemon,
  // so this correctly skips when the CLI is present but the daemon is down.
  const result = spawnSync("docker", ["info"], { stdio: "ignore" });
  return result.status === 0;
}

function runCompose(args, env, timeoutMs, opts = {}) {
  const result = spawnSync("docker", ["compose", "-p", project, ...args], {
    cwd: rootDir,
    env,
    stdio: "inherit",
    timeout: timeoutMs
  });
  if (result.status !== 0 && !opts.ignoreFailure) {
    throw new Error(`docker compose ${args.join(" ")} failed (status ${result.status})`);
  }
}

function stateUrl(repo, k) {
  return `http://localhost:${serverPort}/state?repoId=${encodeURIComponent(repo)}&token=${encodeURIComponent(k)}`;
}

function startDaemon(member, port, worktreeRoot, repo, k) {
  const child = spawn(
    process.execPath,
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      member,
      "--session",
      member,
      "--repo-id",
      repo,
      "--port",
      String(port),
      "--server",
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot,
      "--key",
      k
    ],
    { cwd: rootDir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${member}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${member}] ${chunk}`));
  return child;
}

async function writeFixture(worktreeRoot, source) {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFile(join(worktreeRoot, filePath), `${source}\n`);
}

async function report(port) {
  const response = await fetch(`http://localhost:${port}/tools/synapse_report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoId, sessionId: "alice", filePath })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`report failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForHttp(url, timeoutMs) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function waitForState(repo, k, predicate, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(stateUrl(repo, k)).catch(() => null);
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
    await new Promise((r) => setTimeout(r, 100));
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
