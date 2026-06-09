import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(rootDir, "apps/cli/dist/index.js");
const children = [];
const token = "up-token";

// The integration proof: two machines run `synapse up` in separate clones of the
// SAME repo, pass no --repo-id, and still land in one coordination room because
// both derive `github.com/acme/widgets` from the git remote — then they see each
// other through the shared server.
const expectedRepoId = "github.com/acme/widgets";

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const demoRoot = await mkdtemp(join(tmpdir(), "synapse-up-"));
const aliceRoot = join(demoRoot, "alice");
const bobRoot = join(demoRoot, "bob");

try {
  await initClone(aliceRoot);
  await initClone(bobRoot);

  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort),
    SYNAPSE_AUTH_TOKEN: token
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startUp("alice", alicePort, aliceRoot);
  startUp("bob", bobPort, bobRoot);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);

  // Both daemons converge in the git-derived room on the server.
  await waitForServerState(expectedRepoId, (state) => state.sessions.length === 2);
  const server = await fetchServerState(expectedRepoId);
  const members = server.sessions.map((s) => s.memberLogin ?? s.memberId).sort();
  assert.deepEqual(members, ["alice", "bob"], "both members joined the git-derived room");

  // And each daemon's local view shows the other — real cross-machine visibility.
  await waitForDaemonState(alicePort, (state) => state.sessions.some((s) => (s.memberLogin ?? s.memberId) === "bob"));
  await waitForDaemonState(bobPort, (state) => state.sessions.some((s) => (s.memberLogin ?? s.memberId) === "alice"));

  console.log("Up verification passed:");
  console.log(JSON.stringify({ derivedRepoId: expectedRepoId, members, mutualVisibility: "ok" }, null, 2));
} finally {
  await stopChildren();
  await rm(demoRoot, { recursive: true, force: true });
}

async function initClone(dir) {
  await execFileAsync("git", ["init", "-q", dir]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "dev@example.com"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Dev"]);
  // The shared remote is what both clones normalize to the same repoId.
  await execFileAsync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/widgets.git"]);
}

function startUp(member, port, worktreeRoot) {
  return startProcess(
    member,
    [
      cli,
      "up",
      "--member",
      member,
      "--port",
      String(port),
      "--server",
      `ws://localhost:${serverPort}`,
      "--token",
      token
    ],
    // INIT_CWD anchors commandCwd() (and the git derivation) at the worktree,
    // overriding the INIT_CWD npm injects when running this script.
    { INIT_CWD: worktreeRoot },
    worktreeRoot
  );
}

function startProcess(label, args, env, cwd = rootDir) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      OPENROUTER_API_KEY: "",
      SYNAPSE_LLM_EXPLAIN: "0",
      SYNAPSE_LLM_RESOLVE: "0"
    },
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

async function fetchServerState(repoId) {
  const url = `http://localhost:${serverPort}/state?repoId=${encodeURIComponent(repoId)}&token=${token}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET /state → ${response.status}`);
  }
  return response.json();
}

async function waitForServerState(repoId, predicate, timeoutMs = 12000) {
  await waitFor(async () => {
    const state = await fetchServerState(repoId).catch(() => null);
    return state ? predicate(state) : false;
  }, timeoutMs);
}

async function waitForDaemonState(port, predicate, timeoutMs = 12000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs);
}

async function waitForHttp(url, timeoutMs = 15000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
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
